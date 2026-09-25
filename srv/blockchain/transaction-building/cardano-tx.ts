import { TxBuildRequest, TxBuildMintRequest, TxBuildPlutusSpendRequest, TxBuildContext, TxBuildResult, LedgerProtocolParameters } from "../../utils/types";
import { CardanoClient } from "../cardano-client";

/** Interface for the Cardano transaction builder (Buildooor). */
export interface CardanoTxBuilder {
  /** Builder name */
  name: string;
  /**
   * Initialize the builder.
   * @param protocolParams - optional; fetched from the backend when omitted
   */
  init(client: CardanoClient, protocolParams?: LedgerProtocolParameters): Promise<void>;

  /** Build an unsigned transfer transaction (ADA-only or with native assets). */
  buildUnsignedTransfer(req: TxBuildRequest, ctx: TxBuildContext): Promise<TxBuildResult>;

  /** Build an unsigned transaction with attached metadata. */
  buildUnsignedTransactionWithMetadata(req: TxBuildRequest, ctx: TxBuildContext): Promise<TxBuildResult>;

  /** Build an unsigned Plutus mint transaction. */
  buildUnsignedMintTransaction(req: TxBuildMintRequest, ctx: TxBuildContext): Promise<TxBuildResult>;

  /** Build an unsigned Plutus spending transaction (consume a UTxO at a script address). */
  buildUnsignedPlutusSpendTransaction(req: TxBuildPlutusSpendRequest, ctx: TxBuildContext): Promise<TxBuildResult>;
}
