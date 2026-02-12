import cds from '@sap/cds';
import type { CardanoClient } from './cardano-client';
import type { UTxO } from '../utils/types';
import type { TxBuildRequest, TxBuildMintRequest, TxBuildPlutusSpendRequest, TxBuildContext, TxBuildResult, LedgerProtocolParameters } from '../utils/types';
import { TxBuilderRegistry } from './transaction-building/tx-builder-registry';
import type { CardanoTxBuilder } from './transaction-building/cardano-tx';
import { LedgerProtocolParameter } from '#cds-models/CardanoODataService';

const logger = cds.log('CardanoTransactionBuilder');

/**
 * CardanoTransactionBuilder - High-level transaction builder that utilizes specific CardanoTxBuilder implementations
 * to build various types of Cardano transactions.
 */
export class CardanoTransactionBuilder {
    private client: CardanoClient;
    private txBuilder: CardanoTxBuilder | undefined;
    private initialized = false;

    /**
     * Create a new CardanoTransactionBuilder instance
     * @param client - The CardanoClient instance for UTxO fetching
     */
    constructor(client: CardanoClient) {
        this.client = client;
        logger.info('CardanoTransactionBuilder instance created');
    }

    /**
     * Initialize the transaction builder
     * @param protocolParams - Optional protocol parameters (if not provided, fetched from backend)
     */
    async init(protocolParams?: LedgerProtocolParameters): Promise<void> {
        if (this.initialized && this.txBuilder) return;
        // create transaction builder from registry
        this.txBuilder = TxBuilderRegistry.createDefault();
        await this.txBuilder.init(this.client, protocolParams);
        this.initialized = true;
        logger.info(`Initialized with builder: ${this.txBuilder.name}`);
    }

    /**
     * Ensure the builder is initialized and return it (lazy init)
     * @returns {Promise<CardanoTxBuilder>} initialized builder
     * @throws {Error} if builder cannot be initialized
     */
    private async ensureInitialized(): Promise<CardanoTxBuilder> {
        if (!this.initialized || !this.txBuilder) {
            await this.init();
        }
        return this.txBuilder!;
    }

    /**
     * Reset the transaction builder (useful for testing)
     */
    reset(): void {
        this.txBuilder = undefined;
        this.initialized = false;
        logger.debug(`Builder reset`);
    }

    /**
     * Set the transaction builder directly (for testing)
     * @param builder - The builder to set
     */
    setBuilder(builder: CardanoTxBuilder): void {
        this.txBuilder = builder;
        this.initialized = true;
    }

    /**
     * Build a simple ADA transfer transaction
     * @param req transaction build request
     * @param protocolParameters current protocol parameters
     * @returns {Promise<TxBuildResult>} transaction build result
     */
    async buildSimpleAdaTransaction(req: TxBuildRequest, protocolParameters: LedgerProtocolParameter): Promise<TxBuildResult> {
        const builder = await this.ensureInitialized();

        // prepare the transaction build context
        const txContext: TxBuildContext = {
            utxos: await this._fetchUtxosForAddress(req.senderAddress),
            protocolParameters: protocolParameters
        };
        // Build the unsigned transfer transaction
        const txBuildResult = await builder.buildUnsignedTransfer(req, txContext);

        logger.info(`Built simple ADA transaction successfully.`);
        // Return the transaction build result
        return txBuildResult;
    }

    /**
     * Build a transaction with Metadata (for both simple and multi-asset transactions)
     * @param req transaction build request
     * @param protocolParameters current protocol parameters
     * @returns {Promise<TxBuildResult>} transaction build result
     */
    async buildTransactionWithMetadata(req: TxBuildRequest, protocolParameters: LedgerProtocolParameter): Promise<TxBuildResult> {
        const builder = await this.ensureInitialized();

        // Prepare the transaction build context
        const txContext: TxBuildContext = {
            utxos: await this._fetchUtxosForAddress(req.senderAddress),
            protocolParameters: protocolParameters
        };
        // Build the unsigned transaction with metadata
        const txBuildResult = await builder.buildUnsignedTransactionWithMetadata(req, txContext);
        logger.info(`Built transaction with metadata successfully.`);
        // Return the transaction build result
        return txBuildResult;
    }

    /** 
     * Build a multi-asset transaction
     * @param req transaction build request
     * @param protocolParameters current protocol parameters
     * @returns {Promise<TxBuildResult>} transaction build result
     */
    async buildMultiAssetTransaction(req: TxBuildRequest, protocolParameters: LedgerProtocolParameter): Promise<TxBuildResult> {
        if (!req.assets || req.assets.length === 0) {
            throw new Error('[CardanoTransactionBuilder] buildMultiAssetTransaction requires assets to be specified');
        }

        const builder = await this.ensureInitialized();

        // Prepare the transaction build context
        const txContext: TxBuildContext = {
            utxos: await this._fetchUtxosForAddress(req.senderAddress),
            protocolParameters: protocolParameters
        };
        // Build the unsigned transfer transaction (unified with simple ADA transfer)
        const txBuildResult = await builder.buildUnsignedTransfer(req, txContext);

        logger.info(`Built multi-asset transaction successfully.`);
        return txBuildResult;
    }

