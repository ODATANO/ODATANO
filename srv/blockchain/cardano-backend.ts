import {
  Transaction,
  Address,
  UTxO,
  Network,
  LatestBlock,
  LatestEpoch,
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
  getMetadataLabelTransactions(label: string | number): Promise<MetadataLabelTx[]>;
  getTransactionMetadata(txHash: string): Promise<MetadataLabelTx[]>;
  getLatestBlock(): Promise<LatestBlock>;
  getLatestEpoch(): Promise<LatestEpoch>;
}
