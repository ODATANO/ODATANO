/**
 * Hybrid Backend - Smart Router for Ogmios + Blockfrost/Koios
 * 
 * Routes requests intelligently:
 * - Live/State Queries → Ogmios (protocol params, UTxOs, epoch, TX submit)
 * - Historical Queries → Blockfrost/Koios (blocks, transactions, metadata)
 */

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

export class HybridBackend implements CardanoBackend {
  public readonly name = 'hybrid';
  
  private liveBackend: OgmiosBackend;
  private historicalBackend: CardanoBackend;

  constructor(
    liveBackend: OgmiosBackend,
    historicalBackend: BlockfrostBackend | KoiosBackend
  ) {
    this.liveBackend = liveBackend;
    this.historicalBackend = historicalBackend;
  }

  async init(): Promise<void> {
    logger.info('[HybridBackend] Initializing live backend (Ogmios)');
    await this.liveBackend.init();
    
    logger.info('[HybridBackend] Initializing historical backend');
    await this.historicalBackend.init();
    
    logger.info('[HybridBackend] Both backends initialized successfully');
  }

  // ---------------------------------------------------------------------------
  // Live Data → Ogmios  (live, stateful queries)
  // ---------------------------------------------------------------------------
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

  async getlatestEpoch(): Promise<EpochData> {
    logger.debug('[HybridBackend] get Latest Epoch');
    try {
      return await this.liveBackend.getlatestEpoch();
    } catch (error: any) {
      // fallback to historical backend if Ogmios fails
      logger.warn('[HybridBackend] Ogmios failed for latest epoch, falling back to historical backend');
      return this.historicalBackend.getlatestEpoch();
    }
  }

  async getlatestBlock(): Promise<BlockData> {
    logger.debug('[HybridBackend] get Latest Block');
    try {
      return await this.liveBackend.getlatestBlock();
    } catch (error: any) {
      // fallback to historical backend if Ogmios fails
      logger.warn('[HybridBackend] Ogmios failed for latest block, falling back to historical backend');
      return this.historicalBackend.getlatestBlock();
    }
  }

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
  // Historical Data → Blockfrost/Koios (indexed, queryable history) just fallback between blockfrost and koios
  // ---------------------------------------------------------------------------

  async getBlock(hash: string): Promise<BlockData> {
    logger.debug(`[HybridBackend] Block → ${this.historicalBackend.name} (historical)`);
    return this.historicalBackend.getBlock(hash);
  }

  async getEpoch(epochNumber: Number): Promise<EpochData> {
    logger.debug(`[HybridBackend] Epoch → ${this.historicalBackend.name} (historical)`);
    return this.historicalBackend.getEpoch(epochNumber);
  }

  async getTransaction(hash: string): Promise<Transaction> {
    logger.debug(`[HybridBackend] Transaction → ${this.historicalBackend.name} (historical)`);
    return this.historicalBackend.getTransaction(hash);
  }

  async getTransactionMetadata(tx_hash: string): Promise<MetadataLabelTx[]> {
    logger.debug(`[HybridBackend] TX Metadata → ${this.historicalBackend.name} (historical)`);
    return this.historicalBackend.getTransactionMetadata(tx_hash);
  }

  async getDrep(drepId: string): Promise<DrepData> {
    logger.debug(`[HybridBackend] DRep → ${this.historicalBackend.name} (historical)`);
    return this.historicalBackend.getDrep(drepId);
  }
}
