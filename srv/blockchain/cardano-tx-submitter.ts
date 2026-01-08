import cardano from './cardano-client';

/** 
 * CardanoTransactionSubmitter - Handles submission of signed transactions to the Cardano network 
 */
export class CardanoTransactionSubmitter {
  
  /** 
   * Submit a signed transaction to the Cardano network
   * @param txCborHex signed transaction in CBOR hex format
   * @returns {Promise<string>} transaction hash
   */
  async submitTransaction(txCborHex: string): Promise<string> {
    const txHash = await cardano.submitTransaction(txCborHex);
    return txHash;
  }
}

/** 
 * Singleton Cardano Transaction Submitter instance 
 */
const cardanoTransactionSubmitter = new CardanoTransactionSubmitter();
export default cardanoTransactionSubmitter;
