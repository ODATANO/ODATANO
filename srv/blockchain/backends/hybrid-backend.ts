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
import { NotFoundError, AllBackendsFailedError } from '../../utils/errors';
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

  async shutdown(): Promise<void> {
    // Ogmios backend has shutdown method, others may not
    if ('shutdown' in this.liveBackend && typeof this.liveBackend.shutdown === 'function') {
      await this.liveBackend.shutdown();
    }
    if ('shutdown' in this.historicalBackend && typeof this.historicalBackend.shutdown === 'function') {
      await this.historicalBackend.shutdown();
    }
  }

  // ---------------------------------------------------------------------------
  // LIVE DATA → Ogmios (self-hosted, real-time state)
  // ---------------------------------------------------------------------------

  async getProtocolParameters(): Promise<LedgerProtocolParameters> {
    logger.debug('[HybridBackend] Protocol params → Ogmios (live)');
    return this.liveBackend.getProtocolParameters();
  }

  async getEpoch(epochNumber: number): Promise<EpochData> {
    // Try Ogmios first (current/recent epochs)
    try {
      logger.debug('[HybridBackend] Epoch data → Ogmios (trying live first)');
      return await this.liveBackend.getEpoch(epochNumber);
    } catch (error: any) {
      // Fallback to historical backend if:
      // - Node not synced enough
      // - Epoch not found in current state
      logger.debug(`[HybridBackend] Ogmios failed: ${error.message}, falling back to ${this.historicalBackend.name}`);
      return this.historicalBackend.getEpoch(epochNumber);
    }
  }

  async getAddress(address: string): Promise<Address> {
    logger.debug('[HybridBackend] Address → Ogmios (live UTxOs)');
    return this.liveBackend.getAddress(address);
  }

  async getAddressUtxos(address: string): Promise<UTxO[]> {
    logger.debug('[HybridBackend] UTxOs → Ogmios (live state)');
    return this.liveBackend.getAddressUtxos(address);
  }

  async submitTransaction(signedTxCbor: string): Promise<string> {
    logger.debug('[HybridBackend] TX submit → Ogmios (self-hosted node)');
    return this.liveBackend.submitTransaction(signedTxCbor);
  }

  async getNetworkInformation(): Promise<Network> {
    logger.debug('[HybridBackend] Network info → Ogmios (live)');
    return this.liveBackend.getNetworkInformation();
  }

  async getPool(poolId: string): Promise<PoolData> {
    logger.debug('[HybridBackend] Pool → Ogmios (live state)');
    return this.liveBackend.getPool(poolId);
  }

  async getAccount(stakeAddress: string): Promise<AccountData> {
    logger.debug('[HybridBackend] Account → Ogmios (live state)');
    return this.liveBackend.getAccount(stakeAddress);
  }

  // ---------------------------------------------------------------------------
  // HISTORICAL DATA → Blockfrost/Koios (indexed, queryable history)
  // ---------------------------------------------------------------------------

  async getBlock(hash: string): Promise<BlockData> {
    logger.debug(`[HybridBackend] Block → ${this.historicalBackend.name} (historical)`);
    return this.historicalBackend.getBlock(hash);
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
