import { CardanoBackend, PaginatingBackend } from './cardano-backend';
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { handleBackendRequest } from '../../utils/backend-request-handler';
import { BackendInitError, NotFoundError, ProviderUnavailableError, normalizeBackendError, submitRejection, nodeRejectionReason, getErrorStatus } from '../../utils/errors';
import { settleInBatches } from '../../utils/collections';
import { callSignal } from './call-signal';
import { normalizeCostModels, decodeAssetName, ledgerView, decodeShelleyAddress } from '../../utils/mappers';
import { validPoolMetadata } from '../pool-metadata';
import { inlineDatumToHex } from '../../utils/tx-build-helper';
import {
  Transaction,
  BlockData,
  Address,
  UTxO,
  NetworkInformation,
  EpochData,
  JSONValue,
  MetadataLabelTx,
  PoolData,
  AccountData,
  DrepData,
  AssetInfo,
  AssetHistoryEntry,
  LedgerProtocolParameters
} from '../../utils/types';
import { Network } from '../cardano-client';

type BlockfrostOptions = ConstructorParameters<typeof BlockFrostAPI>[0];

// The client fails over to the next backend itself, so the SDK does not retry. A retry would run
// past the client's timeout and repeat a request the client has given up.
const NO_RETRY: NonNullable<NonNullable<BlockfrostOptions>['retrySettings']> = {
  limit: 0,
  methods: [],
  statusCodes: [],
  errorCodes: [],
  calculateDelay: () => 0,
};

/** CardanoBackend + PaginatingBackend implementation on the Blockfrost API SDK. */
export class BlockfrostBackend implements CardanoBackend, PaginatingBackend {
  public readonly name = 'blockfrost';
  private api: BlockFrostAPI;
  private network: Network;

  constructor(network: Network, timeoutMs: number, projectId: string, customBackend?: string) {
    if (!projectId && !customBackend) {
      throw new BackendInitError(
        'blockfrost',
        new Error('Either projectId (BLOCKFROST_API_KEY) or customBackend (BLOCKFROST_CUSTOM_BACKEND) is required'),
      );
    }
    // Self-hosted Blockfrost-compatible servers reject an empty project_id header,
    // even without authentication, so a placeholder is sent.
    const effectiveProjectId = projectId || 'self-hosted';
    // the SDK builds its HTTP client in the constructor, so timeout and retries are set here
    this.api = new BlockFrostAPI({
      projectId: effectiveProjectId,
      network,
      requestTimeout: timeoutMs,
      retrySettings: NO_RETRY,
      ...(customBackend ? { customBackend } : {}),
    });
    this.network = network;
  }

  async init(): Promise<boolean> {
    // Test connection by fetching latest block
    try {
      await this.api.blocksLatest();
    } catch (error) {
      throw new BackendInitError('blockfrost', error);
    }
    return true;
  }

  /** Network information (supply, stake). */
  async getNetworkInformation(): Promise<NetworkInformation> {
    return handleBackendRequest(
      async () => {
        const networkInfo = await this.api.network();
        return {
          supply: networkInfo.supply,
          stake: networkInfo.stake,
        };
      },
      this.name
    );
  }

  /** Block by hash (hex). */
  async getBlock(blockHash: string): Promise<BlockData> {
    return handleBackendRequest(
      async () => this.toBlockData(await this.api.blocks(blockHash)),
      this.name
    );
  }

  /** Epoch by number. */
  async getEpoch(epochNumber: number): Promise<EpochData> {
    return handleBackendRequest(
      async () => {
        const epochData = await this.api.epochs(epochNumber);
        return {
          epoch: epochData.epoch,
          start_time: epochData.start_time,
          end_time: epochData.end_time,
          first_block_time: epochData.first_block_time,
          last_block_time: epochData.last_block_time,
          block_count: epochData.block_count,
          tx_count: epochData.tx_count,
          output: epochData.output,
          fees: epochData.fees,
          active_stake: epochData.active_stake,
        };
      },
      this.name
    );
  }