    /**
     * Build a minting transaction
     * @param req transaction build request
     * @param protocolParameters current protocol parameters
     * @returns {Promise<TxBuildResult>} transaction build result
     */
    async buildMintTransaction(req: TxBuildRequest, protocolParameters: LedgerProtocolParameter): Promise<TxBuildResult> {
        // Validate mint-specific required fields
        if (!req.mintActions || req.mintActions.length === 0) {
            throw new Error('[CardanoTransactionBuilder] buildMintTransaction requires mintActions to be specified');
        }
        if (!req.mintingPolicyScript) {
            throw new Error('[CardanoTransactionBuilder] buildMintTransaction requires mintingPolicyScript to be specified');
        }

        // Type is now narrowed to TxBuildMintRequest
        const mintReq: TxBuildMintRequest = req as TxBuildMintRequest;

        const builder = await this.ensureInitialized();
        const cardanoClient = this.client;

        // Prepare the transaction build context
        const txContext: TxBuildContext = {
            utxos: await this._fetchUtxosForAddress(req.senderAddress),
            protocolParameters: protocolParameters,
            // Pass evaluator if Ogmios is available for dynamic execution unit calculation
            evaluateTransaction: cardanoClient.hasOgmiosBackend()
                ? (cbor) => cardanoClient.evaluateTransaction(cbor)
                : undefined
        };

        if (txContext.evaluateTransaction) {
            logger.info(`Ogmios available - will use dynamic script evaluation`);
        } else {
            logger.info(`Ogmios not available - using default execution units`);
        }

        // Build the unsigned minting transaction
        const txBuildResult = await builder.buildUnsignedMintTransaction(mintReq, txContext);

        logger.info(`Built minting transaction successfully.`);
        // Return the transaction build result
        return txBuildResult;
    }

    /**
     * Build a Plutus spending transaction (consume UTxO at script address)
     * @param req transaction build request
     * @param protocolParameters current protocol parameters
     * @returns {Promise<TxBuildResult>} transaction build result
     */
    async buildPlutusSpendTransaction(req: TxBuildRequest, protocolParameters: LedgerProtocolParameter): Promise<TxBuildResult> {
        if (!req.plutusScriptExecution) {
            throw new Error('[CardanoTransactionBuilder] buildPlutusSpendTransaction requires plutusScriptExecution to be specified');
        }

        const spendReq: TxBuildPlutusSpendRequest = req as TxBuildPlutusSpendRequest;

        const builder = await this.ensureInitialized();
        const cardanoClient = this.client;

        // Fetch sender UTxOs for fee payment
        const senderUtxos = await this._fetchUtxosForAddress(req.senderAddress);

        // Fetch the script UTxO separately (it's at the script address, not sender address)
        // We include it in the UTxO set so the builder can find it
        const scriptRef = spendReq.plutusScriptExecution.scriptUtxo;
        const allUtxos = [...senderUtxos];

        // Check if the script UTxO is already in sender UTxOs (unlikely but possible)
        const alreadyIncluded = senderUtxos.some(
            u => u.txHash === scriptRef.txHash && u.outputIndex === scriptRef.outputIndex
        );

        if (!alreadyIncluded) {
            // Fetch script UTxO via transaction lookup - the backend needs to provide it
            // For now, we create a minimal UTxO entry from what we know
            // The actual UTxO data will be resolved by the backend during tx building
            logger.info(`Script UTxO ${scriptRef.txHash}#${scriptRef.outputIndex} not in sender UTxOs - fetching from backend`);
            const tx = await cardanoClient.getTransaction(scriptRef.txHash);
            const scriptOutput = tx.outputs?.find(o => o.outputIndex === scriptRef.outputIndex);
            if (!scriptOutput) {
                throw new Error(`[CardanoTransactionBuilder] Script UTxO output ${scriptRef.txHash}#${scriptRef.outputIndex} not found in transaction`);
            }
            allUtxos.push({
                txHash: scriptRef.txHash,
                outputIndex: scriptRef.outputIndex,
                address: scriptOutput.address,
                amount: scriptOutput.amount,
                inlineDatum: scriptOutput.inlineDatum,
            });
        }

        const txContext: TxBuildContext = {
            utxos: allUtxos,
            protocolParameters: protocolParameters,
            evaluateTransaction: cardanoClient.hasOgmiosBackend()
                ? (cbor) => cardanoClient.evaluateTransaction(cbor)
                : undefined
        };

        if (txContext.evaluateTransaction) {
            logger.info(`Ogmios available - will use dynamic script evaluation`);
        } else {
            logger.info(`Ogmios not available - using default execution units`);
        }

        const txBuildResult = await builder.buildUnsignedPlutusSpendTransaction(spendReq, txContext);

        logger.info(`Built Plutus spending transaction successfully.`);
        return txBuildResult;
    }

    /**
     * Fetch UTxOs for a given address
     * @param address bech32 address
     * @returns {Promise<UTxO[]>} list of UTxOs
     */
    private async _fetchUtxosForAddress(address: string): Promise<UTxO[]> {
        // fetch UTxOs directly using cardano client
        logger.debug(`Fetching UTxOs for address: ${address}`);
        const utxos = await this.client.getAddressUtxos(address);
        return utxos;
    }
}