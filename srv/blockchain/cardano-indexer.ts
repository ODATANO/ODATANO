import cds from '@sap/cds';
import type { Transaction as CapTransaction } from '@sap/cds';
import cardano from './cardano-client';
import logger from '../utils/logger';
import cardanoTransactionBuilder from './cardano-tx-builder';

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
  Account,
  Drep,
  Pool,
  Address,
  LedgerProtocolParameter,
} from '#cds-models/CardanoODataService';

import {
  TransactionBuild,
  TransactionBuildInputs,
  TransactionBuildOutputs,
  TransactionSubmission
} from '#cds-models/CardanoTransactionService';

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
  mapAddressUtxoAssets,
  mapBuildResult,
  mapBuildInputs,
  mapBuildOutputs,
  mapProtocolParameters,
  mapTransactionSubmission
} from '../utils/mappers';

import { Transaction as TransactionProviderData, TxBuildRequest } from '../utils/types';

const { UPSERT } = cds.ql;

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

  /** 
   * Index & return a single transaction with inputs/outputs/assets/UTxOs/addresses
   * @param tx      CAP transaction (cds.tx(req))
   * @param txHash  Cardano transaction hash (hex)
   * @returns {Promise<CardanoTransaction>} transaction entity data
   */
  async indexTransaction(tx: CapTransaction, txHash: string,): Promise<CardanoTransaction> {
    // getting data from cardano data provider
    const providerTx = await cardano.getTransaction(txHash);
    const txRow = mapTransaction(providerTx);

    tx.run(UPSERT.into(Transactions).entries(txRow))

    if (providerTx.inputs) {
      const addresses = this._collectAddressesFromUtxos(providerTx);
      if (addresses.length) {
        await this._ensureAddresses(tx, addresses);
      }

      // Inputs + InputAssets
      const inputRows = mapTransactionInputs(txHash, providerTx.inputs);
      const inputAssetRows = mapTransactionInputAssets(txHash, providerTx.inputs);

      if (inputRows.length) {

        tx.run(UPSERT.into(TransactionInputs).entries(inputRows))

      }

      if (inputAssetRows.length) {

        tx.run(UPSERT.into(TransactionInputAssets).entries(inputAssetRows))
      }

      // Outputs + OutputAssets
      const outputRows = mapTransactionOutputs(txHash, providerTx.outputs);
      const outputAssetRows = mapTransactionOutputAssets(txHash, providerTx.outputs);

      if (outputRows.length) {

        tx.run(UPSERT.into(TransactionOutputs).entries(outputRows))

      }

      if (outputAssetRows.length) {
        tx.run(UPSERT.into(TransactionOutputAssets).entries(outputAssetRows))
      }
    }
    const metadataRows = mapTransactionMetadata(providerTx.metadata || []);

    if (metadataRows.length) {
      tx.run(UPSERT.into(TransactionMetadata).entries(metadataRows))
    }
    return txRow;
  }

  /** 
   * Index & return address data with assets and UTxOs
   * @param tx       CAP transaction
   * @param addr     bech32 address
   * @return {Promise<Address>} address entity data
   */
  async indexAddress(tx: CapTransaction, addr: string): Promise<Address> {
    const addrData = await cardano.getAddress(addr);

    logger.debug({ addrData }, 'indexAddress: provider response');

    const AddrEntity = mapAddress(addr, addrData);

    tx.run(UPSERT.into(Addresses).entries(AddrEntity))

    const assetEntities = mapAddressAssets(
      addr,
      AddrEntity.validFrom ?? new Date().toISOString(),
      AddrEntity.validTo ?? new Date().toISOString(),
      addrData.amount
    );

    logger.debug({ assetEntities }, 'indexAddress: asset entities');

    if (assetEntities.length > 0) {
      tx.run(UPSERT.into(AddressAssets).entries(assetEntities))
    }

    const utxoData = await cardano.getAddressUtxos(addr);

    const utxoEntities = mapAddressUtxos(
      addr,
      AddrEntity.validFrom ?? new Date().toISOString(),
      AddrEntity.validTo ?? new Date().toISOString(),
      utxoData
    );

    logger.debug({ utxoEntities }, 'indexAddress: utxo entities');

    if (utxoEntities.length) {
      tx.run(UPSERT.into(AddressUTxOs).entries(utxoEntities))
    }

    const utxoAssetEntities = mapAddressUtxoAssets(
      utxoData,
      AddrEntity.validFrom ?? new Date().toISOString(),
      AddrEntity.validTo ?? new Date().toISOString()
    );
    logger.debug({ utxoAssetEntities }, 'indexAddress: utxo asset entities');

    if (utxoAssetEntities.length) {
      tx.run(UPSERT.into(UTxOAssets).entries(utxoAssetEntities))
    }

    return AddrEntity;
  }

  /** 
   * Index & return metadata for a single transaction (Metadata)
   * @param tx       CAP transaction
   * @param txHash   transaction hash
   * @param metadata raw metadata object (label -> JSONValue)
   * @return {Promise<TransactionMetadata[]>} array of transaction metadata rows  
   */
  async indexTransactionMetadata(tx: CapTransaction, tx_hash: string): Promise<TransactionMetadata[]> {
    const metadata = await cardano.getTransactionMetadata(tx_hash);
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
    const netInfo = await cardano.getNetworkInformation();
    const netEntity = mapNetworkInfo(netInfo);

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
    const blockInfo = await cardano.getBlock(blockHash);
    const epoch = await this.indexEpoch(tx, blockInfo.epoch!);
    const blockEntity = mapBlock(blockInfo, epoch);
    await tx.run(UPSERT.into(Block).entries(blockEntity));
    return blockEntity;
  }

  /** 
   * Index & return the epoch information data
   * @param tx CAP transaction object
   * @param epochNumber epoch number
   * @returns {Promise<Epoch>} epoch entity data
   */
  async indexEpoch(tx: CapTransaction, epochNumber: number): Promise<Epoch> {
    const epochInfo = await cardano.getEpoch(epochNumber);
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
    const accountInfo = await cardano.getAccount(stakeAddress);
    const accountEntity = mapAccount(accountInfo);

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
    const drepInfo = await cardano.getDrep(drepId);
    const drepEntity = mapDrep(drepInfo);
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
    const poolInfo = await cardano.getPool(poolId);
    const poolEntity = mapPool(poolInfo);

    tx.run(UPSERT.into(Pools).entries(poolEntity))

    return poolEntity;
  }

  /** 
   * Index & return the transaction build result data
   * @param tx CAP transaction object
   * @param buildreq transaction build request data
   * @returns {Promise<TransactionBuild>} transaction build entity data
   */
  async indexBuildResult(tx: CapTransaction, buildreq: TxBuildRequest): Promise<TransactionBuild> {

    // make sure we have protocol parameters indexed
    const protocolParams = await this.indexProtocolParameters(tx);

    const txbuildResult = await cardanoTransactionBuilder.buildSimpleAdaTransaction(
      buildreq,
      protocolParams);

    const buildResult = mapBuildResult(txbuildResult);

    await tx.run(UPSERT.into(TransactionBuild).entries(buildResult));

    // Store inputs if available
    if (buildResult.id && txbuildResult.inputs && txbuildResult.inputs.length > 0) {
      const inputRows = mapBuildInputs(buildResult.id, txbuildResult.inputs);
      await tx.run(UPSERT.into(TransactionBuildInputs).entries(inputRows));
    }

    // Store outputs if available
    if (buildResult.id && txbuildResult.outputs && txbuildResult.outputs.length > 0) {
      const outputRows = mapBuildOutputs(buildResult.id, txbuildResult.outputs, buildreq.changeAddress || buildreq.senderAddress);
      await tx.run(UPSERT.into(TransactionBuildOutputs).entries(outputRows));
    }

    return buildResult;
  }

  /** 
   * Index & return the protocol parameters data
   * @param tx CAP transaction object
   * @returns {Promise<LedgerProtocolParameter>} protocol parameters entity data
   */
  async indexProtocolParameters(tx: CapTransaction): Promise<LedgerProtocolParameter> {
    // first, check if we have recent protocol parameters
    const existing = await tx.run(SELECT.one.from(LedgerProtocolParameter));

    if (existing) return existing;
    // otherwise, fetch new protocol parameters from provider
    const protocolParamsInfo = await cardano.getProtocolParameters();
    // map to protocol parameter row
    const protocolParams = mapProtocolParameters(protocolParamsInfo);
    // store in DB for future use
    await tx.run(UPSERT.into(LedgerProtocolParameter).entries(protocolParams));

    return protocolParams;
  }

  /** 
   * Index & return the transaction submission record
   * @param signedTxCbor signed transaction in CBOR format (hex)
   * @param txHash transaction hash (hex)
   * @returns {Promise<TransactionSubmissionRow>} transaction submission entity data
   */
  async indexTransactionSubmission(signedTxCbor: string, txHash: string): Promise<TransactionSubmission> {
    const transactionSubmission = mapTransactionSubmission(signedTxCbor, txHash);
    // return submission record without persisting (caller will persist it)
    return transactionSubmission;
  }

  /** 
   * Index & return the latest epoch information data
   * @param tx CAP transaction object
   * @returns {Promise<Epoch>} epoch entity data
   */
  async indexLatestEpoch(tx: CapTransaction): Promise<Epoch> {
    const epochInfo = await cardano.getLatestEpoch();

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

    const blockInfo = await cardano.getLatestBlock();
    const epoch = await this.indexEpoch(tx, blockInfo.epoch!);
    const blockEntity = mapBlock(blockInfo, epoch);

    await tx.run(UPSERT.into(Block).entries(blockEntity));
    return blockEntity;
  }

  //-----------------------------------------------------------------------------
  // Private Helpers
  //-----------------------------------------------------------------------------

  /** 
   * Collect all unique addresses from UTxOs in transaction data
   * @param txUtxos transaction data with UTxOs
   * @returns {string[]} array of unique bech32 addresses
   */
  private _collectAddressesFromUtxos(txUtxos: TransactionProviderData): string[] {
    const set = new Set<string>();

    const inputs = txUtxos.inputs;
    const outputs = txUtxos.outputs;

    for (const i of inputs) {
      if (i.address) set.add(i.address);
    }
    for (const o of outputs) {
      if (o.address) set.add(o.address);
    }

    return Array.from(set);
  }

  /** 
   * Index multiple addresses with assets
   * @param tx CAP transaction object
   * @param bech32List array of bech32 addresses
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

/**
 * Singleton Cardano Indexer instance 
 */
const cardanoIndexer = new CardanoIndexer();
export default cardanoIndexer;
