import {
  Transaction,
  Address,
  UTxO,
  Network,
  BlockData,
  EpochData,
  MetadataLabelTx,
  PoolData, 
  DrepData, 
  AccountData,
  LedgerProtocolParameters
} from '../../utils/types';

export interface CardanoBackend {
  name: string;
  init(): Promise<void>;
  getTransaction(txHash: string): Promise<Transaction>;
  getAddress(address: string): Promise<Address>;
  getAddressUtxos(address: string): Promise<UTxO[]>;
  getNetworkInformation(): Promise<Network>;
  getTransactionMetadata(txHash: string): Promise<MetadataLabelTx[]>;
  getBlock(blockHash: string): Promise<BlockData>;
  getEpoch(epochNumber: Number): Promise<EpochData>;
  getlatestEpoch(): Promise<EpochData>;
  getlatestBlock(): Promise<BlockData>;
  getPool(poolId: string): Promise<PoolData>;
  getDrep(drepId: string): Promise<DrepData>;
  getAccount(accountId: string): Promise<AccountData>;
  submitTransaction(signedTxCbor: string): Promise<string>;
  getProtocolParameters(): Promise<LedgerProtocolParameters>;
}
