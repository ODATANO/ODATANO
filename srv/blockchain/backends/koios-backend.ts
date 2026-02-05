import axios, { AxiosInstance } from 'axios';
import { CardanoBackend } from './cardano-backend';
import { handleBackendRequest } from '../../utils/backend-request-handler';
import { BackendInitError, NotFoundError } from '../../utils/errors';
import { CARDANO_DEFAULTS } from '../../utils/const';

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
  DrepData,
  AccountData,
  Amount,
  LedgerProtocolParameters
} from '../../utils/types';
import { Network } from '../cardano-client';

const KOIOS_URLS: Record<Network, string> = {
  mainnet: 'https://api.koios.rest/api/v1',
  preview: 'https://preview.koios.rest/api/v1',
  preprod: 'https://preprod.koios.rest/api/v1',
};

/**
 * KoiosBackend Implementation for CardanoBackend Interface
 * Implements the CardanoBackend interface using Koios API with Axios
 */
export class KoiosBackend implements CardanoBackend {
  public readonly name = 'koios';
  private api: AxiosInstance;
  private network: Network;

  /**
   * Constructor
   */
  constructor(network: Network, timeoutMs: number, apiKey?: string) {
    const headers: Record<string, string> = {};

    // Add Authorization header if API key is configured
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    this.api = axios.create({
      baseURL: KOIOS_URLS[network],
      timeout: timeoutMs,
      headers,
    });
    this.network = network;
  }

  /** 
   * Initialize the backend 
   */
  async init(): Promise<Boolean> {
    // Test connection by fetching latest block
    try {
    await this.api.get('/tip');
    } catch (error) {
      throw new BackendInitError('koios', error);
    }
    return true;
  }

  /** 
   * Get Transaction Data for specified transaction hash
   * @param hash transaction hash (hex)
   * @returns {Promise<Transaction>} transaction data
   */
  async getTransaction(hash: string): Promise<Transaction> {
    return handleBackendRequest(
      async () => {
        const body = {
          _tx_hashes: [hash],
          _inputs: true,
          _metadata: true,
          _assets: true,
          _withdrawals: false,
          _certs: false,
          _scripts: false,
          _bytecode: false,
        };

        const { data } = await this.api.post('/tx_info', body);

        if (!data || !Array.isArray(data) || data.length === 0) {
          throw new NotFoundError('Transaction', this.name);
        }

        const tx = data[0];

        let labels: MetadataLabelTx[] = [];

        if (tx.metadata) {
          labels = Object.entries(tx.metadata).map(
            ([label, json]) => ({
              txHash: hash,
              label: +label,
              json: json as JSONValue,
            }));
        }

        return {
          hash: tx.tx_hash,
          blockHash: tx.block_hash,
          blockHeight: Number(tx.block_height),
          blockTime: tx.block_time,
          slot: tx.slot_no,
          index: tx.tx_index,
          fee: parseInt(tx.tx_fee || '0', 10),
          deposit: parseInt(tx.deposit || '0', 10),
          size: tx.tx_size,
          inputs: tx.inputs.map((input: any) => {
            const amount: Amount[] = [
              { unit: 'lovelace', quantity: input.value }
            ];
            if (input.asset_list && Array.isArray(input.asset_list)) {
              for (const asset of input.asset_list) {
                amount.push({
                  unit: `${asset.policy_id}${asset.asset_name}`,
                  quantity: asset.quantity
                });
              }
            }
            return {
              address: input.payment_addr?.bech32 || input.address,
              txHash: input.tx_hash,
              outputIndex: input.tx_index,
              amount: amount,
              dataHash: input.datum_hash || null,
              inlineDatum: input.inline_datum || null,
              referenceScriptHash: input.reference_script || null,
            };
          }),
          outputs: tx.outputs.map((output: any) => {
            const amount: Amount[] = [
              { unit: 'lovelace', quantity: output.value }
            ];
            if (output.asset_list && Array.isArray(output.asset_list)) {
              for (const asset of output.asset_list) {
                amount.push({
                  unit: `${asset.policy_id}${asset.asset_name}`,
                  quantity: asset.quantity
                });
              }
            }
            return {
              address: output.payment_addr?.bech32 || output.address,
              amount: amount,
              txHash: tx.tx_hash,
              outputIndex: output.tx_index,
              dataHash: output.datum_hash || null,
              inlineDatum: output.inline_datum || null,
              isCollateral: false,
              referenceScriptHash: output.reference_script || null,
            };
          }),
          metadata: labels
        };
      },
      this.name
    );
  }

