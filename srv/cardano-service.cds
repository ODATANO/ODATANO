using {odatano.cardano as srv} from '../db/schema';

service CardanoODataService @(impl: 'srv/cardano-service') {
    // ---------------------------------------------------------------------------
    // Entity Projections
    // ---------------------------------------------------------------------------
    // Network informations
    entity NetworkInformation      as projection on srv.NetworkInformation;

    // General blockchain entities
    entity Blocks                  as projection on srv.Blocks;
    entity Epochs                  as projection on srv.Epochs;
    entity Pools                   as projection on srv.Pools;
    entity Dreps                   as projection on srv.Dreps;

    // Transactions and related entities
    entity Transactions            as projection on srv.Transactions;
    entity TransactionInputs       as projection on srv.TransactionInputs;
    entity TransactionOutputs      as projection on srv.TransactionOutputs;
    entity TransactionInputAssets  as projection on srv.TransactionInputAssets;
    entity TransactionOutputAssets as projection on srv.TransactionOutputAssets;

    // Addresses, Accounts and related entities
    entity Accounts                as projection on srv.Accounts;
    entity Addresses               as projection on srv.Addresses;
    entity AddressAssets           as projection on srv.AddressAssets;
    entity AddressUTxOs            as projection on srv.AddressUTxOs;

    // UTxOAsset details
    entity UTxOAssets              as projection on srv.UTxOAssets;

    // Transaction metadata
    entity TransactionMetadata     as projection on srv.TransactionMetadata;

    // ---------------------------------------------------------------------------
    // Actions
    // ---------------------------------------------------------------------------
    // Network Information
    action GetNetworkInformation()                            returns NetworkInformation;
    // Blocks
    action GetBlockByHash(blockHash: srv.Blake2b256)          returns Blocks;
    // Epochs
    action GetEpochByNumber(epochNumber: Integer)             returns Epochs;
    // Pools
    action GetPoolById(poolId: String)                        returns Pools;
    // Dreps
    action GetDrepById(drepId: String)                        returns Dreps;
    // Accounts
    action GetAccountByStakeAddress(stakeAddress: srv.bech32) returns Accounts;
    // Transactions
    action GetTransactionByHash(txHash: srv.Blake2b256)       returns Transactions;
    // Addresses
    action GetAddressByBech32(address: srv.bech32)            returns Addresses;
    // Transaction Metadata
    action GetMetadataByTxHash(txHash: srv.Blake2b256)        returns TransactionMetadata;
    action GetMetadataLabelTransactions(label: String)        returns many Transactions;
    // UTxOs and Assets
    action GetUTxOsByAddress(address: srv.bech32)             returns many AddressUTxOs;
    action GetAssetsByAddress(address: srv.bech32)            returns many AddressAssets;
}
