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
  Account,
  Drep,
  Pool,
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
  SigningRequests,
  SignatureVerifications,
  AddressSigningRequests,
  AddressTransactionBuilds
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
  mapTransactionSubmission,
  mapAddressTransactions,
  mapAddressSigningRequest,
  mapAddressTransactionBuild
} from '../utils/mappers';

import { TxBuildRequest } from '../utils/types';

const { UPSERT, INSERT, UPDATE, SELECT } = cds.ql;

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

      // Outputs + OutputAssets
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

    logger.debug(`indexAddress: provider response for address ${addr}`);
    logger.debug({ addrData }, 'indexAddress: provider response');

    const AddrEntity = mapAddress(addr, addrData, this.client.max_age_ms);

    await tx.run(UPSERT.into(Addresses).entries(AddrEntity));

    // Also insert child entities for new address
    const assetEntities = mapAddressAssets(
      addr,
      AddrEntity.validFrom ?? new Date().toISOString(),
      AddrEntity.validTo ?? new Date().toISOString(),
      addrData.amount
    );

    logger.debug({ assetEntities }, 'indexAddress: asset entities');

    if (assetEntities.length > 0) {
      await tx.run(UPSERT.into(AddressAssets).entries(assetEntities));
    }

    // UTxOs are included in getAddress response
    const utxoEntities = mapAddressUtxos(
      addr,
      AddrEntity.validFrom ?? new Date().toISOString(),
      AddrEntity.validTo ?? new Date().toISOString(),
      addrData.utxos
    );

    logger.debug({ utxoEntities }, 'indexAddress: utxo entities');

    if (utxoEntities.length) {
      await tx.run(UPSERT.into(AddressUTxOs).entries(utxoEntities));
    }

    const utxoAssetEntities = mapAddressUtxoAssets(
      addrData.utxos,
      AddrEntity.validFrom ?? new Date().toISOString(),
      AddrEntity.validTo ?? new Date().toISOString()
    );
    logger.debug({ utxoAssetEntities }, 'indexAddress: utxo asset entities');

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

      try {
        await this.indexAddressTransactions(tx, addr, 10);
      } catch (err) {
        logger.error(`indexAddressTransactions failed for address ${addr}: ${(err as Error).message}`);
      }
    }
    return AddrEntity;
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

    // Fetch transactions for this address
    const transactions = await this.client.getAddressTransactions(addr, limit);

    logger.debug(`indexAddressTransactions: found ${transactions.length} transactions for ${addr}`);

    // Index each transaction
    for (const txData of transactions) {
      await this.indexTransaction(tx, txData.hash);
    }

    // Create address-transaction mapping entries
    const now = new Date().toISOString();
    const validTo = new Date(Date.now() + 600000).toISOString(); // 10 min TTL

    const transactionsEntities = mapAddressTransactions(
      addr,
      transactions,
      now,
      validTo
    );

    logger.debug({ count: transactionsEntities.length }, 'indexAddressTransactions: transaction entities');

    if (transactionsEntities.length) {
      await tx.run(UPSERT.into(AddressTransactions).entries(transactionsEntities));
    }

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
    const poolInfo = await this.client.getPool(poolId);
    const poolEntity = mapPool(poolInfo);

    await tx.run(UPSERT.into(Pools).entries(poolEntity))

    return poolEntity;
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
    buildFn: (req: TxBuildRequest, params: LedgerProtocolParameter) => Promise<any>
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
    const protocolParamsInfo = await this.client.getProtocolParameters();
    // map to protocol parameter row
    const protocolParams = mapProtocolParameters(protocolParamsInfo);
    // store in DB for future use
    await tx.run(UPSERT.into(LedgerProtocolParameter).entries(protocolParams));

    return protocolParams;
  }

  /**
   * Index & return the transaction submission record (without persistence)
   * @param signedTxCbor signed transaction in CBOR format (hex)
   * @param txHash transaction hash (hex)
   * @returns {Promise<TransactionSubmissionRow>} transaction submission entity data
   * @deprecated Use persistTransactionSubmission instead
   */
  async indexTransactionSubmission(signedTxCbor: string, txHash: string): Promise<TransactionSubmission> {
    const transactionSubmission = mapTransactionSubmission(signedTxCbor, txHash);
    return transactionSubmission;
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

    // Create submission record
    const submissionRecord = {
      ...indexSubmission,
      build_id: buildId || null,
      backendResponse: 'Submitted successfully',
      status: 'submitted',
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
      status: 'submitted',
    };
    await tx.run(INSERT.into(TransactionSubmissions).entries(submissionRecord));
    logger.debug({ submissionId: submissionRecord.id }, 'Persisted submission record');

    // Step 3: Update signing request status
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
    const epoch = await this.indexEpoch(tx, blockInfo.epoch!);
    const blockEntity = mapBlock(blockInfo, epoch);

    await tx.run(UPSERT.into(Block).entries(blockEntity));
    return blockEntity;
  }

  //-----------------------------------------------------------------------------
  // Private Helpers
  //-----------------------------------------------------------------------------

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
