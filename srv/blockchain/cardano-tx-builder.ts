import cardano from './cardano-client';
import type { UTxO } from '../utils/types';
import type {TxBuildRequest, TxBuildContext, TxBuildResult } from '../utils/types';
import { BuildooorTxBuilder } from './transaction/buildooor-tx';
import type { CardanoTxBuilder } from './transaction/cardano-tx';
import { LedgerProtocolParameter } from '#cds-models/CardanoTransactionService';


export class CardanoTransactionBuilder {
    
    async buildSimpleAdaTransaction(req: TxBuildRequest, protocolParameters: LedgerProtocolParameter): Promise<TxBuildResult> {
        
        const txBuilder: CardanoTxBuilder = new BuildooorTxBuilder(); // add or change other builders as needed (maybe with fallback?)
        
        await txBuilder.init();

        const txContext: TxBuildContext = {
            utxos: await this._fetchUtxosForAddress(req.senderAddress),
            protocolParameters: protocolParameters
        };

        const txBuildResult = await txBuilder.buildUnsignedAdaTransfer(req, txContext);

        return txBuildResult;
    }

    private async _fetchUtxosForAddress(address: string): Promise<UTxO[]> {
        // Fetch UTxOs from Cardano indexer or node for the given address
        const utxos = await cardano.getAddressUtxos(address);
        return utxos;
    }
}

const cardanoTransactionBuilder = new CardanoTransactionBuilder();

export default cardanoTransactionBuilder;