  /** 
   * Get Block Data for specified block hash
   * @param blockHash block hash (hex)
   * @returns {Promise<BlockData>} block data
   */
  async getBlock(blockHash: string): Promise<BlockData> {

    return handleBackendRequest(
      async () => {
        const blockData = await this.api.post('/block_info', { _block_hashes: [blockHash] });
        const data = blockData.data[0];

        return {
          time: data.block_time,
          height: data.block_height,
          hash: data.hash,
          slot: data.slot_no,
          epoch: data.epoch_no,
          epochSlot: data.epoch_slot_no,
          slotLeader: data.vrf_key,
          size: data.block_size,
          txCount: data.tx_count,
          fees: data.total_fees,
        };
      },
      this.name
    );
  }

  /** 
   * Get Epoch Data for specified epoch number
   * @param epochNumber epoch number
   * @returns {Promise<EpochData>} epoch data
   */
  async getEpoch(epochNumber: number): Promise<EpochData> {
    return handleBackendRequest(
      async () => {

        // get data of the given epoch
        let epochData;

        epochData = await this.api.get('/epoch_info', { params: { _epoch_no: epochNumber } });

        if (!epochData.data || !Array.isArray(epochData.data) || epochData.data.length === 0) {
          throw new NotFoundError('Epoch', this.name);
        }

        const data = epochData.data[0];

        return {
          epoch: data.epoch_no,
          start_time: data.start_time,
          end_time: data.end_time,
          first_block_time: data.first_block_time,
          last_block_time: data.last_block_time,
          block_count: data.block_count,
          tx_count: data.tx_count,
          output: data.total_output,
          fees: data.total_fees,
          active_stake: data.active_stake,
        };
      },
      this.name
    );
  }

  /**
   * Get Address Data (without transactions - use getAddressTransactions() separately)
   * @param address bech32 address
   * @returns {Promise<Address>} address data
   */
  async getAddress(address: string): Promise<Address> {
    return handleBackendRequest(
      async () => {
        const { data } = await this.api.post('/address_info', { _addresses: [address] });

        if (!data || !Array.isArray(data) || data.length === 0) {
          throw new NotFoundError('Address', this.name);
        }

        const addressData = data[0];
        const addressUtxos = await this.getAddressUtxos(address);
        const totals = new Map<string, bigint>();

        for (const u of addressData.utxo_set) {
          // add lovelace
          totals.set(
            'lovelace',
            (totals.get('lovelace') ?? 0n) + BigInt(u.value)
          );

          // add native assets
          for (const a of u.asset_list) {
            const unit = `${a.policy_id}${a.asset_name}`;
            totals.set(
              unit,
              (totals.get(unit) ?? 0n) + BigInt(a.quantity)
            );
          }
        }

        const amount: Amount[] = Array.from(totals.entries()).map(
          ([unit, quantity]) => ({
            unit,
            quantity: quantity.toString(),
          })
        );

        return {
          address: address,
          stakeAddress: addressData.stake_address || null,
          type: addressData.address_type,
          isScript: addressData.is_script,
          amount: amount,
          utxos: addressUtxos,
        };
      },
      this.name
    );
  }

  /**
   * Get Address Transactions
   * @param address bech32 address
   * @returns {Promise<Transaction[]>} list of transactions for this address
   */
  async getAddressTransactions(address: string, limit: number): Promise<Transaction[]> {
    return handleBackendRequest(
      async () => {
        const { data: addressTxs } = await this.api.post('/address_txs', { _addresses: [address] });

        // Limit before fetching individual transactions to save API calls
        const limitedTxs = addressTxs.slice(0, limit);

        const transactions = await Promise.all(limitedTxs.map(async (tx: { tx_hash: string }) => {
          return this.getTransaction(tx.tx_hash);
        }));

        return transactions;
      },
      this.name
    );
  }

  /** 
   * Get Address UTxOs for specified address
   * @param address bech32 address
   * @returns {Promise<UTxO[]>} list of UTxOs
   */
  async getAddressUtxos(address: string): Promise<UTxO[]> {
    return handleBackendRequest(
      async () => {
        const { data } = await this.api.post('/address_utxos', { _addresses: [address] });

        return data.map((utxo: any) => {
          // Build amount array from lovelace value and asset_list
          const amount: Amount[] = [
            { unit: 'lovelace', quantity: utxo.value }
          ];

          // Add native assets if present
          if (utxo.asset_list && Array.isArray(utxo.asset_list)) {
            for (const asset of utxo.asset_list) {
              amount.push({
                unit: `${asset.policy_id}${asset.asset_name}`,
                quantity: asset.quantity
              });
            }
          }

          return {
            txHash: utxo.tx_hash,
            outputIndex: utxo.tx_index,
            address: address,
            amount: amount,
            blockHash: utxo.block_hash,
            datumHash: utxo.datum_hash || null,
            scriptRef: utxo.reference_script || null,
          };
        });
      },
      this.name
    );
  }

