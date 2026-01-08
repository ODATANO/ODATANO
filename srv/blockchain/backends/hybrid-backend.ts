import { CardanoBackend } from './cardano-backend';
import { OgmiosBackend } from './ogmios-backend';
import { BlockfrostBackend } from './blockfrost-backend';
import { KoiosBackend } from './koios-backend';
import logger from '../../utils/logger';
import {
  Transaction,
  Address,
  UTxO,
  Network,
  BlockData,
  EpochData,
  MetadataLabelTx,
  PoolData,
  DrepData,
  AccountData,
  LedgerProtocolParameters
} from '../../utils/types';

/**
 * HybridBackend - Smart Router for Ogmios + Blockfrost/Koios implementation of CardanoBackend
 * 
 * Routes requests intelligently:
 * Live/State Queries with Ogmios first (protocol params, address data, address UTxOs, TX submit etc.)
 * Historical Queries with Blockfrost/Koios first (specific blocks, epochs, transactions, metadata etc.)
 */
export class HybridBackend implements CardanoBackend {
  public readonly name = 'hybrid';
  private liveBackend: OgmiosBackend;
  private historicalBackend: CardanoBackend;
  /** 
   * Constructor 
   */
  constructor(
    liveBackend: OgmiosBackend,
    historicalBackend: BlockfrostBackend | KoiosBackend
  ) {
    this.liveBackend = liveBackend;
    this.historicalBackend = historicalBackend;
  }
  
  /**
   * Initialize both backends 
   */
  async init(): Promise<void> {
    logger.info('[HybridBackend] Initializing live backend (Ogmios)');
    await this.liveBackend.init();
    
    logger.info('[HybridBackend] Initializing historical backend');
    await this.historicalBackend.init();
    
    logger.info('[HybridBackend] Both backends initialized successfully');
  }

// ---------------------------------------------------------------------------
// Live Data → Ogmios  (stateful queries)
// ---------------------------------------------------------------------------
  
  /**
   * Get Protocol Parameters
   * @returns {Promise<LedgerProtocolParameters>} protocol parameters
   */
  async getProtocolParameters(): Promise<LedgerProtocolParameters> {
    logger.debug('[HybridBackend] get Protocol Parameters');
    try {
      return await this.liveBackend.getProtocolParameters();
    } catch (error: any) {
      // fallback to historical backend if Ogmios fails
      logger.warn('[HybridBackend] Ogmios failed for protocol params, falling back to historical backend');
      return this.historicalBackend.getProtocolParameters();
    }
  }

  /**
   * Get Latest Epoch Data
   * @returns {Promise<EpochData>} latest epoch data
   */
  async getLatestEpoch(): Promise<EpochData> {
    logger.debug('[HybridBackend] get Latest Epoch');
    try {
      return await this.liveBackend.getLatestEpoch();
    } catch (error: any) {
      // fallback to historical backend if Ogmios fails
      logger.warn('[HybridBackend] Ogmios failed for latest epoch, falling back to historical backend');
      return this.historicalBackend.getLatestEpoch();
    }
  }

  /** 
   * Get Latest Block Data
   * @returns {Promise<BlockData>} latest block data
   */
  async getLatestBlock(): Promise<BlockData> {
    logger.debug('[HybridBackend] get Latest Block');
    try {
      return await this.liveBackend.getLatestBlock();
    } catch (error: any) {
      // fallback to historical backend if Ogmios fails
      logger.warn('[HybridBackend] Ogmios failed for latest block, falling back to historical backend');
      return this.historicalBackend.getLatestBlock();
    }
  }

  /** 
   * Get  Address details for specified address
   * @param address bech32 address
   * @returns {Promise<Address>} address details
   */
  async getAddress(address: string): Promise<Address> {
    logger.debug('[HybridBackend] get Address details');
    try {
      return await this.liveBackend.getAddress(address);
    } catch (error: any) {
      // fallback to historical backend if Ogmios fails
      logger.warn('[HybridBackend] Ogmios failed for address, falling back to historical backend');
      return this.historicalBackend.getAddress(address);
    }
  }

  /** 
   * Get Address UTxOs for specified address
   * @param address bech32 address
   * @returns {Promise<UTxO[]>} list of UTxOs
   */
  async getAddressUtxos(address: string): Promise<UTxO[]> {
    logger.debug('[HybridBackend] get Address UTxOs');
    try {
      return await this.liveBackend.getAddressUtxos(address);
    } catch (error: any) {
      // fallback to historical backend if Ogmios fails
      logger.warn('[HybridBackend] Ogmios failed for UTxOs, falling back to historical backend');
      return this.historicalBackend.getAddressUtxos(address);
    }
  }

