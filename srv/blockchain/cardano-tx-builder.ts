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
    private txBuilder!: CardanoTxBuilder;

    async init(): Promise<void> {
        // Create transaction builder from registry
        this.txBuilder = TxBuilderRegistry.createDefault();
        await this.txBuilder.init();
        logger.info(`Initialized with builder: ${this.txBuilder.name}`);
    }

    /** 
     * Reset the transaction builder (useful for testing)
     */
    reset(): void {
        this.txBuilder = undefined as any;
        logger.debug(`Builder reset`);
    }

    /** 
     * Build a simple ADA transfer transaction
     * @param req transaction build request
     * @param protocolParameters current protocol parameters
     * @returns {Promise<TxBuildResult>} transaction build result
     */
    async buildSimpleAdaTransaction(req: TxBuildRequest, protocolParameters: LedgerProtocolParameter): Promise<TxBuildResult> {

        // Prepare the transaction build context
        const txContext: TxBuildContext = {
            utxos: await this._fetchUtxosForAddress(req.senderAddress),
            protocolParameters: protocolParameters
        };
        // Build the unsigned ADA transfer transaction
        const txBuildResult = await this.txBuilder.buildUnsignedAdaTransfer(req, txContext);

        logger.info(`Built simple ADA transaction successfully.`);
        // Return the transaction build result
        return txBuildResult;
    }

    async buildTransactionWithMetadata(req: TxBuildRequest, protocolParameters: LedgerProtocolParameter): Promise<TxBuildResult> {

        // Prepare the transaction build context
        const txContext: TxBuildContext = {
            utxos: await this._fetchUtxosForAddress(req.senderAddress),
            protocolParameters: protocolParameters
        };
        // Build the unsigned transaction with metadata
        const txBuildResult = await this.txBuilder.buildUnsignedTransactionWithMetadata(req, txContext);
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
        const txBuildResult = await this.txBuilder.buildUnsignedMultiAssetTransaction(req, txContext);

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

        // Prepare the transaction build context
        const txContext: TxBuildContext = {
            utxos: await this._fetchUtxosForAddress(req.senderAddress),
            protocolParameters: protocolParameters
        };
        // Build the unsigned minting transaction
        const txBuildResult = await this.txBuilder.buildUnsignedMintTransaction(req, txContext);

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
    // Set it directly on the instance
    (cardanoTransactionBuilder as any).txBuilder = txBuilder;
    logger.info(`Transaction builder reset to: ${builderName}`);
}

export default cardanoTransactionBuilder;