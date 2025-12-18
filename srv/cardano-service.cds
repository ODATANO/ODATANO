using {odatano.cardano} from '../db/schema';

service CardanoODataService @(impl: 'srv/cardano-service') {
    // ---------------------------------------------------------------------------
    // Entity Projections
    // ---------------------------------------------------------------------------
    // general network informations
    entity NetworkInformation      as projection on cardano.NetworkInformation;
    entity Blocks                  as projection on cardano.Blocks;
    entity Epochs                  as projection on cardano.Epochs;
    entity Pools                   as projection on cardano.Pools;
    entity Dreps                   as projection on cardano.Dreps;

    // core entities
    entity Transactions            as projection on cardano.Transactions;
    entity Addresses               as projection on cardano.Addresses;
    entity Accounts                as projection on cardano.Accounts;

    // address details
    entity AddressAssets           as projection on cardano.AddressAssets;
    entity AddressUTxOs            as projection on cardano.AddressUTxOs;

    // asset details
    entity UTxOAssets              as projection on cardano.UTxOAssets;

    // transaction details
    entity TransactionInputs       as projection on cardano.TransactionInputs;
    entity TransactionOutputs      as projection on cardano.TransactionOutputs;
    entity TransactionInputAssets  as projection on cardano.TransactionInputAssets;
    entity TransactionOutputAssets as projection on cardano.TransactionOutputAssets;
    entity TransactionMetadata     as projection on cardano.TransactionMetadata;

    action GetNetworkInformation()                             returns NetworkInformation;
    action GetLatestBlock()                                    returns Blocks;
    action GetLatestEpoch()                                    returns Epochs;
    action GetBlockByHash(blockHash: cardano.Blake2b256)       returns Blocks;
    action GetEpochByNumber(epochNumber: Integer)              returns Epochs;
    action GetPoolById(poolId: String)                         returns Pools;
    action GetDrepById(drepId: String)                         returns Dreps;
    action GetAccountByStakingAddress(address: cardano.bech32) returns Accounts;
    action GetTransactionByHash(txHash: cardano.Blake2b256)    returns Transactions;
    action GetAddressByBech32(address: cardano.bech32)         returns Addresses;
    action GetMetadataByTxHash(txHash: cardano.Blake2b256)     returns TransactionMetadata;
    action GetMetadataLabelTransactions(label: String)         returns many TransactionInputs;
    action GetUTxOsByAddress(address: cardano.bech32)          returns many AddressUTxOs;
    action GetAssetsByAddress(address: cardano.bech32)         returns many AddressAssets;

}