  /** 
   * Get Network Information
   * @returns {Promise<Network>} network information
   */
  async getNetworkInformation(): Promise<NetworkInformation> {
    return handleBackendRequest(
      async () => {
        // Try /totals endpoint (works on mainnet, but returns empty array on preview/preprod testnet)
        const { data: totalsData } = await this.api.get('/totals', {
          params: { order: 'epoch_no.desc', limit: 1 }
        });
        
        if (totalsData && totalsData.length > 0) {
          const latest = totalsData[0];
          return {
            supply: {
              max: CARDANO_DEFAULTS.MAX_LOVELACE_SUPPLY,
              total: latest.supply || '0',
              circulating: latest.circulation || '0',
              locked: '0', // Not available in /totals
              treasury: latest.treasury || '0',
              reserves: latest.reserves || '0',
            },
            stake: {
              live: '0',
              active: '0',
            },
          };
        }
        
        // Fallback for preview/preprod networks where /totals doesn't work
        // Use genesis endpoint to get max supply at minimum and fill rest with defaults from mainnet epoch 608 snapshot
        const { data: genesisData } = await this.api.get('/genesis');
        const genesis = genesisData[0];
        
        // Default values based on mainnet epoch 608 snapshot
        return {
          supply: {
            max: genesis.maxlovelacesupply || CARDANO_DEFAULTS.MAX_LOVELACE_SUPPLY,
            total: '38388567212743111',
            circulating: '36035240284477897',
            locked: '0',
            treasury: '1614459422162537',
            reserves: '6611432787256889',
          },
          stake: {
            live: '0',
            active: '0',
          },
        };
      },
      this.name
    );
  }

  /** 
   * Get Transaction Metadata for specified transaction hash
   * @param tx_hash transaction hash (hex)
   * @returns {Promise<MetadataLabelTx[]>} transaction metadata list
   */
  async getTransactionMetadata(tx_hash: string): Promise<MetadataLabelTx[]> {
    return handleBackendRequest(
      async () => {
        const body = {
          _tx_hashes: [tx_hash],
          _inputs: false,
          _metadata: true,
          _assets: false,
          _withdrawals: false,
          _certs: false,
          _scripts: false,
          _bytecode: false,
        };

        const { data } = await this.api.post('/tx_info', body);

        if (data.length === 0 || data[0].metadata === null) {
          throw new NotFoundError('Transaction metadata', this.name);
        }
        const labels: MetadataLabelTx[] = Object.entries(data[0].metadata).map(
          ([label, json]) => ({
            txHash: tx_hash,
            label: +label,
            json: json as JSONValue,
          }));
        return labels;
      }, this.name
    );
  }

  /** 
   * Get Pool Data for specified pool id
   * @param poolId pool id
   * @returns {Promise<PoolData>} pool data
   */
  async getPool(poolId: string): Promise<PoolData> {
    return handleBackendRequest(
      async () => {

        const { data } = await this.api.post('/pool_info', { _pool_bech32_ids: [poolId] });

        if (!Array.isArray(data) || data.length === 0) {
          throw new NotFoundError('Pool', this.name);
        }

        const poolData = data[0];
        return {
          poolId: poolData.pool_id_bech32 || poolData.pool_id_hex || poolId,
          vrfKeyHash: poolData.vrf_key_hash,
          blocksMinted: poolData.block_count,
          blocksEpoch: poolData.epoch_no,
          liveStake: parseInt(poolData.live_stake || '0', 10),
          liveSize: poolData.live_size || 0,
          liveDelegators: poolData.live_delegators || 0,
          liveSaturation: poolData.live_saturation || 0,
          activeStake: parseInt(poolData.active_stake || '0', 10),
          activeSize: poolData.active_size || 0,
          pledge: parseInt(poolData.pledge || '0', 10),
          margin: poolData.margin || 0,
          fixedCost: parseInt(poolData.fixed_cost || '0', 10),
          rewardAccount: poolData.reward_addr,
        };
      },
      this.name
    );
  }

