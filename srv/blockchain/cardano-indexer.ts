import cds from '@sap/cds';
import type { Transaction } from '@sap/cds';
import cardano from './cardano-client';
import logger from '../utils/logger';

import {
  Addresses,
  Transaction as TransactionRow,
  AddressAssets,
  AddressUTxOs,
  Transactions,
  TransactionInputs,
  TransactionInputAssets,
  TransactionOutputs,
  TransactionOutputAssets,
  TransactionMetadata, 
  NetworkInformation,
  Block ,
  Epoch,
} from '#cds-models/CardanoODataService';

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
  mapDrep,
  mapPool,
  mapTransactionMetadata,
} from '../utils/mappers';

import { Transaction as TransactionProviderData } from '../utils/types';

const { UPSERT, SELECT } = cds.ql;

export class CardanoIndexer {
  /**
   * Index a single transaction with inputs/outputs/assets/UTxOs/addresses
   *
   * @param tx      CAP transaction (cds.tx(req))
   * @param txHash  Cardano transaction hash (hex)
   */
  async indexTransaction(
    tx: Transaction,
    txHash: string,
  ): Promise<TransactionRow> {
    // getting data from cardano data provider
    const providerTx = await cardano.getTransaction(txHash);

    if (!providerTx) {
      throw new Error(`Transaction ${txHash} not found at provider`);
    }

    const txRow = mapTransaction(providerTx);

    await this._runWithRetry(() =>
      tx.run(
        UPSERT.into(Transactions).entries(txRow)
      )
    );

    if (providerTx.inputs || providerTx.outputs) {
      const addresses = this._collectAddressesFromUtxos(providerTx);
      if (addresses.length) {
        await this._ensureAddresses(tx, addresses);
      }

      // Inputs + InputAssets
      const inputRows = mapTransactionInputs(txHash, providerTx.inputs || []);
      const inputAssetRows = mapTransactionInputAssets(txHash, providerTx.inputs || []);

      if (inputRows.length) {
        await this._runWithRetry(() =>
          tx.run(
            UPSERT.into(TransactionInputs).entries(inputRows)
          )
        );
      }

      if (inputAssetRows.length) {
        await this._runWithRetry(() =>
          tx.run(
            UPSERT.into(TransactionInputAssets).entries(inputAssetRows)
          )
        );
      }
      
      // Outputs + OutputAssets
      const outputRows = mapTransactionOutputs(txHash, providerTx.outputs || []);
      const outputAssetRows = mapTransactionOutputAssets(txHash, providerTx.outputs || []);

      if (outputRows.length) {
        await this._runWithRetry(() =>
          tx.run(
            UPSERT.into(TransactionOutputs).entries(outputRows)
          )
        );
      }

      if (outputAssetRows.length) {
        await this._runWithRetry(() =>
          tx.run(
            UPSERT.into(TransactionOutputAssets).entries(outputAssetRows)
          )
        );
      }
    }

    const metadataRows = mapTransactionMetadata(providerTx.metadata || []);

    if (metadataRows.length) {
      await this._runWithRetry(() =>
        tx.run(
          UPSERT.into(TransactionMetadata).entries(metadataRows)
        )
      );
    }

    return txRow;
  }

  /**
   * Index a single address (Addresses + AddressAssets + AddressUTxOs)
   */
  async indexAddress(tx: Transaction, addr: string): Promise<any> {
    const addrData = await cardano.getAddress(addr);

    logger.debug({ addrData }, 'indexAddress: provider response');

    const AddrEntity = mapAddress(addr, addrData);

    await this._runWithRetry(() =>
      tx.run(
        UPSERT.into(Addresses).entries(AddrEntity)
      )
    );

    const validTo = AddrEntity.validTo ?? new Date().toISOString();
    const validFrom = AddrEntity.validFrom ?? new Date().toISOString();

    const assetEntities = mapAddressAssets(
      addr,
      validFrom,
      validTo, 
      addrData.amount
    );

    if (assetEntities.length) {
      await this._runWithRetry(() =>
        tx.run(
          UPSERT.into(AddressAssets).entries(assetEntities)
        )
      );
    }

    const utxoData = await cardano.getAddressUtxos(addr);

    const utxoEntities = mapAddressUtxos(
      addr,
      validFrom,
      validTo,
      utxoData
    );

    logger.debug({ utxoEntities }, 'indexAddress: utxo entities');

    if (utxoEntities.length) {
      await this._runWithRetry(() =>
        tx.run(
          UPSERT.into(AddressUTxOs).entries(utxoEntities)
        )
      );
    }

    return AddrEntity;
  }

   /**
   * Index metadata for a single transaction (Metadata)
   *
   * @param tx       CAP transaction
   * @param txHash   transaction hash
   * @param metadata raw metadata object (label -> JSONValue)
   */
  async indexTransactionMetadata(
    tx: Transaction,
    txHash: string,
  ): Promise<TransactionMetadata[]> {

    const metadata = await cardano.getTransactionMetadata(txHash);

    const rows = mapTransactionMetadata(metadata);

    if (rows.length) {
      await this._runWithRetry(() =>
        tx.run(
          UPSERT.into(TransactionMetadata).entries(rows)
        )
      );
    }
    return rows;
  }