  /** Transaction by hash (hex), with UTxOs and metadata. */
  async getTransaction(hash: string): Promise<Transaction> {
    return handleBackendRequest(
      async () => {
        // independent endpoints, fetched in parallel
        const [tx, txUtxos, txMetadata] = await Promise.all([
          this.api.txs(hash),
          this.api.txsUtxos(hash),
          this.api.txsMetadata(hash),
        ]);

        const metadata = txMetadata.length > 0 ? txMetadata.map(md => ({
          txHash: hash,
          label: md.label,
          json: md.json_metadata as JSONValue | null,
        })) : undefined;

        // ledger view: inputs in ledger order, only what the ledger applied (see ledgerView)
        return ledgerView({
          hash: tx.hash,
          blockHash: tx.block,
          blockHeight: tx.block_height,
          blockTime: tx.block_time,
          slot: tx.slot,
          index: tx.index,
          fee: tx.fees,
          deposit: tx.deposit,
          size: tx.size,
          // `spends === 'collaterals'` in Ogmios terms: the script phase failed, so the
          // ledger applied neither the declared inputs/outputs nor the declared mint.
          spendsCollaterals: tx.valid_contract === false,
          // one mixed list in Blockfrost's order; ledgerView groups and sorts it
          inputs: txUtxos.inputs.map(input => ({
            address: input.address,
            txHash: input.tx_hash,
            outputIndex: input.output_index,
            amount: input.amount,
            dataHash: input.data_hash,
            inlineDatum: inlineDatumToHex(input.inline_datum),
            referenceScriptHash: input.reference_script_hash,
            isCollateral: input.collateral === true,
            isReference: input.reference === true,
          })),
          outputs: txUtxos.outputs.map(output => ({
            address: output.address,
            amount: output.amount,
            txHash: tx.hash,
            outputIndex: output.output_index,
            dataHash: output.data_hash,
            inlineDatum: inlineDatumToHex(output.inline_datum),
            isCollateral: output.collateral,
            referenceScriptHash: output.reference_script_hash,
          })),
          metadata: metadata,
        });
      },
      this.name
    );
  }

  /** Metadata labels of a transaction (hash hex); NotFoundError when it has none. */
  async getTransactionMetadata(tx_hash: string): Promise<MetadataLabelTx[]> {
    return handleBackendRequest(
      async () => {
        const txMetadata = await this.api.txsMetadata(tx_hash);

        if (!txMetadata || txMetadata.length === 0) {
          throw new NotFoundError('Transaction metadata', this.name);
        }

        return txMetadata.map(md => ({
          txHash: tx_hash,
          label: md.label,
          json: md.json_metadata as JSONValue | null,
        }));
      },
      this.name
    );
  }

  /** Address data with UTxOs. Transactions come from getAddressTransactions(). */
  async getAddress(address: string): Promise<Address> {
    return handleBackendRequest(
      async () => {
        const address_data = await this.api.addresses(address);
        // plain addressesUtxos silently stops at 100 entries; the *All variant pages through all of them
        const address_utxos = await this.api.addressesUtxosAll(address);

        return {
          address: address_data.address,
          stakeAddress: address_data.stake_address,
          // Blockfrost says shelley | byron; the other sources and the model use the CIP-19 kind
          type: decodeShelleyAddress(address_data.address).type,
          isScript: address_data.script,
          amount: address_data.amount,
          utxos: address_utxos.map(utxo => ({
            txHash: utxo.tx_hash,
            outputIndex: utxo.output_index,
            address: utxo.address,
            amount: utxo.amount,
            blockHash: utxo.block,
            datumHash: utxo.data_hash,
            scriptRef: utxo.reference_script_hash,
            inlineDatum: inlineDatumToHex(utxo.inline_datum),
          })),
        };
      },
      this.name
    );
  }

  /** Transactions of an address, most recent first, with full details (batched). */
  async getAddressTransactions(address: string, limit?: number): Promise<Transaction[]> {
    return handleBackendRequest(
      async () => {
        // Blockfrost rejects count > 100 with a 400
        const count = limit === undefined ? undefined : Math.min(Math.max(limit, 1), 100);
        const address_txs = await this.api.addressesTransactions(address, { order: 'desc', count });
        const txHashes = address_txs.map(tx => tx.tx_hash);

        // Batch fetch instead of N+1 individual calls
        const batchResult = await this.getTransactionsBatch(txHashes);

        // Preserve original order from address_txs
        const transactions: Transaction[] = [];
        for (const hash of txHashes) {
          const tx = batchResult.get(hash);
          if (tx) transactions.push(tx);
        }
        return transactions;
      },
      this.name
    );
  }

