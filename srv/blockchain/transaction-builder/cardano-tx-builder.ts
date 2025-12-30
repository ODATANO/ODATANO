import type { UTxO as OdatanoUtxo} from '../../utils/types';
import { defaultProtocolParameters } from "@harmoniclabs/cardano-ledger-ts";


export type LedgerProtocolParameters = typeof defaultProtocolParameters;

export type TxBuildRequest = {
  network: 'mainnet' | 'preprod' | 'preview';

  senderAddress: string;
  changeAddress?: string;
  feeLovelace?: string;

  recipients: Array<{
    address: string;
    lovelace: string; 
  }>;

  metadata?: {
    label: string;     
    json: unknown;     
  };

  validity?: {
    invalidBefore?: number;
    invalidHereafter?: number;
  };
};

export type TxBuildContext = {
  utxos: OdatanoUtxo[];
   protocolParameters: LedgerProtocolParameters;
};

export type TxBuildResult = {
  unsignedTxCbor: string;
  feeLovelace: string;

  inputs: Array<{ txHash: string; index: number; lovelace: string }>;
  outputs: Array<{ address: string; lovelace: string }>;
  changeOutput?: { address: string; lovelace: string };

  warnings: string[];
};

export interface CardanoTxBuilder {
  name: string;
  init(): Promise<void>;

  buildUnsignedAdaTransfer(
    req: TxBuildRequest,
    ctx: TxBuildContext
  ): Promise<TxBuildResult>;
}
