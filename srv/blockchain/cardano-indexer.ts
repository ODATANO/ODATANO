import cds from '@sap/cds';
import type {Transaction as CapTransaction } from '@sap/cds';
import type { CardanoClient } from './cardano-client';
import type { CardanoTransactionBuilder } from './cardano-tx-builder';

import {
  Addresses,
  Transaction as CardanoTransaction,
  AddressAssets,
  AddressUTxOs,
  Transactions,
  TransactionInputs,
  TransactionInputAssets,
  TransactionOutputs,
  TransactionOutputAssets,
  TransactionMetadata,
  NetworkInformation,
  UTxOAssets,
  Block,
  Epoch,
  Accounts,
  Pools,
  Dreps,
  Assets,
  AssetHistory,
  Account,
  Drep,
  Pool,
  Asset,
  Address,
  LedgerProtocolParameter,
  AddressTransactions,
} from '#cds-models/CardanoODataService';

import {
  TransactionBuild,
  TransactionBuilds,
  TransactionBuildInputs,
  TransactionBuildOutputs,
  TransactionSubmission,
  TransactionSubmissions,
  AddressTransactionBuilds,
} from '#cds-models/CardanoTransactionService';

import {
  SigningRequests,
  SignatureVerifications,
  AddressSigningRequests,
} from '#cds-models/CardanoSignService';

import {
  mapTransaction,
  mapTransactionInputs,
  mapTransactionInputAssets,
  mapTransactionOutputs,
  mapTransactionOutputAssets,
  mapAddress,
  mapAddressAssets,
  mapAddressUtxos,
  mapNetworkInfo,
  mapBlock,
  mapEpoch,
  mapAccount,
  mapAsset,
  mapAssetHistory,
  mapDrep,
  mapPool,
  mapTransactionMetadata,
  mapAddressUtxoAssets,
  mapBuildResult,
  mapBuildInputs,
  mapBuildOutputs,
  mapProtocolParameters,
  mapTransactionSubmission,
  mapAddressTransactions,
  mapAddressSigningRequest,
  mapAddressTransactionBuild
} from '../utils/mappers';

import { TxBuildRequest, Transaction as ProviderTransaction, UTxO as OdatanoUtxo, TxBuildResult, BlockData, Amount, TxInputLine } from '../utils/types';
import type { TxCacheTargets } from '../utils/tx-build-helper';

const { UPSERT, INSERT, UPDATE, SELECT, DELETE } = cds.ql;

const logger = cds.log('CardanoIndexer');

/**
 * CardanoIndexer - Indexer for Cardano blockchain data into OData entities
 *
 * Provides methods to index & manage db consistency for various Cardano blockchain data (transactions, addresses, blocks, epochs, accounts, pools, dreps)
 * 1. Fetches data from the configured Cardano data provider via the CardanoClient
 * 2. Maps the provider data into corresponding OData entity rows
 * 3. Upserts the data rows into the database via CAP transactions
 * 4. Ensures referential integrity and consistency across related entities (e.g., addresses in transactions, UTxOs in addresses)
 * 5. Returns the indexed entity data for further processing
 *
 * Each method corresponds to a specific Cardano Entity type and handles the necessary mapping and persistence
 * into the corresponding OData entities defined in the CardanoODataService(M1) and CardanoTransactionService(M2) models.
 */
export class CardanoIndexer {
  private client: CardanoClient;
  private txBuilder: CardanoTransactionBuilder;
  private lastParamsFetchTime = 0;
  /**
   * Crawler epoch memo: epochs change once per ~5 days, but indexBlockFull runs per
   * block — without this, every crawled block paid one client.getEpoch() HTTP call
   * (and on Ogmios-only deployments a guaranteed AllBackendsFailedError round-trip).
   * `row: undefined` is a cached negative so a failing epoch isn't retried per block.
   */
  private crawlEpochCache: { epoch: number; row?: Epoch } | null = null;

  /**
   * Create a new CardanoIndexer instance
   * @param client - The CardanoClient instance for blockchain queries
   * @param txBuilder - The CardanoTransactionBuilder instance for transaction building
   */
  constructor(client: CardanoClient, txBuilder: CardanoTransactionBuilder) {
    this.client = client;
    this.txBuilder = txBuilder;
    logger.info('CardanoIndexer instance created');
  }

  /**
   * Index & return a single transaction with inputs/outputs/assets/UTxOs/addresses
   * All UPSERTs execute within the same CAP transaction (cds.tx), which ensures
   * atomicity: either all entities are persisted or none are (automatic rollback on error).
   * @param tx      CAP transaction (cds.tx(req))
   * @param txHash  Cardano transaction hash (hex)
   * @returns {Promise<CardanoTransaction>} transaction entity data
   */
  async indexTransaction(tx: CapTransaction, txHash: string): Promise<CardanoTransaction> {
    // getting data from cardano data provider
    const providerTx = await this.client.getTransaction(txHash);
    const txRow = mapTransaction(providerTx);

    await tx.run(UPSERT.into(Transactions).entries(txRow))

    logger.debug(`indexTransaction: upserted transaction ${txHash}`);

    if (providerTx.inputs) {
      // Inputs + InputAssets
      const inputRows = mapTransactionInputs(txHash, providerTx.inputs);
      const inputAssetRows = mapTransactionInputAssets(txHash, providerTx.inputs);

      if (inputRows.length) {

        await tx.run(UPSERT.into(TransactionInputs).entries(inputRows))
        logger.debug(`indexTransaction: upserted ${inputRows.length} transaction inputs for ${txHash}`);
      }

      if (inputAssetRows.length) {

        await tx.run(UPSERT.into(TransactionInputAssets).entries(inputAssetRows))
        logger.debug(`indexTransaction: upserted ${inputAssetRows.length} transaction input assets for ${txHash}`);
      }
    }

    // Outputs + OutputAssets — independent of inputs (a tx with empty/missing
    // `inputs` previously skipped its outputs entirely)
    if (providerTx.outputs) {
      const outputRows = mapTransactionOutputs(txHash, providerTx.outputs);
      const outputAssetRows = mapTransactionOutputAssets(txHash, providerTx.outputs);

      if (outputRows.length) {
        await tx.run(UPSERT.into(TransactionOutputs).entries(outputRows))
      }

      if (outputAssetRows.length) {
        await tx.run(UPSERT.into(TransactionOutputAssets).entries(outputAssetRows))
      }
    }
    const metadataRows = mapTransactionMetadata(providerTx.metadata || []);

    if (metadataRows.length) {
      await tx.run(UPSERT.into(TransactionMetadata).entries(metadataRows))
    }
    return txRow;
  }

