import cds from '@sap/cds';
import type { Transaction as CapTransaction } from '@sap/cds';
import cardano from './cardano-client';
import logger from '../utils/logger';

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
  Block ,
  Epoch,
  Accounts,
  Pools,
  Dreps,
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

const { UPSERT } = cds.ql;

export class CardanoIndexer {
  /**
   * Index a single transaction with inputs/outputs/assets/UTxOs/addresses
   *
   * @param tx      CAP transaction (cds.tx(req))
   * @param txHash  Cardano transaction hash (hex)
   */
  async indexTransaction(
    tx: CapTransaction,
    txHash: string,
  ): Promise<CardanoTransaction> {
    // getting data from cardano data provider
    const providerTx = await cardano.getTransaction(txHash);

    const txRow = mapTransaction(providerTx);
    tx.run( UPSERT.into(Transactions).entries(txRow))

    if (providerTx.inputs || providerTx.outputs) {
      const addresses = this._collectAddressesFromUtxos(providerTx);
      if (addresses.length) {
        await this._ensureAddresses(tx, addresses);
      }

      // Inputs + InputAssets
      const inputRows = mapTransactionInputs(txHash, providerTx.inputs || []);
      const inputAssetRows = mapTransactionInputAssets(txHash, providerTx.inputs || []);

      if (inputRows.length) {
          
      tx.run(UPSERT.into(TransactionInputs).entries(inputRows))
      
      }

      if (inputAssetRows.length) {
          
          tx.run( UPSERT.into(TransactionInputAssets).entries(inputAssetRows))
      }
      
      // Outputs + OutputAssets
      const outputRows = mapTransactionOutputs(txHash, providerTx.outputs);
      const outputAssetRows = mapTransactionOutputAssets(txHash, providerTx.outputs);

      if (outputRows.length) {

        tx.run(UPSERT.into(TransactionOutputs).entries(outputRows))
 
      }

      if (outputAssetRows.length) {
        tx.run( UPSERT.into(TransactionOutputAssets).entries(outputAssetRows))
      }
    }

    const metadataRows = mapTransactionMetadata(providerTx.metadata || []);

    if (metadataRows.length) {
        tx.run( UPSERT.into(TransactionMetadata).entries(metadataRows))
    }

    return txRow;
  }

  /**
   * Index a single address (Addresses + AddressAssets + AddressUTxOs)
   */
  async indexAddress(tx: CapTransaction, addr: string): Promise<any> {
    const addrData = await cardano.getAddress(addr);

    logger.debug({ addrData }, 'indexAddress: provider response');

    const AddrEntity = mapAddress(addr, addrData);
    
    tx.run(UPSERT.into(Addresses).entries(AddrEntity))

    const validTo = AddrEntity.validTo ?? new Date().toISOString();
    const validFrom = AddrEntity.validFrom ?? new Date().toISOString();

    const assetEntities = mapAddressAssets(
      addr,
      validFrom,
      validTo, 
      addrData.amount
    );

    if (assetEntities.length > 0) {
      tx.run(UPSERT.into(AddressAssets).entries(assetEntities))
    }

    console.log('Indexing UTxOs for address:', addr);
    const utxoData = await cardano.getAddressUtxos(addr);

    const utxoEntities = mapAddressUtxos(
      addr,
      validFrom,
      validTo,
      utxoData
    );

    logger.debug({ utxoEntities }, 'indexAddress: utxo entities');

    if (utxoEntities.length) {  
        tx.run(UPSERT.into(AddressUTxOs).entries(utxoEntities))
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
    tx: CapTransaction,
    tx_hash: string,
  ): Promise<TransactionMetadata[]> {
    const metadata = await cardano.getTransactionMetadata(tx_hash);
    const rows = mapTransactionMetadata(metadata);

    if (rows.length) {
      await tx.run(UPSERT.into(TransactionMetadata).entries(rows))
    }
    return rows;
  }

  /**
   * Index network information
   */
  async indexNetworkInformation(tx: CapTransaction): Promise<NetworkInformation> {
    const netInfo = await cardano.getNetworkInformation();
    const netEntity = mapNetworkInfo(netInfo);

    await tx.run(UPSERT.into(NetworkInformation).entries(netEntity));
    return netEntity;
  }
  
   /**
   * Index spec. block information
   */
  async indexBlock(tx: CapTransaction, blockHash: string): Promise<Block> {
    const blockInfo = await cardano.getBlock(blockHash);    
    const epoch = await this.indexEpoch(tx , blockInfo.epoch!);
    const blockEntity = mapBlock(blockInfo, epoch); 
    await tx.run(UPSERT.into(Block).entries(blockEntity));
    return blockEntity;
  }


   /**
   * Index spec. epoch information
   */
  async indexEpoch(tx: CapTransaction,epochNumber: Number): Promise<Epoch> {
    const epochInfo = await cardano.getEpoch(epochNumber);
    const epochEntity = mapEpoch(epochInfo);
    
    await tx.run(UPSERT.into(Epoch).entries([epochEntity]))
    return epochEntity;
  }

  async indexAccount(tx: CapTransaction, stakeAddress: string) {
    const accountInfo = await cardano.getAccount(stakeAddress);
    const accountEntity = mapAccount(accountInfo);
    
    await tx.run( UPSERT.into(Accounts).entries(accountEntity))
    
    return accountEntity;
  }
  
  async indexDrep(tx: CapTransaction, drepId: string)  {
    const drepInfo = await cardano.getDrep(drepId);
    const drepEntity = mapDrep(drepInfo);
    await tx.run( UPSERT.into(Dreps).entries(drepEntity));
    return drepEntity;
  }
  
  async indexPool(tx: CapTransaction, poolId: string)  {
    const poolInfo = await cardano.getPool(poolId);
    const poolEntity = mapPool(poolInfo);
   
      tx.run(UPSERT.into(Pools).entries(poolEntity))
    
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
    tx: CapTransaction,
    bech32List: string[]
  ): Promise<void> {
    for (const bech32 of bech32List) {
      await this.indexAddress(tx, bech32);
    }
  }
}

const cardanoIndexer = new CardanoIndexer();

export default cardanoIndexer;
