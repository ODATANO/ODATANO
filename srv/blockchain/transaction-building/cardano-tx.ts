import { TxBuildRequest,  TxBuildContext, TxBuildResult } from "../../utils/types";

/** 
 * CardanoTxBuilder - Interface Definition for multiple Cardano transaction builders (Buildooor, Lucid, Mesh, etc.)
 * Defines the standard methods that any Cardano transaction builder must implement to be used interchangeably.
 */
export interface CardanoTxBuilder {
  /** 
   * Builder name 
   */
  name: string;
  /** 
   * Initialize the builder 
   */
  init(): Promise<void>;

  /** 
   * Build unsigned ADA transfer transaction
   * @param req transaction build request
   * @param ctx transaction build context
   * @returns {Promise<TxBuildResult>} transaction build result
   */
  buildUnsignedAdaTransfer( req: TxBuildRequest, ctx: TxBuildContext): Promise<TxBuildResult>;

  /** 
   * Calculate minimum UTxO amount for given output
   * @param output transaction output
   * @param protocolParameters current protocol parameters
   * @returns {Promise<number>} minimum UTxO amount in lovelaces
   */
  calculateMinUtxoAmount(output: any, protocolParameters: any ): Promise<number>;

  /** 
   * Calculate transaction fee for given unsigned transaction
   * @param unsignedTxCbor unsigned transaction in CBOR hex format
   * @param protocolParameters current protocol parameters
   * @returns {Promise<number>} transaction fee in lovelaces
   */
  calculateTransactionFee( unsignedTxCbor: string, protocolParameters: any): Promise<number>;
}
