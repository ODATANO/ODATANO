import { CardanoBackend } from './cardano-backend';
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';

export class BlockfrostBackend implements CardanoBackend {
  public readonly name = 'blockfrost';
  private api: BlockFrostAPI;

  constructor() {
    const projectId = process.env.BLOCKFROST_KEY;
    if (!projectId) {
      throw new Error('[BlockfrostBackend] Environment variable BLOCKFROST_KEY is not set');
    }

    this.api = new BlockFrostAPI({
      projectId,
    });
  }

   async init(): Promise<void> {
    // await this.api.health();
  }
  // ---------------------------------------------------------------------------
  // Network-Info
  // ---------------------------------------------------------------------------
  async getNetworkInformation(): Promise<any> {
    try {
      const latestBlock = await this.api.blocksLatest();
      const networkInfo = await this.api.network();
      const latestEpoch = await this.api.epochsLatest();
      const health = await this.api.health();

      return {
        latestBlock: latestBlock,
        network: networkInfo,
        latestEpoch: latestEpoch,
        health: health,
      };
    } catch (err: any) {
      if (err?.status === 404 || err?.response?.status === 404) {
        throw new Error('NOT_FOUND');
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Transaction
  // ---------------------------------------------------------------------------
  async getTransaction(hash: string): Promise<any> {
    try {
      const tx = await this.api.txs(hash);
      const txUtxos = await this.api.txsUtxos(hash);
      const txMetadata = await this.api.txsMetadata(hash);

      return {
        tx,
        txUtxos,
        txMetadata,
      };
    } catch (err: any) {
      if (err?.status === 404 || err?.response?.status === 404) {
        throw new Error('NOT_FOUND');
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Metadata
  // ---------------------------------------------------------------------------
  async getMetadataLabels(): Promise<any[]> {
    try {
      const labelData = await this.api.metadataTxsLabels();
      return labelData;
    } catch (err: any) {
      if (err?.response?.status === 404 || err?.status === 404) {
        throw new Error('NOT_FOUND');
      }
      throw err;
    }
  }

  async getMetadataLabelTransactions(label: string | number): Promise<any[]> {
    try {
      const labelData = await this.api.metadataTxsLabel(String(label));
      return labelData;
    } catch (err: any) {
      if (err?.response?.status === 404 || err?.status === 404) {
        throw new Error('NOT_FOUND');
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Address
  // ---------------------------------------------------------------------------
  async getAddress(address: string): Promise<any> {
    try {
      const data = await this.api.addresses(address);
      return data;
    } catch (err: any) {
      if (err?.response?.status === 404 || err?.status === 404) {
        throw new Error('NOT_FOUND');
      }
      throw err;
    }
  }

  async getAddressUtxos(address: string): Promise<any[]> {
    try {
      const data = await this.api.addressesUtxos(address);
      return data;
    } catch (err: any) {
      if (err?.response?.status === 404 || err?.status === 404) {
        throw new Error('NOT_FOUND');
      }
      throw err;
    }
  }
}