  /** 
   * Get Drep Data for specified drep id
   * @param drepId drep id
   * @returns {Promise<DrepData>} drep data
   */
  async getDrep(drepId: string): Promise<DrepData> {
    return handleBackendRequest(
      async () => {
        const body = {
          _drep_ids: [drepId],
        };

        const { data } = await this.api.post('/drep_info', body);

        if (!Array.isArray(data) || data.length === 0) {
          throw new NotFoundError('Drep', this.name);
        }

        const drepData = data[0];
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

  /** 
   * Get Account Data for specified stake address
   * @param accountId account id
   * @returns {Promise<AccountData>} account data
   */
  async getAccount(accountId: string): Promise<AccountData> {
    return handleBackendRequest(
      async () => {

        const body = {
          _stake_addresses: [accountId],
        };
        const { data } = await this.api.post('/account_info', body);

        if (!Array.isArray(data) || data.length === 0) {
          throw new NotFoundError('Account', this.name);
        }
        // Fetch associated addresses
        const addressDataResponse = await this.api.post('/account_addresses', body);

        // Koios returns [{ stake_address, addresses: [...] }], flatten to get all addresses
        const addressesFlat = addressDataResponse.data.flatMap((item: any) => item.addresses);
        const addresses = await Promise.all(
          addressesFlat.map((addr: string) => this.getAddress(addr))
        );

        const accountData = data[0];
        return {
          stakeaddress: accountData.stake_address,
          active: accountData.active ?? false,
          activeEpoch: accountData.active_epoch ?? 0,
          controlledAmount: accountData.controlled_amount,
          rewardsSum: accountData.rewards_sum,
          withdrawalsSum: accountData.withdrawals_sum,
          reservesSum: accountData.reserves_sum,
          treasurySum: accountData.treasury_sum,
          withdrawableAmount: accountData.withdrawable_amount,
          poolId: accountData.pool_id || null,
          drepId: accountData.drep_id || null,
          addresses: addresses,
        };
      },
      this.name
    );
  }

  /** 
   * Submit Transaction
   * @param signedTxCbor signed transaction in CBOR hex format
   * @returns {Promise<string>} transaction hash
   */
  async submitTransaction(signedTxCbor: string): Promise<string> {
    return handleBackendRequest(
      async () => {
        const body = {
          _txs: [signedTxCbor],
        };
        const { data } = await this.api.post('/submit_tx', body);

        return data[0].tx_hash;
      },
      this.name
    );
  }

  /** 
   * Get Protocol Parameters
   * @returns {Promise<any>} protocol parameters
   */
  async getProtocolParameters(): Promise<LedgerProtocolParameters> {
    return handleBackendRequest(
      async () => {
        const { data } = await this.api.get('/cli_protocol_params');

        return {
          network: this.network,
          epoch: 0, // Koios doesn't provide current epoch in this endpoint
          // --- Fees / Sizes ---
          minFeeA: data.txFeePerByte,
          minFeeB: data.txFeeFixed,
          maxBlockSize: data.maxBlockBodySize,
          maxTxSize: data.maxTxSize,
          maxBlockHeaderSize: data.maxBlockHeaderSize,
          // --- Deposits / Pools ---
          keyDeposit: data.stakeAddressDeposit.toString(),
          poolDeposit: data.stakePoolDeposit.toString(),
          eMax: data.poolRetireMaxEpoch,
          nOpt: data.stakePoolTargetNum,
          a0: data.poolPledgeInfluence,
          rho: data.monetaryExpansion,
          tau: data.treasuryCut,
          minPoolCost: data.minPoolCost.toString(),
          // --- Legacy / Misc ---S
          decentralisationParam: 0, // deprecated in Conway era
          extraEntropy: null,
          protocolMajorVer: data.protocolVersion.major,
          protocolMinorVer: data.protocolVersion.minor,
          minUtxo: '0', // legacy, replaced by coinsPerUtxoSize
          nonce: '',
          // --- Plutus / Execution units ---
          costModels: JSON.stringify(data.costModels),
          priceMem: data.executionUnitPrices.priceMemory,
          priceStep: data.executionUnitPrices.priceSteps,
          maxTxExMem: data.maxTxExecutionUnits.memory.toString(),
          maxTxExSteps: data.maxTxExecutionUnits.steps.toString(),
          maxBlockExMem: data.maxBlockExecutionUnits.memory.toString(),
          maxBlockExSteps: data.maxBlockExecutionUnits.steps.toString(),
          // --- Babbage+ UTxO cost / Collateral ---
          maxValSize: data.maxValueSize.toString(),
          collateralPercent: data.collateralPercentage,
          maxCollateralInputs: data.maxCollateralInputs,
          coinsPerUtxoSize: data.utxoCostPerByte.toString(),
          // --- Housekeeping ---
          fetchedAt: new Date().toISOString(),
          source: this.name
        };
      },
      this.name
    );
  }

  /** 
   * Get Latest Block Data
   * @returns {Promise<BlockData>} latest block data
   */
  async getLatestBlock(): Promise<BlockData> {
    return handleBackendRequest(
      async () => {
        const { data } = await this.api.get('/tip');
        return await this.getBlock(data[0].hash);
      },
      this.name
    );
  }

  /**
   * Get Latest Epoch Data
   * @returns {Promise<EpochData>} latest epoch data
   */
  async getLatestEpoch(): Promise<EpochData> {
    return handleBackendRequest(
      async () => {
        const { data } = await this.api.get('/tip');
        // /tip returns an array, access first element
        return this.getEpoch(data[0].epoch_no);
      },
      this.name
    );
  }
}