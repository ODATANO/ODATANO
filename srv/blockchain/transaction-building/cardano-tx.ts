import { TxBuildRequest, TxBuildMintRequest, TxBuildPlutusSpendRequest, TxBuildContext, TxBuildResult, LedgerProtocolParameters } from "../../utils/types";
import { CardanoClient } from "../cardano-client";

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
   * @param client - The CardanoClient instance
   * @param protocolParams - Optional protocol parameters (if not provided, fetched from backend)
   */
  init(client: CardanoClient, protocolParams?: LedgerProtocolParameters): Promise<void>;

  /**
   * Build unsigned transfer transaction (ADA-only or with native assets)
   * @param req transaction build request
   * @param ctx transaction build context
   * @returns {Promise<TxBuildResult>} transaction build result
   */
  buildUnsignedTransfer(req: TxBuildRequest, ctx: TxBuildContext): Promise<TxBuildResult>;

  /**
   * Build unsigned transaction with metadata
   * @param req transaction build request
   * @param ctx transaction build context
   * @returns {Promise<TxBuildResult>} transaction build result
   */
  buildUnsignedTransactionWithMetadata(req: TxBuildRequest, ctx: TxBuildContext): Promise<TxBuildResult>;

  /**
   * Build unsigned Plutus SC transaction
   * @param req transaction build request
   * @param ctx transaction build context
   * @returns {Promise<TxBuildResult>} transaction build result
   */
  buildUnsignedMintTransaction(req: TxBuildMintRequest, ctx: TxBuildContext): Promise<TxBuildResult>;

  /**
   * Build unsigned Plutus spending transaction (consume UTxO at script address)
   * @param req transaction build request with plutusScriptExecution
   * @param ctx transaction build context
   * @returns {Promise<TxBuildResult>} transaction build result
   */
  buildUnsignedPlutusSpendTransaction(req: TxBuildPlutusSpendRequest, ctx: TxBuildContext): Promise<TxBuildResult>;
}
