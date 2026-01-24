import cds from '@sap/cds';
import { getCardanoClient } from './cardano-client';
import type { UTxO } from '../utils/types';
import type { TxBuildRequest, TxBuildContext, TxBuildResult } from '../utils/types';
import { TxBuilderRegistry } from './transaction-building/tx-builder-registry';
import type { CardanoTxBuilder } from './transaction-building/cardano-tx';
import { LedgerProtocolParameter } from '#cds-models/CardanoODataService';

const logger = cds.log('CardanoTransactionBuilder');

/** 
 * CardanoTransactionBuilder - High-level transaction builder that utilizes specific CardanoTxBuilder implementations
 * to build various types of Cardano transactions.
 */
export class CardanoTransactionBuilder {
    private txBuilder: CardanoTxBuilder | undefined;
    private initialized = false;

    async init(): Promise<void> {
        if (this.initialized && this.txBuilder) return;
        // Create transaction builder from registry
        this.txBuilder = TxBuilderRegistry.createDefault();
        await this.txBuilder.init();
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
        if (!this.txBuilder) {
            throw new Error('Transaction builder failed to initialize');
        }
        return this.txBuilder;
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

        // Prepare the transaction build context
        const txContext: TxBuildContext = {
            utxos: await this._fetchUtxosForAddress(req.senderAddress),
            protocolParameters: protocolParameters
        };
        // Build the unsigned ADA transfer transaction
        const txBuildResult = await builder.buildUnsignedAdaTransfer(req, txContext);

        logger.info(`Built simple ADA transaction successfully.`);
        // Return the transaction build result
        return txBuildResult;
    }

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
        const builder = await this.ensureInitialized();

        // Prepare the transaction build context
        const utxos = await this._fetchUtxosForAddress(req.senderAddress);
        logger.info(`Fetched ${utxos.length} UTxOs for multi-asset transaction`);
        for (const u of utxos) {
            logger.info(`UTxO ${u.txHash}:${u.outputIndex} amounts: ${JSON.stringify(u.amount)}`);
        }
        const txContext: TxBuildContext = {
            utxos,
            protocolParameters: protocolParameters
        };
        // Build the unsigned multi-asset transaction
        const txBuildResult = await builder.buildUnsignedMultiAssetTransaction(req, txContext);

        logger.info(`Built multi-asset transaction successfully.`);
        // Return the transaction build result
        return txBuildResult;
    }

    /**
     * Build a minting transaction
     * @param req transaction build request
     * @param protocolParameters current protocol parameters
     * @returns {Promise<TxBuildResult>} transaction build result
     */
    async buildMintTransaction(req: TxBuildRequest, protocolParameters: LedgerProtocolParameter): Promise<TxBuildResult> {
        const builder = await this.ensureInitialized();

        const cardanoClient = getCardanoClient();

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
        const txBuildResult = await builder.buildUnsignedMintTransaction(req, txContext);

        logger.info(`Built minting transaction successfully.`);
        // Return the transaction build result
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
        const utxos = await getCardanoClient().getAddressUtxos(address);
        return utxos;
    }
}

/**
 * Singleton Cardano Transaction Builder instance
 */
const cardanoTransactionBuilder = new CardanoTransactionBuilder();

/**
 * Reset the transaction builder with a specific builder type
 * Similar to resetCardanoClient - takes builder name directly for test isolation
 * @param builderName - The builder name ('csl' or 'buildooor')
 */
export async function resetTransactionBuilder(builderName: string): Promise<void> {
    cardanoTransactionBuilder.reset();
    // Directly create and initialize the specified builder
    const txBuilder = TxBuilderRegistry.create(builderName);
    await txBuilder.init();
    // Set it using the public method
    cardanoTransactionBuilder.setBuilder(txBuilder);
    logger.info(`Transaction builder reset to: ${builderName}`);
}

export default cardanoTransactionBuilder;