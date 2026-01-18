import { TxBuildRequest, TxBuildContext, TxBuildResult } from "../../utils/types";

/** 
 * CardanoTxBuilder - Interface Definition for multiple Cardano transaction builders (Buildooor, CSL, etc.)
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
  buildUnsignedAdaTransfer(req: TxBuildRequest, ctx: TxBuildContext): Promise<TxBuildResult>;

  /** 
   * Build unsigned transaction with metadata
   * @param req transaction build request
   * @param ctx transaction build context
   * @returns {Promise<TxBuildResult>} transaction build result
   */
  buildUnsignedTransactionWithMetadata(req: TxBuildRequest, ctx: TxBuildContext): Promise<TxBuildResult>;

  /** 
   * Build unsigned multi-asset transaction
   * @param req transaction build request
   * @param ctx transaction build context
   * @returns {Promise<TxBuildResult>} transaction build result
   */
  buildUnsignedMultiAssetTransaction(req: TxBuildRequest, ctx: TxBuildContext): Promise<TxBuildResult>;

  /** 
   * Build unsigned Plutus SC transaction
   * @param req transaction build request
   * @param ctx transaction build context
   * @returns {Promise<TxBuildResult>} transaction build result
   */
  buildUnsignedPlutusTransaction(req: TxBuildRequest, ctx: TxBuildContext): Promise<TxBuildResult>;
}