  /** UTxOs of an address. */
  async getAddressUtxos(address: string): Promise<UTxO[]> {
    return handleBackendRequest(
      async () => {
        // *All variant paginates internally (plain addressesUtxos caps at 100 entries)
        const utxo_data = await this.api.addressesUtxosAll(address);
        return utxo_data.map(utxo => ({
          txHash: utxo.tx_hash,
          outputIndex: utxo.output_index,
          address: utxo.address,
          amount: utxo.amount,
          blockHash: utxo.block,
          datumHash: utxo.data_hash,
          scriptRef: utxo.reference_script_hash,
          inlineDatum: inlineDatumToHex(utxo.inline_datum),
        }));
      },
      this.name
    );
  }

  /** Stake pool by id. */
  async getPool(poolId: string): Promise<PoolData> {
    return handleBackendRequest(
      async () => {
        const [poolData, registered] = await Promise.all([this.api.poolsById(poolId), this.api.poolMetadata(poolId)]);
        const metadata = validPoolMetadata(registered);
        return {
          poolId: poolData.pool_id,
          vrfKeyHash: poolData.vrf_key,
          blocksMinted: poolData.blocks_minted,
          blocksEpoch: poolData.blocks_epoch,
          liveStake: poolData.live_stake || '0',
          liveSize: poolData.live_size,
          liveDelegators: poolData.live_delegators,
          // Blockfrost reports saturation as a fraction (0.7542 = 75.42 %), the canonical unit
          liveSaturation: poolData.live_saturation,
          activeStake: poolData.active_stake || '0',
          activeSize: poolData.active_size,
          // the pledge of the certificate, as Koios and Ogmios report it; live_pledge is the owners' stake
          pledge: poolData.declared_pledge || '0',
          margin: poolData.margin_cost,
          fixedCost: poolData.fixed_cost || '0',
          rewardAccount: poolData.reward_account,
          metadataUrl: registered.url ?? null,
          metadataHash: registered.hash ?? null,
          name: metadata?.name ?? null,
          ticker: metadata?.ticker ?? null,
          homepage: metadata?.homepage ?? null,
          description: metadata?.description ?? null,
        }
      },
      this.name
    );
  }

  /** Asset info. Blockfrost has no initial-mint timestamp here, so `initialMintTime` stays null. */
  async getAssetInfo(unit: string): Promise<AssetInfo> {
    return handleBackendRequest(
      async () => {
        const a = await this.api.assetsById(unit);
        const reg = (a as { metadata?: {
          name?: string | null;
          ticker?: string | null;
          decimals?: number | null;
          description?: string | null;
          url?: string | null;
          logo?: string | null;
        } | null }).metadata ?? null;
        const decodeUtf8 = (hex: string | null | undefined): string | null => (hex ? decodeAssetName(hex) : null);

        return {
          unit: a.asset,
          policyId: a.policy_id,
          assetNameHex: a.asset_name ?? '',
          assetName: decodeUtf8(a.asset_name),
          fingerprint: a.fingerprint,
          totalSupply: a.quantity,
          mintOrBurnCount: a.mint_or_burn_count ?? 0,
          initialMintTxHash: a.initial_mint_tx_hash ?? null,
          initialMintTime: null,
          onchainMetadata: (a.onchain_metadata as JSONValue | null) ?? null,
          registryName: reg?.name ?? null,
          registryTicker: reg?.ticker ?? null,
          registryDecimals: typeof reg?.decimals === 'number' ? reg.decimals : null,
          registryDescription: reg?.description ?? null,
          registryUrl: reg?.url ?? null,
          registryLogo: reg?.logo ?? null,
        };
      },
      this.name
    );
  }

