import {
  Transaction,
  Address,
  UTxO,
  NetworkInfo,
  MetadataLabel,
  MetadataLabelTx
} from '../utils/types';

export interface CardanoBackend {
  name: string;
  init(): Promise<void>;
  healthCheck(): Promise<boolean>;
  getTransaction(txHash: string): Promise<Transaction>;
  getAddress(address: string): Promise<Address>;
  getAddressUtxos(address: string): Promise<UTxO[]>;
  getNetworkInformation(): Promise<NetworkInfo>;
  getMetadataLabels(): Promise<MetadataLabel[]>;
  getMetadataLabelTransactions(label: string | number): Promise<MetadataLabelTx[]>;
}
