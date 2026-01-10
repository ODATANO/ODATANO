import cardano from './cardano-client';
import type { UTxO } from '../utils/types';
import type {TxBuildRequest, TxBuildContext, TxBuildResult } from '../utils/types';
import { BuildooorTxBuilder } from './transaction-building/buildooor-tx';
import type { CardanoTxBuilder } from './transaction-building/cardano-tx';
import { LedgerProtocolParameter } from '#cds-models/CardanoODataService';
import logger from '../utils/logger';

/** 
 * CardanoTransactionBuilder - High-level transaction builder that utilizes specific CardanoTxBuilder implementations
 * to build various types of Cardano transactions.
 */
export class CardanoTransactionBuilder {
    
    /** 
     * Build a simple ADA transfer transaction
     * @param req transaction build request
     * @param protocolParameters current protocol parameters
     * @returns {Promise<TxBuildResult>} transaction build result
     */
    async buildSimpleAdaTransaction(req: TxBuildRequest, protocolParameters: LedgerProtocolParameter): Promise<TxBuildResult> {
        // Initialize the specific transaction builder (Buildooor in this case)
        const txBuilder: CardanoTxBuilder = new BuildooorTxBuilder();
        
        // Initialize the builder
        await txBuilder.init();

        // Prepare the transaction build context
        const txContext: TxBuildContext = {
            utxos: await this._fetchUtxosForAddress(req.senderAddress),
            protocolParameters: protocolParameters
        };
        // Build the unsigned ADA transfer transaction
        const txBuildResult = await txBuilder.buildUnsignedAdaTransfer(req, txContext);

        logger.info(`[CardanoTransactionBuilder] Built simple ADA transaction successfully.`);
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
        logger.debug(`[CardanoTransactionBuilder] Fetching UTxOs for address: ${address}`);
        const utxos = await cardano.getAddressUtxos(address);
        return utxos;
    }
}

/** 
 * Singleton Cardano Transaction Builder instance 
 */
const cardanoTransactionBuilder = new CardanoTransactionBuilder();
export default cardanoTransactionBuilder;