  // Mint and burn events, newest first, at most 100 per page. `assetsHistory` has no block data,
  // so one `txs()` call per entry fills blockTime and blockHeight. A failed call leaves them null.
  async getAssetHistory(unit: string, limit: number = 100): Promise<AssetHistoryEntry[]> {
    return handleBackendRequest(
      async () => {
        const count = Math.min(Math.max(1, limit), 100);
        const data = await this.api.assetsHistory(unit, { order: 'desc', count });

        const blockMetaByTx = new Map<string, { blockTime: number | null; blockHeight: number | null }>();
        const results = await settleInBatches(data, BlockfrostBackend.MAX_CONCURRENT, entry => this.api.txs(entry.tx_hash), callSignal());
        data.forEach((entry, idx) => {
          const r = results[idx];
          blockMetaByTx.set(entry.tx_hash, r.status === 'fulfilled'
            ? {
              blockTime: typeof r.value.block_time === 'number' ? r.value.block_time : null,
              blockHeight: typeof r.value.block_height === 'number' ? r.value.block_height : null,
            }
            : { blockTime: null, blockHeight: null });
        });

        return data.map(entry => {
          const meta = blockMetaByTx.get(entry.tx_hash) ?? { blockTime: null, blockHeight: null };
          return {
            unit,
            txHash: entry.tx_hash,
            action: entry.action === 'burned' ? 'burn' : 'mint',
            quantity: entry.amount,
            blockTime: meta.blockTime,
            blockHeight: meta.blockHeight,
          } as AssetHistoryEntry;
        });
      },
      this.name
    );
  }

  /** DRep by id (bech32). */
  async getDrep(drepId: string): Promise<DrepData> {
    return handleBackendRequest(
      async () => {
        const drepData = await this.api.governance.drepsById(drepId);

        return {
          drepId: drepData.drep_id,
          hex: drepData.hex,
          amount: drepData.amount,
          hasScript: drepData.has_script,
          lastActiveEpoch: drepData.last_active_epoch ?? 0,
          expired: drepData.expired,
          retired: drepData.retired,
        };
      },
      this.name
    );
  }

  /** Account by stake address (bech32) with the addresses under it, not their UTxOs. */
  async getAccount(stakeAddress: string): Promise<AccountData> {
    return handleBackendRequest(
      async () => {
        const accountData = await this.api.accounts(stakeAddress);
        // *All variant paginates internally (plain accountsAddresses caps at 100 entries)
        const addresses = (await this.api.accountsAddressesAll(stakeAddress)).map(a => a.address);
        return {
          stakeaddress: accountData.stake_address,
          // `active` is the delegation state; registration lives in `registered`
          active: accountData.registered,
          activeEpoch: accountData.active_epoch ?? 0,
          controlledAmount: accountData.controlled_amount,
          rewardsSum: accountData.rewards_sum,
          withdrawalsSum: accountData.withdrawals_sum,
          reservesSum: accountData.reserves_sum,
          treasurySum: accountData.treasury_sum,
          withdrawableAmount: accountData.withdrawable_amount,
          poolId: accountData.pool_id,
          drepId: accountData.drep_id ?? null,
          addresses: addresses,
        };
      },
      this.name
    );
  }

  /** Submit a signed transaction (CBOR hex); returns the tx hash. */
  async submitTransaction(signedTxCbor: string): Promise<string> {
    const txBytes = Buffer.from(signedTxCbor, "hex");
    return handleBackendRequest(
      async () => {
        try {
          return await this.api.txSubmit(txBytes);
        } catch (err: unknown) {
          // a 400 carries the node's rejection; the submit API forwards it in the body
          if (getErrorStatus(err) === 400) {
            const e = err as { body?: unknown; message?: string };
            throw submitRejection(nodeRejectionReason(e.body ?? e.message ?? ''), this.name, err);
          }
          throw err;
        }
      },
      this.name
    );
  }

