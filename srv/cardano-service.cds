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
    // Blocks by Block Hash
    action GetBlockByHash(hash: srv.Blake2b256)               returns Blocks;
    // Epochs by Epoch Number
    action GetEpochByNumber(epochNumber: Integer)             returns Epochs;
    // Pools by Pool Id
    action GetPoolById(poolId: String)                        returns Pools;
    // Dreps by Drep Id
    action GetDrepById(drepId: String)                        returns Dreps;
    // Accounts by Stake Address
    action GetAccountByStakeAddress(stakeAddress: srv.bech32) returns Accounts;
    // Transactions by Tx Hash
    action GetTransactionByHash(hash: srv.Blake2b256)         returns Transactions;
    // Transaction Metadata by Tx Hash
    action GetMetadataByTxHash(tx_hash: srv.Blake2b256)       returns TransactionMetadata;
    // Addresses Info by Bech32 Address
    action GetAddressByBech32(address: srv.bech32)            returns Addresses;
    // UTxOs and Assets by Bech32 Address
    action GetUTxOsByAddress(address: srv.bech32)             returns many AddressUTxOs;
    action GetAssetsByAddress(address: srv.bech32)            returns many AddressAssets;
}