  /** 
   * Submit a signed transaction to the network
   * @param signedTxCbor signed transaction in CBOR hex format
   * @returns {Promise<string>} transaction hash
   */
  async submitTransaction(signedTxCbor: string): Promise<string> {
    logger.debug('[HybridBackend] TX submit with Ogmios');
    try {
      return await this.liveBackend.submitTransaction(signedTxCbor);
    } catch (error: any) {
      // Fallback to historical backend if Ogmios fails
      logger.warn('[HybridBackend] Ogmios failed for TX submit, falling back to historical backend');
      return this.historicalBackend.submitTransaction(signedTxCbor);
    }
  }

  /** 
   * Get Network Information
   * @returns {Promise<Network>} network information
   */
  async getNetworkInformation(): Promise<Network> {
    logger.debug('[HybridBackend] Network info → Ogmios (live)');
    try {
      return await this.liveBackend.getNetworkInformation();
    } catch (error: any) {
      // Fallback to historical backend if Ogmios fails
      logger.warn('[HybridBackend] Ogmios failed for network info, falling back to historical backend');
      return this.historicalBackend.getNetworkInformation();
    }
  }
  
  /** 
   * Get Pool Data for specified pool id
   * @param poolId pool id (bech32)
   * @returns {Promise<PoolData>} pool data
   */
  async getPool(poolId: string): Promise<PoolData> {
    logger.debug('[HybridBackend] Pool → Ogmios (live state)');
    try {
      return await this.liveBackend.getPool(poolId);
    } catch (error: any) {
      // Fallback to historical backend if Ogmios fails
      logger.warn('[HybridBackend] Ogmios failed for pool, falling back to historical backend');
      return this.historicalBackend.getPool(poolId);
    }
  }

  /** 
   * Get Account Data for specified stake address
   * @param stakeAddress stake address (bech32)
   * @returns {Promise<AccountData>} account data
   */
  async getAccount(stakeAddress: string): Promise<AccountData> {
    try {
    logger.debug('[HybridBackend] Account → Ogmios (live state)');
    return this.liveBackend.getAccount(stakeAddress);
    } catch (error: any) {
      // Fallback to historical backend if Ogmios fails
      logger.warn('[HybridBackend] Ogmios failed for account, falling back to historical backend');
      return this.historicalBackend.getAccount(stakeAddress);
    }
  }

// ---------------------------------------------------------------------------
// Historical Data → Blockfrost/Koios  (stateless queries)
// ---------------------------------------------------------------------------

  /**
   * Get Block Data for specified block hash
   * @param hash 
   * @returns {Promise<BlockData>} block data
   */
  async getBlock(hash: string): Promise<BlockData> {
    logger.debug(`[HybridBackend] Block → ${this.historicalBackend.name} (historical)`);
    return this.historicalBackend.getBlock(hash);
  }

  /** 
   * Get Epoch Data for specified epoch number
   * @param epochNumber epoch number of the epoch to retrieve
   * @returns {Promise<EpochData>} epoch data
   */
  async getEpoch(epochNumber: Number): Promise<EpochData> {
    logger.debug(`[HybridBackend] Epoch → ${this.historicalBackend.name} (historical)`);
    return this.historicalBackend.getEpoch(epochNumber);
  }

  /** 
   * Get Transaction Data for specified transaction hash
   * @param hash transaction hash (hex) 
   * @returns {Promise<Transaction>} transaction data
   */
  async getTransaction(hash: string): Promise<Transaction> {
    logger.debug(`[HybridBackend] Transaction → ${this.historicalBackend.name} (historical)`);
    return this.historicalBackend.getTransaction(hash);
  }

  /** 
   * Get Transaction Metadata for specified transaction hash
   * @param tx_hash transaction hash (hex)
   * @returns {Promise<MetadataLabelTx[]>} transaction metadata list
   */
  async getTransactionMetadata(tx_hash: string): Promise<MetadataLabelTx[]> {
    logger.debug(`[HybridBackend] TX Metadata → ${this.historicalBackend.name} (historical)`);
    return this.historicalBackend.getTransactionMetadata(tx_hash);
  }

  /**
   * Get Drep Data for specified drepId in bech32
   * @param drepId drep id (bech32)
   * @returns {Promise<DrepData>} drep data
   */
  async getDrep(drepId: string): Promise<DrepData> {
    logger.debug(`[HybridBackend] DRep → ${this.historicalBackend.name} (historical)`);
    return this.historicalBackend.getDrep(drepId);
  }
}