  /** Protocol parameters of the latest epoch. */
  async getProtocolParameters(): Promise<LedgerProtocolParameters> {
    return handleBackendRequest(
      async () => {
        const protocolParams = await this.api.epochsLatestParameters();
        return {
          network: this.network,
          epoch: protocolParams.epoch,
          minUtxo: protocolParams.min_utxo,
          nonce: protocolParams.nonce,
          costModels: JSON.stringify(normalizeCostModels(
            (protocolParams as { cost_models_raw?: Record<string, unknown> }).cost_models_raw || {}
          )),
          minFeeA: protocolParams.min_fee_a,
          minFeeB: protocolParams.min_fee_b,
          maxBlockSize: protocolParams.max_block_size,
          priceMem: protocolParams.price_mem,
          priceStep: protocolParams.price_step,
          maxTxExMem: protocolParams.max_tx_ex_mem,
          maxTxExSteps: protocolParams.max_tx_ex_steps,
          maxBlockExMem: protocolParams.max_block_ex_mem,
          maxBlockExSteps: protocolParams.max_block_ex_steps,
          maxValSize: protocolParams.max_val_size,
          collateralPercent: protocolParams.collateral_percent,
          maxCollateralInputs: protocolParams.max_collateral_inputs,
          coinsPerUtxoSize: protocolParams.coins_per_utxo_size,
          minFeeRefScriptCostPerByte: protocolParams.min_fee_ref_script_cost_per_byte ?? null,
          maxBlockHeaderSize: protocolParams.max_block_header_size,
          maxTxSize: protocolParams.max_tx_size,
          keyDeposit: protocolParams.key_deposit,
          minPoolCost: protocolParams.min_pool_cost,
          poolDeposit: protocolParams.pool_deposit,
          eMax: protocolParams.e_max,
          nOpt: protocolParams.n_opt,
          a0: protocolParams.a0,
          rho: protocolParams.rho,
          tau: protocolParams.tau,
          decentralisationParam: protocolParams.decentralisation_param,
          extraEntropy: protocolParams.extra_entropy,
          protocolMajorVer: protocolParams.protocol_major_ver,
          protocolMinorVer: protocolParams.protocol_minor_ver,
          fetchedAt: new Date().toISOString(),
          source: this.name,

        };
      },
      this.name
    );
  }

  /** Latest epoch. */
  async getLatestEpoch(): Promise<EpochData> {
    return handleBackendRequest(
      async () => {
        const epochData = await this.api.epochsLatest();
        return {
          epoch: epochData.epoch,
          start_time: epochData.start_time,
          end_time: epochData.end_time,
          first_block_time: epochData.first_block_time,
          last_block_time: epochData.last_block_time,
          block_count: epochData.block_count,
          tx_count: epochData.tx_count,
          output: epochData.output,
          fees: epochData.fees,
          active_stake: epochData.active_stake,
        };
      },
      this.name
    );
  }

  /** Latest block. */
  async getLatestBlock(): Promise<BlockData> {
    return handleBackendRequest(
      async () => {
        const blockdata = await this.api.blocksLatest();
        return {
          time: blockdata.time,
          height: blockdata.height,
          hash: blockdata.hash,
          slot: blockdata.slot,
          slotLeader: blockdata.slot_leader,
          epoch: blockdata.epoch,
          epochSlot: blockdata.epoch_slot,
          size: blockdata.size,
          txCount: blockdata.tx_count,
          fees: blockdata.fees,
        };
      },
      this.name
    );
  }

  /** Latest chain tip slot; ProviderUnavailableError when the latest block has no slot. */
  async getCurrentSlot(): Promise<number> {
    const block = await this.getLatestBlock();
    if (block.slot == null) {
      throw new ProviderUnavailableError(
        `${this.name}: latest block has no slot`,
        this.name,
      );
    }
    return block.slot;
  }

  /** Whether a UTxO is unspent, via Blockfrost's `consumed_by_tx`; false for unknown tx or out-of-range index. */
  async isUtxoUnspent(txHash: string, outputIndex: number): Promise<boolean> {
    if (!Number.isInteger(outputIndex) || outputIndex < 0) return false;
    try {
      return await handleBackendRequest(
        async () => {
          const utxos = await this.api.txsUtxos(txHash);
          const out = utxos?.outputs?.find(o => o.output_index === outputIndex);
          // consumed_by_tx is always null on a collateral output, so its state is unknown here
          if (!out || (out as { collateral?: boolean }).collateral === true) return false;
          // Blockfrost servers before 0.1.59 omit consumed_by_tx. Without it unspent cannot be
          // proven, so the router must fall through to another backend.
          const consumed = (out as { consumed_by_tx?: string | null }).consumed_by_tx;
          if (consumed === undefined) {
            throw new ProviderUnavailableError(
              `${this.name}: server does not expose consumed_by_tx, cannot determine UTxO status`,
              this.name,
            );
          }
          return consumed === null;
        },
        this.name
      );
    } catch (err) {
      if (err instanceof NotFoundError) return false;
      throw err;
    }
  }

  //-----------------------------------------------------------------------------
  // Batch Methods (N+1 Optimization)
  //-----------------------------------------------------------------------------

  /** Max concurrent Blockfrost API calls (free tier: ~10 req/s) */
  private static readonly MAX_CONCURRENT = 10;

