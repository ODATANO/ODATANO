import {
  Transaction,
  Address,
  UTxO,
  Network,
  LatestBlock,
  LatestEpoch,
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
  getNetworkInformation(): Promise<Network>;
  getMetadataLabels(): Promise<MetadataLabel[]>;
  getMetadataLabelTransactions(label: string | number): Promise<MetadataLabelTx[]>;
  getMetadataTransactions(txHash: string): Promise<MetadataLabelTx[]>;
  getLatestBlock(): Promise<LatestBlock>;
  getLatestEpoch(): Promise<LatestEpoch>;
}
