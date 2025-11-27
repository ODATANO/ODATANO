export interface CardanoBackend {
  name: string;

  init(): Promise<void>;

  getTransaction(txHash: string): Promise<unknown>;

  getAddress(address: string): Promise<unknown>;

  getAddressUtxos(address: string): Promise<unknown[]>;

  getNetworkInformation(): Promise<unknown>;

  getMetadataLabels(): Promise<unknown[]>;

  getMetadataLabelTransactions(label: string | number): Promise<unknown[]>;
}