  /**
   * Index & return address data with assets and UTxOs (without transactions)
   * Transactions are loaded separately via indexAddressTransactions() for better performance
   * @param tx       CAP transaction
   * @param addr     bech32 address
   * @return {Promise<Address>} address entity data
   */
  async indexAddress(tx: CapTransaction, addr: string): Promise<Address> {
    const addrData = await this.client.getAddress(addr);

    logger.debug(`indexAddress: provider response for ${addr}: ${addrData.amount?.length ?? 0} amounts, ${addrData.utxos?.length ?? 0} utxos`);

    const AddrEntity = mapAddress(addr, addrData, this.client.max_age_ms);
    const now = new Date().toISOString();
    const validFrom = AddrEntity.validFrom ?? now;
    const validTo = AddrEntity.validTo ?? now;

    await tx.run(UPSERT.into(Addresses).entries(AddrEntity));

    // Also insert child entities for new address
    // Supplement address-level amounts with assets found in UTxOs but missing from addresses endpoint
    const addressAssetUnits = new Set(addrData.amount.filter(a => a.unit !== 'lovelace').map(a => a.unit));
    for (const utxo of addrData.utxos) {
      for (const amt of utxo.amount) {
        if (amt.unit === 'lovelace' || addressAssetUnits.has(amt.unit)) continue;
        addrData.amount.push(amt);
        addressAssetUnits.add(amt.unit);
      }
    }

    const assetEntities = mapAddressAssets(addr, validFrom, validTo, addrData.amount);

    logger.debug(`indexAddress: ${assetEntities.length} asset entities`);

    if (assetEntities.length > 0) {
      await tx.run(UPSERT.into(AddressAssets).entries(assetEntities));
    }

    // UTxOs are included in getAddress response
    const utxoEntities = mapAddressUtxos(addr, validFrom, validTo, addrData.utxos);

    logger.debug(`indexAddress: ${utxoEntities.length} utxo entities`);

    if (utxoEntities.length) {
      await tx.run(UPSERT.into(AddressUTxOs).entries(utxoEntities));
    }

    const utxoAssetEntities = mapAddressUtxoAssets(addrData.utxos, validFrom, validTo);
    logger.debug(`indexAddress: ${utxoAssetEntities.length} utxo asset entities`);

    if (utxoAssetEntities.length) {
      // Remove possible duplicates before upsert
      const seen = new Set<string>();
      const uniqueAssets = utxoAssetEntities.filter(asset => {
        const key = `${asset.utxo_address_address}|${asset.utxo_hash}|${asset.utxo_index}|${asset.unit}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      logger.debug(`indexAddress: ${utxoAssetEntities.length} assets, ${uniqueAssets.length} unique (removed ${utxoAssetEntities.length - uniqueAssets.length} duplicates)`);
      await tx.run(UPSERT.into(UTxOAssets).entries(uniqueAssets));
    }

    // Always pre-index recent transactions (regardless of asset presence)
    try {
      const txEntities = await this.indexAddressTransactions(tx, addr, 10);
      if (txEntities.length > 0) {
        await tx.run(
          UPDATE.entity(Addresses).set({ hasTransactions: true }).where({ address: addr })
        );
        AddrEntity.hasTransactions = true;
      }
    } catch (err) {
      logger.error(`indexAddressTransactions failed for address ${addr}: ${(err as Error).message}`);
    }

    return AddrEntity;
  }

  /**
   * Index UTxOs by 28-byte payment credential. Always-fresh fetch from Koios
   * (bypasses cache) — credential queries serve dApp-state use cases that require
   * current data. Underlying AddressUTxOs/UTxOAssets rows are UPSERTed and stay
   * available for follow-up address-keyed queries within the TTL.
   *
   * Does NOT upsert parent Addresses rows; child rows reference bech32 addresses
   * that may not yet have a parent stub. Same pattern as TransactionInputs.
   *
   * @param tx       CAP transaction
   * @param credHash 28-byte payment credential as 56-char lowercase hex
   * @return UTxO entity rows across all bech32 addresses sharing the credential
   */
  async indexCredentialUtxos(tx: CapTransaction, credHash: string): Promise<AddressUTxOs[]> {
    const utxos = await this.client.getCredentialUtxos(credHash);

    logger.debug(`indexCredentialUtxos: provider returned ${utxos.length} utxos for credential ${credHash}`);

    if (utxos.length === 0) return [];

    // Group by bech32 address — Koios returns UTxOs across all bech32 forms
    // sharing the credential; mapAddressUtxos keys rows by address parameter.
    const byAddress = new Map<string, OdatanoUtxo[]>();
    for (const u of utxos) {
      const list = byAddress.get(u.address) ?? [];
      list.push(u);
      byAddress.set(u.address, list);
    }

    const validFrom = new Date().toISOString();
    const validTo = new Date(Date.now() + this.client.max_age_ms).toISOString();
    const allRows: AddressUTxOs[] = [];

    for (const [addr, group] of byAddress) {
      const utxoEntities = mapAddressUtxos(addr, validFrom, validTo, group);
      if (utxoEntities.length) {
        await tx.run(UPSERT.into(AddressUTxOs).entries(utxoEntities));
      }

      const utxoAssetEntities = mapAddressUtxoAssets(group, validFrom, validTo);
      if (utxoAssetEntities.length) {
        const seen = new Set<string>();
        const uniqueAssets = utxoAssetEntities.filter(asset => {
          const key = `${asset.utxo_address_address}|${asset.utxo_hash}|${asset.utxo_index}|${asset.unit}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        await tx.run(UPSERT.into(UTxOAssets).entries(uniqueAssets));
      }

      allRows.push(...(utxoEntities as AddressUTxOs[]));
    }

    logger.debug(`indexCredentialUtxos: indexed ${allRows.length} utxos across ${byAddress.size} addresses`);
    return allRows;
  }

  /**
   * Index ONLY the UTxOs at a bech32 address via getAddressUtxos — deliberately
   * WITHOUT a getAddress (address-detail) call, so it works on backends that serve
   * the live UTxO set but not address aggregation (e.g. Ogmios). Used as the
   * GetUTxOsByAddress fallback when no configured backend supports getAddress.
   *
   * Does NOT upsert a parent Addresses row (same pattern as indexCredentialUtxos);
   * AddressUTxOs/UTxOAssets reference the bech32 address directly.
   *
   * @param tx    CAP transaction
   * @param addr  bech32 address
   * @return UTxO entity rows for the address (empty when the address holds none)
   */
  async indexAddressUtxos(tx: CapTransaction, addr: string): Promise<AddressUTxOs[]> {
    const utxos = await this.client.getAddressUtxos(addr);
    logger.debug(`indexAddressUtxos: provider returned ${utxos.length} utxos for ${addr}`);

    const validFrom = new Date().toISOString();
    const validTo = new Date(Date.now() + this.client.max_age_ms).toISOString();

    const utxoEntities = mapAddressUtxos(addr, validFrom, validTo, utxos);
    if (utxoEntities.length) {
      await tx.run(UPSERT.into(AddressUTxOs).entries(utxoEntities));
    }

    const utxoAssetEntities = mapAddressUtxoAssets(utxos, validFrom, validTo);
    if (utxoAssetEntities.length) {
      const seen = new Set<string>();
      const uniqueAssets = utxoAssetEntities.filter(asset => {
        const key = `${asset.utxo_address_address}|${asset.utxo_hash}|${asset.utxo_index}|${asset.unit}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      await tx.run(UPSERT.into(UTxOAssets).entries(uniqueAssets));
    }

    return utxoEntities as AddressUTxOs[];
  }

  /**
   * Evict cached rows a submitted transaction made stale, so the next read
   * refetches instead of serving spent UTxOs for up to indexTtlMs:
   *   - every consumed input ref (spent under WHATEVER address cached it),
   *   - all address-level rows of the output addresses (their UTxO set gained
   *     the new outputs — sender change included) and of `extraAddresses`
   *     (e.g. the build's sender when the CBOR could not be parsed).
   *
   * Only the read cache is touched; submissions/builds stay untouched. Note the
   * next refetch may STILL see pre-submit state on lagging backends
   * (Blockfrost/Koios propagation) — that matches cache-less behaviour and is
   * not recoverable server-side.
   *
   * @param tx             CAP transaction
   * @param targets        input refs + output addresses from extractTxCacheTargets
   * @param extraAddresses additional bech32 addresses to evict
   */
  async invalidateUtxoCacheForTx(
    tx: CapTransaction,
    targets: TxCacheTargets,
    extraAddresses: string[] = []
  ): Promise<void> {
    const addresses = [...new Set([...targets.outputAddresses, ...extraAddresses])];
    for (const address of addresses) {
      await tx.run(DELETE.from(UTxOAssets).where({ utxo_address_address: address }));
      await tx.run(DELETE.from(AddressUTxOs).where({ address_address: address }));
      await tx.run(DELETE.from(AddressAssets).where({ address_address: address }));
      await tx.run(DELETE.from(Addresses).where({ address }));
    }
    for (const input of targets.inputs) {
      await tx.run(DELETE.from(UTxOAssets).where({ utxo_hash: input.txHash, utxo_index: input.outputIndex }));
      await tx.run(DELETE.from(AddressUTxOs).where({ hash: input.txHash, index: input.outputIndex }));
    }
    if (addresses.length || targets.inputs.length) {
      logger.debug(`Invalidated UTxO cache: ${addresses.length} address(es), ${targets.inputs.length} spent input ref(s)`);
    }
  }

  /**
   * Index & return address transactions (separate from indexAddress for lazy loading)
   * @param tx       CAP transaction
   * @param addr     bech32 address
   * @param limit    maximum number of transactions to fetch
   * @return {Promise<AddressTransactions[]>} address transaction entities
   */
  async indexAddressTransactions(tx: CapTransaction, addr: string, limit: number): Promise<AddressTransactions[]> {
    logger.debug(`indexAddressTransactions: fetching transactions for ${addr}`);

    // Layer 4: Hash-only listing (lightweight, 1 API call)
    const txHashes = await this.client.getAddressTransactionHashes(addr, limit);

    logger.debug(`indexAddressTransactions: found ${txHashes.length} tx hashes for ${addr}`);

    if (txHashes.length === 0) return [];

    // Layer 3: DB-first dedup + batch fetch
    const batchFetched = await this.ensureTransactionsIndexed(tx, txHashes);

    // For address-transaction mapping we need full provider tx data (inputs/outputs for net amounts).
    // Transactions already in DB were not re-fetched — batch-fetch those separately.
    const allTxData: ProviderTransaction[] = [];
    const missingFromBatch: string[] = [];

    for (const hash of txHashes) {
      const fromBatch = batchFetched.get(hash);
      if (fromBatch) {
        allTxData.push(fromBatch);
      } else {
        missingFromBatch.push(hash);
      }
    }

    if (missingFromBatch.length > 0) {
      const fetched = await this.client.getTransactionsBatch(missingFromBatch);
      for (const hash of missingFromBatch) {
        const providerTx = fetched.get(hash);
        if (providerTx) allTxData.push(providerTx);
      }
    }

    // Create address-transaction mapping entries (no TTL — keyed by (address, tx),
    // immutable per confirmed tx; the entity has no temporal columns)
    const transactionsEntities = mapAddressTransactions(addr, allTxData);

    logger.debug({ count: transactionsEntities.length }, 'indexAddressTransactions: transaction entities');

    if (transactionsEntities.length) {
      await tx.run(UPSERT.into(AddressTransactions).entries(transactionsEntities));
    }

    // Sort by blockTime descending for consistency with GetLatestTransactionsByAddress
    transactionsEntities.sort((a, b) => (b.blockTime ?? 0) - (a.blockTime ?? 0));
    return transactionsEntities as AddressTransactions[];
  }

  /**
   * Index & return address signing request association
   * Links an address to a signing request for address-based queries
   * @param tx       CAP transaction
   * @param addr     bech32 address
   * @param signingRequestId signing request UUID
   * @return {Promise<void>}
   */
  async indexAddressSigningRequests(tx: CapTransaction, addr: string, signingRequestId: string): Promise<void> {
    logger.debug(`indexAddressSigningRequests: linking address ${addr} to signing request ${signingRequestId}`);

    const addressSigningRequestEntity = mapAddressSigningRequest(addr, signingRequestId);

    await tx.run(UPSERT.into(AddressSigningRequests).entries(addressSigningRequestEntity));

    logger.debug(`indexAddressSigningRequests: linked address ${addr} to signing request ${signingRequestId}`);
  }

  /**
   * Index & return address transaction build association
   * Links an address to a transaction build for address-based queries
   * @param tx       CAP transaction
   * @param addr     bech32 address
   * @param buildId  transaction build UUID
   * @return {Promise<void>}
   */
  async indexAddressTransactionBuilds(tx: CapTransaction, addr: string, buildId: string): Promise<void> {
    logger.debug(`indexAddressTransactionBuilds: linking address ${addr} to build ${buildId}`);

    const addressTransactionBuildEntity = mapAddressTransactionBuild(addr, buildId);

    await tx.run(UPSERT.into(AddressTransactionBuilds).entries(addressTransactionBuildEntity));

    logger.debug(`indexAddressTransactionBuilds: linked address ${addr} to build ${buildId}`);
  }

  /**
   * Index & return metadata for a single transaction (Metadata)
   * @param tx       CAP transaction
   * @param txHash   transaction hash
   * @param metadata raw metadata object (label -> JSONValue)
   * @return {Promise<TransactionMetadata[]>} array of transaction metadata rows  
   */
  async indexTransactionMetadata(tx: CapTransaction, tx_hash: string): Promise<TransactionMetadata[]> {
    const metadata = await this.client.getTransactionMetadata(tx_hash);
    const rows = mapTransactionMetadata(metadata);
    if (rows.length) {
      await tx.run(UPSERT.into(TransactionMetadata).entries(rows))
    }
    return rows;
  }

  /** 
   * Index & return the network information data
   * @param tx CAP transaction object
   * @returns {Promise<NetworkInformation>} network information entity data
   */
  async indexNetworkInformation(tx: CapTransaction): Promise<NetworkInformation> {
    const netInfo = await this.client.getNetworkInformation();
    const netEntity = mapNetworkInfo(netInfo,this.client.max_age_ms,this.client.network);

    await tx.run(UPSERT.into(NetworkInformation).entries(netEntity));
    return netEntity;
  }

  /** 
   * Index & return the block information data
   * @param tx CAP transaction object
   * @param blockHash block hash (hex)
   * @returns {Promise<Block>} block entity data
   */
  async indexBlock(tx: CapTransaction, blockHash: string): Promise<Block> {
    const blockInfo = await this.client.getBlock(blockHash);
    let epoch: Epoch | undefined;
    try {
      epoch = await this.indexEpoch(tx, blockInfo.epoch!);
    } catch {
      // Epoch data may not be available (e.g., Koios drops old/in-progress epochs)
    }
    const blockEntity = mapBlock(blockInfo, epoch);
    await tx.run(UPSERT.into(Block).entries(blockEntity));
    return blockEntity;
  }

  /**
   * Bulk-index a whole block and all of its transactions in ONE pass (chain crawler,
   * v2.0). Unlike indexTransaction()/indexBlock() this does NOT re-fetch per hash — the
   * crawler already carries the block + full tx list from the stream/page. Rows are
   * accumulated across the block's txs and UPSERTed once per table (few statements).
   *
   * All writes run inside the caller's CAP transaction (`tx`), so a block is persisted
   * atomically — a failure mid-block rolls the whole block back, keeping the cursor and
   * the data consistent.
   *
   * Inputs from the Ogmios chain-sync path arrive as bare references (no address/amount);
   * resolveInputs() backfills them from this block's own outputs and previously-indexed
   * outputs before mapping. Blockfrost/Koios inputs already carry address/amount and are
   * left untouched.
   *
   * @param tx        CAP transaction (one per block, committed by the crawler)
   * @param blockData block header/summary from the crawler source
   * @param txs       the block's full transaction list (in block order)
   */
  async indexBlockFull(tx: CapTransaction, blockData: BlockData, txs: ProviderTransaction[]): Promise<void> {
    // Block row — best-effort epoch enrichment, memoized per epoch (NOT per block:
    // an uncached getEpoch here means one backend HTTP call for every crawled block)
    let epoch: Epoch | undefined;
    if (blockData.epoch != null) {
      if (this.crawlEpochCache?.epoch === blockData.epoch) {
        epoch = this.crawlEpochCache.row;
      } else {
        try {
          epoch = await this.indexEpoch(tx, blockData.epoch);
        } catch {
          // epoch data may be unavailable (e.g. Koios drops in-progress/old epochs;
          // Ogmios only serves the current epoch) — cache the miss too
          epoch = undefined;
        }
        this.crawlEpochCache = { epoch: blockData.epoch, row: epoch };
      }
    }
    await tx.run(UPSERT.into(Block).entries(mapBlock(blockData, epoch)));

    // Backfill chain-sync inputs (empty address/amount) from local outputs
    await this.resolveInputs(tx, txs);

    // Accumulate rows across the whole block, then one bulk UPSERT per table
    const txRows = txs.map(t => mapTransaction(t));
    const inputRows = txs.flatMap(t => mapTransactionInputs(t.hash, t.inputs ?? []));
    const inputAssetRows = txs.flatMap(t => mapTransactionInputAssets(t.hash, t.inputs ?? []));
    const outputRows = txs.flatMap(t => mapTransactionOutputs(t.hash, t.outputs ?? []));
    const outputAssetRows = txs.flatMap(t => mapTransactionOutputAssets(t.hash, t.outputs ?? []));
    const metadataRows = txs.flatMap(t => mapTransactionMetadata(t.metadata ?? []));

    if (txRows.length) await tx.run(UPSERT.into(Transactions).entries(txRows));
    if (inputRows.length) await tx.run(UPSERT.into(TransactionInputs).entries(inputRows));
    if (inputAssetRows.length) await tx.run(UPSERT.into(TransactionInputAssets).entries(inputAssetRows));
    if (outputRows.length) await tx.run(UPSERT.into(TransactionOutputs).entries(outputRows));
    if (outputAssetRows.length) await tx.run(UPSERT.into(TransactionOutputAssets).entries(outputAssetRows));
    if (metadataRows.length) await tx.run(UPSERT.into(TransactionMetadata).entries(metadataRows));

    logger.debug(`indexBlockFull: block ${blockData.hash} — ${txs.length} txs, ${outputRows.length} outputs`);
  }

  /**
   * Backfill input address/amount for chain-sync transactions whose inputs are bare
   * references. Resolves first from this block's own outputs (a tx may spend an earlier
   * tx's output in the same block), then batch-reads previously-indexed outputs from the
   * DB. Inputs that already carry an address (Blockfrost/Koios) are skipped.
   */
  private async resolveInputs(tx: CapTransaction, txs: ProviderTransaction[]): Promise<void> {
    // 1. In-memory index of this block's outputs (txHash#outputIndex -> {address, amount})
    const blockOutputs = new Map<string, { address: string; amount: Amount[] }>();
    for (const t of txs) {
      for (const o of t.outputs ?? []) {
        blockOutputs.set(`${t.hash}#${o.outputIndex}`, { address: o.address, amount: o.amount ?? [] });
      }
    }

    // 2. Collect inputs still needing resolution after the same-block pass
    const unresolved: { input: TxInputLine; key: string }[] = [];
    for (const t of txs) {
      for (const input of t.inputs ?? []) {
        if (input.address) continue; // already resolved by the backend (Blockfrost/Koios)
        const key = `${input.txHash}#${input.outputIndex}`;
        const local = blockOutputs.get(key);
        if (local) {
          input.address = local.address;
          input.amount = local.amount;
        } else {
          unresolved.push({ input, key });
        }
      }
    }
    if (!unresolved.length) return;

    // 3. Batch-read prior-block outputs from the DB
    const sourceHashes = [...new Set(unresolved.map(u => u.key.split('#')[0]))];
    const [outRows, assetRows] = await Promise.all([
      tx.run(SELECT.from(TransactionOutputs).where({ tx_hash: { in: sourceHashes } })),
      tx.run(SELECT.from(TransactionOutputAssets).where({ output_tx_hash: { in: sourceHashes } })),
    ]);

    const addrByKey = new Map<string, string>();
    for (const r of outRows as Array<{ tx_hash: string; outputIndex: number; address_address: string }>) {
      addrByKey.set(`${r.tx_hash}#${r.outputIndex}`, r.address_address);
    }
    const amtByKey = new Map<string, Amount[]>();
    for (const r of assetRows as Array<{ output_tx_hash: string; output_outputIndex: number; unit: string; asset_quantity: unknown }>) {
      const k = `${r.output_tx_hash}#${r.output_outputIndex}`;
      const list = amtByKey.get(k) ?? [];
      list.push({ unit: r.unit, quantity: String(r.asset_quantity) });
      amtByKey.set(k, list);
    }

    for (const { input, key } of unresolved) {
      const addr = addrByKey.get(key);
      if (addr != null) input.address = addr;
      const amt = amtByKey.get(key);
      if (amt) input.amount = amt;
    }
  }

  /** 
   * Index & return the epoch information data
   * @param tx CAP transaction object
   * @param epochNumber epoch number
   * @returns {Promise<Epoch>} epoch entity data
   */
  async indexEpoch(tx: CapTransaction, epochNumber: number): Promise<Epoch> {
    const epochInfo = await this.client.getEpoch(epochNumber);
    const epochEntity = mapEpoch(epochInfo);

    await tx.run(UPSERT.into(Epoch).entries([epochEntity]))
    return epochEntity;
  }

  /** 
   * Index & return the account information data
   * @param tx CAP transaction object
   * @param stakeAddress stake address (bech32)
   * @returns {Promise<Account>} account entity data
  */
  async indexAccount(tx: CapTransaction, stakeAddress: string): Promise<Account> {
    const accountInfo = await this.client.getAccount(stakeAddress);
    const accountEntity = mapAccount(accountInfo, this.client.max_age_ms);

    await tx.run(UPSERT.into(Accounts).entries(accountEntity))

    const addresses = accountInfo.addresses.map(a => a.address);

    if (accountEntity.hasAddresses) {
      await this._ensureAddresses(tx, addresses);
    }

    return accountEntity;
  }

  /** 
   * Index & return the drep information data
   * @param tx CAP transaction object
   * @param drepId drep id (bech32)
   * @returns {Promise<Drep>} drep entity data
   */
  async indexDrep(tx: CapTransaction, drepId: string): Promise<Drep> {
    const drepInfo = await this.client.getDrep(drepId);
    const drepEntity = mapDrep(drepInfo, this.client.max_age_ms);
    await tx.run(UPSERT.into(Dreps).entries(drepEntity));
    return drepEntity;
  }

  /**
   * Index & return the pool information data
   * @param tx CAP transaction object
   * @param poolId pool id (hex)
   * @returns {Promise<Pool>} pool entity data
   */
  async indexPool(tx: CapTransaction, poolId: string): Promise<Pool> {
    const poolInfo = await this.client.getPool(poolId);
    const poolEntity = mapPool(poolInfo, this.client.max_age_ms);

    await tx.run(UPSERT.into(Pools).entries(poolEntity))

    return poolEntity;
  }

  /**
   * Index & return the asset information data
   * @param tx CAP transaction object
   * @param unit asset unit (policyId + assetNameHex)
   * @returns {Promise<Asset>} asset entity data
   */
  async indexAsset(tx: CapTransaction, unit: string): Promise<Asset> {
    const assetInfo = await this.client.getAssetInfo(unit);
    const assetEntity = mapAsset(assetInfo, this.client.max_age_ms);

    await tx.run(UPSERT.into(Assets).entries(assetEntity));

    return assetEntity;
  }

  /**
   * Index & return mint/burn history for an asset. Always-fresh from the
   * preferred backend (Koios for block timestamps, Blockfrost as fallback).
   * UPSERTs entries by (unit, txHash) — events are immutable, so re-fetching
   * just refreshes the cap of recent entries; older cached entries persist.
   * @param tx CAP transaction object
   * @param unit asset unit (policyId + assetNameHex)
   * @param limit max number of recent events to fetch (default 100)
   * @returns {Promise<AssetHistory[]>} list of mint/burn event entity rows
   */
  async indexAssetHistory(tx: CapTransaction, unit: string, limit: number = 100): Promise<AssetHistory[]> {
    const events = await this.client.getAssetHistory(unit, limit);
    if (events.length === 0) return [];

    const rows = mapAssetHistory(events);
    await tx.run(UPSERT.into(AssetHistory).entries(rows));
    return rows as AssetHistory[];
  }

  /**
   * Common method: build a transaction, persist build result with inputs/outputs/address associations.
   * All four public indexBuild*Result methods delegate to this to eliminate duplication.
   * @param tx      CAP transaction object
   * @param buildreq transaction build request data
   * @param buildFn  the specific builder method to call
   * @returns {Promise<TransactionBuild>} transaction build entity data
   */
  private async _indexBuildResult(
    tx: CapTransaction,
    buildreq: TxBuildRequest,
    buildFn: (req: TxBuildRequest, params: LedgerProtocolParameter) => Promise<TxBuildResult>
  ): Promise<TransactionBuild> {
    const protocolParams = await this.indexProtocolParameters(tx);
    const txbuildResult = await buildFn(buildreq, protocolParams);
    const buildResult = mapBuildResult(txbuildResult, this.client.max_age_ms);

    await tx.run(UPSERT.into(TransactionBuild).entries(buildResult));

    if (buildResult.id && txbuildResult.inputs && txbuildResult.inputs.length > 0) {
      const inputRows = mapBuildInputs(buildResult.id, txbuildResult.inputs);
      await tx.run(UPSERT.into(TransactionBuildInputs).entries(inputRows));
    }

    if (buildResult.id && txbuildResult.outputs && txbuildResult.outputs.length > 0) {
      const outputRows = mapBuildOutputs(buildResult.id, txbuildResult.outputs, buildreq.changeAddress || buildreq.senderAddress);
      await tx.run(UPSERT.into(TransactionBuildOutputs).entries(outputRows));
    }

    if (buildResult.id && buildreq.senderAddress) {
      await this.indexAddressTransactionBuilds(tx, buildreq.senderAddress, buildResult.id);
    }

    return buildResult;
  }

  async indexSimpleBuildResult(tx: CapTransaction, buildreq: TxBuildRequest): Promise<TransactionBuild> {
    return this._indexBuildResult(tx, buildreq, (req, params) => this.txBuilder.buildSimpleAdaTransaction(req, params));
  }

  async indexMetadataBuildResult(tx: CapTransaction, buildreq: TxBuildRequest): Promise<TransactionBuild> {
    return this._indexBuildResult(tx, buildreq, (req, params) => this.txBuilder.buildTransactionWithMetadata(req, params));
  }

  async indexMultiAssetBuildResult(tx: CapTransaction, buildreq: TxBuildRequest): Promise<TransactionBuild> {
    return this._indexBuildResult(tx, buildreq, (req, params) => this.txBuilder.buildMultiAssetTransaction(req, params));
  }

  async indexMintBuildResult(tx: CapTransaction, buildreq: TxBuildRequest): Promise<TransactionBuild> {
    return this._indexBuildResult(tx, buildreq, (req, params) => this.txBuilder.buildMintTransaction(req, params));
  }

  async indexPlutusSpendBuildResult(tx: CapTransaction, buildreq: TxBuildRequest): Promise<TransactionBuild> {
    return this._indexBuildResult(tx, buildreq, (req, params) => this.txBuilder.buildPlutusSpendTransaction(req, params));
  }

  /**
   * Index & return the protocol parameters data
   * @param tx CAP transaction object
   * @returns {Promise<LedgerProtocolParameter>} protocol parameters entity data
   */
  async indexProtocolParameters(tx: CapTransaction): Promise<LedgerProtocolParameter> {
    const network = this.client.network;
    const now = Date.now();

    // Return cached DB row if within TTL (protocol params only change at epoch boundaries ~5 days)
    const PROTOCOL_PARAMS_TTL_MS = 5 * 60 * 1000; // 5 minutes — matches client cache TTL
    if (now - this.lastParamsFetchTime < PROTOCOL_PARAMS_TTL_MS) {
      // (network, epoch) is the composite key — old epochs accumulate as rows, so
      // order by epoch desc to return the LATEST instead of an arbitrary row.
      const existing = await tx.run(
        SELECT.one.from(LedgerProtocolParameter).where({ network }).orderBy('epoch desc')
      );
      if (existing) return existing;
    }

    // Fetch from provider (client has 5-min in-memory TTL cache, so this is cheap)
    const protocolParamsInfo = await this.client.getProtocolParameters();
    const protocolParams = mapProtocolParameters(protocolParamsInfo);
    await tx.run(UPSERT.into(LedgerProtocolParameter).entries(protocolParams));
    this.lastParamsFetchTime = now;

    return protocolParams;
  }

  /**
   * Persist a transaction submission with optional build association
   * Handles: TransactionSubmission insert, optional Build status update
   * @param tx CAP transaction object
   * @param params submission parameters
   * @returns {Promise<TransactionSubmission>} persisted transaction submission entity
   */
  async persistTransactionSubmission(
    tx: CapTransaction,
    params: {
      signedTxCbor: string;
      txHash: string;
      buildId?: string | null;
    }
  ): Promise<TransactionSubmission> {
    const { signedTxCbor, txHash, buildId } = params;

    // Map submission data
    const indexSubmission = mapTransactionSubmission(signedTxCbor, txHash);

    // Create submission record (status: 'pending' — updated to 'submitted' after blockchain confirms)
    const submissionRecord = {
      ...indexSubmission,
      build_id: buildId || null,
      backendResponse: 'Submitted successfully',
      status: 'pending' as const,
    };

    // Persist submission
    await tx.run(INSERT.into(TransactionSubmissions).entries(submissionRecord));
    logger.debug({ submissionId: submissionRecord.id, txHash }, 'Persisted submission record');

    // Update build status if buildId provided
    if (buildId) {
      await tx.run(
        UPDATE.entity(TransactionBuilds)
          .set({ wasSubmitted: true })
          .where({ id: buildId })
      );
      logger.debug({ buildId }, 'Updated build wasSubmitted flag');
    }

    return submissionRecord;
  }

  /**
   * Update the status of a transaction submission
   * Used for the two-phase submit flow: pending → submitted (or failed)
   * @param tx CAP transaction object
   * @param submissionId the submission to update
   * @param status new status value
   * @param errorMessage optional error message for failed status
   */
  async updateSubmissionStatus(
    tx: CapTransaction,
    submissionId: string,
    status: string,
    errorMessage?: string
  ): Promise<void> {
    const updateData: Record<string, any> = { status };
    if (errorMessage) {
      updateData.errorMessage = errorMessage;
    }
    await tx.run(
      UPDATE.entity(TransactionSubmissions)
        .set(updateData)
        .where({ id: submissionId })
    );
    logger.debug({ submissionId, status }, 'Updated submission status');
  }

  /**
   * Persist a new signing request
   * @param tx CAP transaction object
   * @param params signing request parameters from external signer module
   * @returns persisted signing request record
   */
  async persistSigningRequest(
    tx: CapTransaction,
    params: {
      buildId: string;
      signingPayload: {
        signingRequestId: string;
        txBodyHash: string;
        unsignedTxCbor: string;
        network: string;
        createdAt: string;
        expiresAt: string;
        signingInstructions: {
          cardanoCliCommand?: string;
          cip30SigningRequest?: { txCbor: string };
        };
      };
    }
  ) {
    const { buildId, signingPayload } = params;

    // Create signing request record
    const signingRequestRecord = {
      id: signingPayload.signingRequestId,
      build_id: buildId,
      txBodyHash: signingPayload.txBodyHash,
      unsignedTxCbor: signingPayload.unsignedTxCbor,
      network: signingPayload.network,
      status: 'pending' as const,
      createdAt: signingPayload.createdAt,
      expiresAt: signingPayload.expiresAt,
      cardanoCliCommand: signingPayload.signingInstructions.cardanoCliCommand,
      cip30TxCbor: signingPayload.signingInstructions.cip30SigningRequest?.txCbor,
    };

    // Persist to database
    await tx.run(INSERT.into(SigningRequests).entries(signingRequestRecord));
    logger.debug({ signingRequestId: signingRequestRecord.id, buildId }, 'Persisted signing request');

    // Index address-signing request association
    const build = await tx.run(SELECT.one.from(TransactionBuilds).where({ id: buildId }));
    if (build?.senderAddress) {
      await this.indexAddressSigningRequests(tx, build.senderAddress, signingRequestRecord.id);
    }

    return signingRequestRecord;
  }

  /**
   * Persist a signature verification with signing request status update
   * Handles: SignatureVerification insert, SigningRequest status update
   * @param tx CAP transaction object
   * @param params verification parameters
   * @returns persisted signature verification record
   */
  async persistSignatureVerification(
    tx: CapTransaction,
    params: {
      signingRequestId: string;
      signedTxCbor: string;
      verificationResult: {
        isValid: boolean;
        txBodyHash: string;
        witnessCount: number;
        signerKeyHashes: string[];
        errorMessage?: string | null;
        warnings: string[];
      };
      signerType?: string;
      signerInfo?: string;
    }
  ) {
    const { signingRequestId, signedTxCbor, verificationResult, signerType, signerInfo } = params;

    // Create verification record
    const verificationRecord = {
      id: cds.utils.uuid(),
      signingRequest_id: signingRequestId,
      signedTxCbor: signedTxCbor,
      isValid: verificationResult.isValid,
      txBodyHash: verificationResult.txBodyHash,
      witnessCount: verificationResult.witnessCount,
      signerKeyHashes: JSON.stringify(verificationResult.signerKeyHashes),
      errorMessage: verificationResult.errorMessage || null,
      warnings: JSON.stringify(verificationResult.warnings),
      verifiedAt: new Date().toISOString(),
    };

    // Persist verification
    await tx.run(INSERT.into(SignatureVerifications).entries(verificationRecord));
    logger.debug({ verificationId: verificationRecord.id }, 'Persisted signature verification record');

    // Update signing request status
    const newStatus = verificationResult.isValid ? 'verified' : 'failed';
    await tx.run(
      UPDATE.entity(SigningRequests)
        .set({
          status: newStatus,
          signerType: signerType || 'custom',
          signerInfo: signerInfo || null,
          signedAt: verificationResult.isValid ? new Date().toISOString() : null,
          errorMessage: verificationResult.isValid ? null : verificationResult.errorMessage,
        })
        .where({ id: signingRequestId })
    );
    logger.debug({ signingRequestId, newStatus }, 'Updated signing request status');

    return verificationRecord;
  }

  /**
   * Index a verified transaction submission with all related records
   * Handles persistence of: SignatureVerification, TransactionSubmission, SigningRequest update, Build update
   * @param tx CAP transaction object
   * @param params submission parameters
   * @returns {Promise<TransactionSubmission>} transaction submission entity data
   */
  async indexVerifiedTransactionSubmission(
    tx: CapTransaction,
    params: {
      signingRequestId: string;
      buildId: string;
      fullSignedTxCbor: string;
      txHash: string;
      verificationResult: {
        txBodyHash: string;
        witnessCount: number;
        signerKeyHashes: string[];
        warnings: string[];
      };
      signerType?: string;
      signerInfo?: string;
    }
  ): Promise<TransactionSubmission> {
    const { signingRequestId, buildId, fullSignedTxCbor, txHash, verificationResult, signerType, signerInfo } = params;

    // Step 1: Create and persist verification record
    const verificationRecord = {
      id: cds.utils.uuid(),
      signingRequest_id: signingRequestId,
      signedTxCbor: fullSignedTxCbor,
      isValid: true,
      txBodyHash: verificationResult.txBodyHash,
      witnessCount: verificationResult.witnessCount,
      signerKeyHashes: JSON.stringify(verificationResult.signerKeyHashes),
      errorMessage: null,
      warnings: JSON.stringify(verificationResult.warnings),
      verifiedAt: new Date().toISOString(),
    };
    await tx.run(INSERT.into(SignatureVerifications).entries(verificationRecord));
    logger.debug({ verificationId: verificationRecord.id }, 'Persisted signature verification record');

    // Step 2: Create and persist submission record
    const indexSubmission = mapTransactionSubmission(fullSignedTxCbor, txHash);
    const submissionRecord = {
      ...indexSubmission,
      build_id: buildId,
      backendResponse: `Submitted successfully (verified: ${verificationResult.witnessCount} witness(es))`,
      status: 'submitted' as const,
    };
    await tx.run(INSERT.into(TransactionSubmissions).entries(submissionRecord));
    logger.debug({ submissionId: submissionRecord.id }, 'Persisted submission record');

    // Step 3: Update signing request metadata and status
    const now = new Date().toISOString();
    await tx.run(
      UPDATE.entity(SigningRequests)
        .set({
          status: 'submitted',
          signerType: signerType || 'custom',
          signerInfo: signerInfo || null,
          signedAt: now,
          submittedAt: now,
          submission_id: submissionRecord.id,
        })
        .where({ id: signingRequestId })
    );
    logger.debug({ signingRequestId }, 'Updated signing request status to submitted');

    // Step 4: Update build status
    await tx.run(
      UPDATE.entity(TransactionBuilds)
        .set({ wasSubmitted: true })
        .where({ id: buildId })
    );
    logger.debug({ buildId }, 'Updated build wasSubmitted flag');

    return submissionRecord;
  }

  /** 
   * Index & return the latest epoch information data
   * @param tx CAP transaction object
   * @returns {Promise<Epoch>} epoch entity data
   */
  async indexLatestEpoch(tx: CapTransaction): Promise<Epoch> {
    const epochInfo = await this.client.getLatestEpoch();

    const epochEntity = mapEpoch(epochInfo);


    await tx.run(UPSERT.into(Epoch).entries([epochEntity]))
    return epochEntity;
  }

  /** 
   * Index & return the latest block information data
   * @param tx CAP transaction object
   * @returns {Promise<Block>} block entity data
   */
  async indexLatestBlock(tx: CapTransaction): Promise<Block> {

    const blockInfo = await this.client.getLatestBlock();
    let epoch: Epoch | undefined;
    try {
      epoch = await this.indexEpoch(tx, blockInfo.epoch!);
    } catch {
      // Epoch data may not be available (e.g., Koios drops old/in-progress epochs)
    }
    const blockEntity = mapBlock(blockInfo, epoch);

    await tx.run(UPSERT.into(Block).entries(blockEntity));
    return blockEntity;
  }

  //-----------------------------------------------------------------------------
  // Batch Methods (N+1 Optimization)
  //-----------------------------------------------------------------------------

  /** Max addresses to index concurrently (avoid overloading backends) */
  private static readonly ADDR_CONCURRENCY = 5;

  /**
   * Ensure a set of transactions are indexed — batch DB-check + batch fetch.
   * 1. Deduplicate hashes
   * 2. Check which hashes already exist in DB
   * 3. Batch-fetch missing transactions from backend
   * 4. UPSERT all entities (Transactions, Inputs, Outputs, Assets, Metadata)
   *
   * @param tx       CAP transaction (cds.tx)
   * @param txHashes array of transaction hashes to ensure
   * @returns Map of txHash → provider Transaction (all requested, from DB fetch or backend)
   */
  async ensureTransactionsIndexed(
    tx: CapTransaction,
    txHashes: string[]
  ): Promise<Map<string, ProviderTransaction>> {
    const unique = [...new Set(txHashes)];
    if (unique.length === 0) return new Map();

    // DB check — which hashes are already indexed?
    const existingRows = await tx.run(
      SELECT.from(Transactions).columns('hash').where({ hash: { in: unique } })
    );
    const existingSet = new Set((existingRows as Array<{ hash: string }>).map((r) => r.hash));
    const missing = unique.filter(h => !existingSet.has(h));

    logger.debug(`ensureTransactionsIndexed: ${unique.length} unique, ${existingSet.size} cached, ${missing.length} to fetch`);

    // Batch-fetch missing from backend
    let fetched = new Map<string, ProviderTransaction>();
    if (missing.length > 0) {
      fetched = await this.client.getTransactionsBatch(missing);

      // UPSERT all fetched transactions + child entities
      for (const [, providerTx] of fetched) {
        const txRow = mapTransaction(providerTx);
        await tx.run(UPSERT.into(Transactions).entries(txRow));

        if (providerTx.inputs) {
          const inputRows = mapTransactionInputs(providerTx.hash, providerTx.inputs);
          const inputAssetRows = mapTransactionInputAssets(providerTx.hash, providerTx.inputs);
          if (inputRows.length) await tx.run(UPSERT.into(TransactionInputs).entries(inputRows));
          if (inputAssetRows.length) await tx.run(UPSERT.into(TransactionInputAssets).entries(inputAssetRows));
        }

        // outputs independent of inputs (see indexTransaction)
        if (providerTx.outputs) {
          const outputRows = mapTransactionOutputs(providerTx.hash, providerTx.outputs);
          const outputAssetRows = mapTransactionOutputAssets(providerTx.hash, providerTx.outputs);
          if (outputRows.length) await tx.run(UPSERT.into(TransactionOutputs).entries(outputRows));
          if (outputAssetRows.length) await tx.run(UPSERT.into(TransactionOutputAssets).entries(outputAssetRows));
        }

        const metadataRows = mapTransactionMetadata(providerTx.metadata || []);
        if (metadataRows.length) await tx.run(UPSERT.into(TransactionMetadata).entries(metadataRows));
      }
    }

    return fetched;
  }

  //-----------------------------------------------------------------------------
  // Private Helpers
  //-----------------------------------------------------------------------------

  /**
   * Index multiple addresses with concurrency-limited parallelism.
   * Processes addresses in chunks to avoid overwhelming backends.
   * @param tx CAP transaction object
   * @param bech32List array of bech32 addresses
   */
  private async _ensureAddresses(
    tx: CapTransaction,
    bech32List: string[]
  ): Promise<void> {
    const concurrency = CardanoIndexer.ADDR_CONCURRENCY;
    for (let i = 0; i < bech32List.length; i += concurrency) {
      const chunk = bech32List.slice(i, i + concurrency);
      await Promise.all(chunk.map(addr => this.indexAddress(tx, addr)));
    }
  }
}