  /**
   * Index metadata for all transactions of a given label
   * using cardano.getMetadataLabelTransactions(label)
   *
   * @param tx     CAP transaction
   * @param label  metadata label (numeric or string)
   */
  async indexMetadataLabelTransactions(
    tx: Transaction,
    label: string | number,
  ): Promise<TransactionMetadata[]> {
    
    const labelTxs = await cardano.getMetadataLabelTransactions(label);

    if (!Array.isArray(labelTxs) || labelTxs.length === 0) {
      return [];
    }

    const rows: TransactionMetadata[] = [];
    for (const entry of labelTxs) {
      const numericLabel = Number(entry.label);
      if (Number.isNaN(numericLabel)) continue;

      rows.push({
        tx_hash: entry.txHash,
        label: numericLabel.toString(),
        payload: entry.json !== undefined ? JSON.stringify(entry.json) : null,
      });
    }

    if (rows.length) {
      await this._runWithRetry(() =>
        tx.run(
          UPSERT.into(TransactionMetadata).entries(rows)
        )
      );
    }

    return rows;
  }

  /**
   * Index network information
   */
  async indexNetworkInformation(tx: Transaction): Promise<NetworkInformation> {
    const netInfo = await cardano.getNetworkInformation();
    const netEntity = mapNetworkInfo(netInfo);

    await this._runWithRetry(() =>
      tx.run(
        UPSERT.into(NetworkInformation).entries(netEntity)
      )
    );
    return netEntity;
  }
  
  /**
   * Index latest block information
   */
  async indexLatestBlock(tx: Transaction): Promise<Block> {
    const blockInfo = await cardano.getLatestBlock();
    
    let latestEpoch = await tx.run(SELECT.one.from(Epoch));
    if (!latestEpoch) {
      try {
        latestEpoch = await this.indexLatestEpoch(tx);
      } catch (error) {
        throw new Error('LatestEpoch data not found for LatestBlock indexing');
      }
    }
    const blockEntity = mapBlock(blockInfo, latestEpoch); 
    await this._runWithRetry(() =>
      tx.run(
        UPSERT.into(Block).entries([blockEntity])
      )
    );
    return blockEntity;
  }

   /**
   * Index spec. block information
   */
  async indexBlock(tx: Transaction, blockHash: string): Promise<Block> {
    const blockInfo = await cardano.getBlock(blockHash);
    
    let latestEpoch = await tx.run(SELECT.one.from(Epoch));
    if (!latestEpoch) {
      try {
        latestEpoch = await this.indexLatestEpoch(tx);
      } catch (error) {
        throw new Error('LatestEpoch data not found for LatestBlock indexing');
      }
    }
    const blockEntity = mapBlock(blockInfo, latestEpoch); 
    await this._runWithRetry(() =>
      tx.run(
        UPSERT.into(Block).entries([blockEntity])
      )
    );
    return blockEntity;
  }

  /**
   * Index latest epoch information
   */
  async indexLatestEpoch(tx: Transaction): Promise<Epoch> {
    const epochInfo = await cardano.getLatestEpoch();
    const epochEntity = mapEpoch(epochInfo);  
    await this._runWithRetry(() =>
      tx.run(
        UPSERT.into(Epoch).entries([epochEntity])
      )
    );
    return epochEntity;
  }

   /**
   * Index spec. epoch information
   */
  async indexEpoch(tx: Transaction,epochNumber: number): Promise<Epoch> {
    const epochInfo = await cardano.getEpoch(epochNumber);
    const epochEntity = mapEpoch(epochInfo);  
    await this._runWithRetry(() =>
      tx.run(
        UPSERT.into(Epoch).entries([epochEntity])
      )
    );
    return epochEntity;
  }

  async indexAccount(tx: Transaction, accountId: string) {
    const accountInfo = await cardano.getAccount(accountId);
    const accountEntity = mapAccount(accountInfo);
    await this._runWithRetry(() =>
      tx.run(
        UPSERT.into('Account').entries([accountEntity])
      )
    );
    return accountEntity;
  }
  
  async indexDrep(tx: Transaction, drepId: string)  {
    const drepInfo = await cardano.getDrep(drepId);
    const drepEntity = mapDrep(drepInfo);
    await this._runWithRetry(() =>
      tx.run(
        UPSERT.into('Drep').entries([drepEntity])
      )
    );
    return drepEntity;
  }
  
  async indexPool(tx: Transaction, poolId: string)  {
    const poolInfo = await cardano.getPool(poolId);
    const poolEntity = mapPool(poolInfo);
    await this._runWithRetry(() =>
      tx.run(
        UPSERT.into('Pool').entries([poolEntity])
      )
    );
    return poolEntity;
  } 


  /**
   * Helper: collect all involved addresses from a txUtxos set
   */
  private _collectAddressesFromUtxos(txUtxos: TransactionProviderData): string[] {
    const set = new Set<string>();

    const inputs = txUtxos.inputs ?? [];
    const outputs = txUtxos.outputs ?? [];
    
    for (const i of inputs) {
      if (i.address) set.add(i.address);
    }
    for (const o of outputs) {
      if (o.address) set.add(o.address);
    }

    return Array.from(set);
  }

  /**
   * Helper: index multiple addresses with assets
   */
  private async _ensureAddresses(
    tx: Transaction,
    bech32List: string[]
  ): Promise<void> {
    for (const bech32 of bech32List) {
      await this.indexAddress(tx, bech32);
    }
  }

  private async _runWithRetry<T>(fn: () => Promise<T>, maxRetries = 5): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        return await fn();
      } catch (err: any) {
        const code = err?.code;
        const msg = err?.message || '';
        if ((code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT' || msg.includes('database is locked')) && attempt < maxRetries) {
          await new Promise(res => setTimeout(res, 200 * (attempt + 1)));
          attempt++;
          continue;
        }
        throw err;
      }
    }
  }
}

const cardanoIndexer = new CardanoIndexer();
export default cardanoIndexer;