  /** Most recent tx hashes of an address (no details). */
  async getAddressTransactionHashes(address: string, limit: number): Promise<string[]> {
    return handleBackendRequest(
      async () => {
        // Blockfrost rejects count > 100 with a 400
        const count = Math.min(Math.max(limit, 1), 100);
        const txs = await this.api.addressesTransactions(address, { order: 'desc', count });
        return txs.map(tx => tx.tx_hash);
      },
      this.name
    );
  }

  // Transactions by hash, at most MAX_CONCURRENT calls at once. A hash Blockfrost does not know is
  // left out, as Koios does; any other failure fails the batch.
  async getTransactionsBatch(txHashes: string[]): Promise<Map<string, Transaction>> {
    return handleBackendRequest(
      async () => {
        const result = new Map<string, Transaction>();
        const settled = await settleInBatches(txHashes, BlockfrostBackend.MAX_CONCURRENT, h => this.getTransaction(h), callSignal());
        for (const r of settled) {
          if (r.status === 'fulfilled') result.set(r.value.hash, r.value);
          else if (!(r.reason instanceof NotFoundError)) throw r.reason;
        }
        return result;
      },
      this.name
    );
  }

  // ---------------------------------------------------------------------------
  // PaginatingBackend: forward iteration for the chain crawler
  // ---------------------------------------------------------------------------

  /** Map a Blockfrost block summary (blocks()/blocksNext()) to BlockData. */
  private toBlockData(b: {
    time: number; height: number | null; hash: string; slot: number | null;
    slot_leader: string; epoch: number | null; epoch_slot: number | null;
    size: number; tx_count: number; fees?: string | null; previous_block?: string | null;
  }): BlockData {
    return {
      time: b.time,
      height: b.height,
      hash: b.hash,
      slot: b.slot,
      slotLeader: b.slot_leader,
      epoch: b.epoch,
      epochSlot: b.epoch_slot,
      size: b.size,
      txCount: b.tx_count,
      fees: b.fees,
      previousHash: b.previous_block,
    };
  }

  /** Block by height; Blockfrost's `blocks` endpoint accepts a height as well as a hash. */
  async getBlockByHeight(height: number): Promise<BlockData> {
    return handleBackendRequest(
      async () => this.toBlockData(await this.api.blocks(height)),
      this.name
    );
  }

  /** Up to `count` blocks immediately following `afterHash`, in ascending chain order. */
  async getNextBlocks(afterHash: string, count: number): Promise<BlockData[]> {
    return handleBackendRequest(
      async () => {
        let blocks;
        try {
          blocks = await this.api.blocksNext(afterHash, { count });
        } catch (err: unknown) {
          // Blockfrost only knows canonical blocks: a 404 on the anchor means the cursor block was
          // orphaned by a reorg. Signal CHAIN_POINT_MISMATCH so the crawler enters reorg recovery;
          // a plain NotFoundError would count as transient and halt it with an error streak.
          const normalized = normalizeBackendError(err, this.name);
          if (normalized.statusCode === 404) {
            throw new ProviderUnavailableError(
              `CHAIN_POINT_MISMATCH: cursor block ${afterHash} is unknown to ${this.name}, likely orphaned by a reorg`,
              this.name
            );
          }
          throw err;
        }
        return blocks.map(b => this.toBlockData(b));
      },
      this.name
    );
  }

  /** Full transaction list of a block in block order (hashes from blocksTxsAll, details batched). */
  async getBlockTransactions(blockHash: string, txCount?: number): Promise<Transaction[]> {
    return handleBackendRequest(
      async () => {
        if (txCount === 0) return [];
        const hashes = await this.api.blocksTxsAll(blockHash);
        // A short list, or a transaction the batch did not find, would store the block incomplete.
        if (txCount !== undefined && hashes.length !== txCount) {
          throw new ProviderUnavailableError(`Incomplete transaction list for block ${blockHash}: ${hashes.length}/${txCount} transaction(s)`, this.name);
        }
        if (!hashes.length) return [];
        const byHash = await this.getTransactionsBatch(hashes);
        const missing = hashes.filter(h => !byHash.has(h));
        if (missing.length > 0) {
          throw new ProviderUnavailableError(`Incomplete transaction data for block ${blockHash}: ${missing.length}/${hashes.length} transaction(s) missing`, this.name);
        }
        return hashes.map(h => byHash.get(h)!);
      },
      this.name
    );
  }
}