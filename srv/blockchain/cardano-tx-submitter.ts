import cardano from './cardano-client';

export class CardanoTransactionSubmitter {
  
/**
 * Submit a signed transaction to the Cardano network
 */
  async submitTransaction(txCborHex: string): Promise<string> {
    // submit the transaction to the Cardano network
    const txHash = await cardano.submitTransaction(txCborHex);
    return txHash;
  }

}

