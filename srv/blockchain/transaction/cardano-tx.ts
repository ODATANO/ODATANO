import { TxBuildRequest,  TxBuildContext, TxBuildResult } from "../../utils/types";

export interface CardanoTxBuilder {
  name: string;
  init(): Promise<void>;

  buildUnsignedAdaTransfer(
    req: TxBuildRequest,
    ctx: TxBuildContext
  ): Promise<TxBuildResult>;
  calculateMinUtxoAmount(
    output: any, // TODO Define a proper type for output
    protocolParameters: any // TODO Define a proper type for protocol parameters
  ): Promise<number>;
  calculateTransactionFee(
    unsignedTxCbor: string,
    protocolParameters: any // TODO Define a proper type for protocol parameters
  ): Promise<number>;
}
