using {odatano.cardano as db} from '../db/schema';

service CardanoODataService @(impl: 'srv/cardano-service') {

    // ---------------------------------------------------------------------------
    // Entity Projections
    // ---------------------------------------------------------------------------

    @title      : 'Network Information'
    @description: 'Projection for Network Information'
    entity NetworkInformation       as projection on db.NetworkInformation;

    @title      : 'Blocks'
    @description: 'Projection for Blocks'
    entity Blocks                   as projection on db.Blocks;

    @title      : 'Epochs'
    @description: 'Projection for Epochs'
    entity Epochs                   as projection on db.Epochs;

    @title      : 'Pools'
    @description: 'Projection for Pools'
    entity Pools                    as projection on db.Pools;

    @title      : 'Dreps'
    @description: 'Projection for Dreps'
    entity Dreps                    as projection on db.Dreps;

    @title      : 'Transactions'
    @description: 'Projection for Transactions'
    entity Transactions             as projection on db.Transactions;

    @title      : 'Transaction Inputs'
    @description: 'Projection for Transaction Inputs'
    entity TransactionInputs        as projection on db.TransactionInputs;

    @title      : 'Transaction Outputs'
    @description: 'Projection for Transaction Outputs'
    entity TransactionOutputs       as projection on db.TransactionOutputs;

    @title      : 'Transaction Input Assets'
    @description: 'Projection for Transaction Input Assets'
    entity TransactionInputAssets   as projection on db.TransactionInputAssets;

    @title      : 'Transaction Output Assets'
    @description: 'Projection for Transaction Output Assets'
    entity TransactionOutputAssets  as projection on db.TransactionOutputAssets;

    @title      : 'Accounts'
    @description: 'Projection for Accounts'
    entity Accounts                 as projection on db.Accounts;

    @title      : 'Addresses'
    @description: 'Projection for Addresses'
    entity Addresses                as projection on db.Addresses;

    @title      : 'Address Assets'
    @description: 'Projection for Address Assets'
    entity AddressAssets            as projection on db.AddressAssets;

    @title      : 'Address UTxOs'
    @description: 'Projection for Address UTxOs'
    entity AddressUTxOs             as projection on db.AddressUTxOs;

    @title : 'Address Transactions'
    @description: 'Projection for Address Transactions'
    entity AddressTransactions     as projection on db.AddressTransactions;

    @title      : 'UTxO Assets'
    @description: 'Projection for UTxO Assets'
    entity UTxOAssets               as projection on db.UTxOAssets;

    @title      : 'Transaction Metadata'
    @description: 'Projection for Transaction Metadata'
    entity TransactionMetadata      as projection on db.TransactionMetadata;

    @title      : 'Ledger Protocol Parameters'
    @description: 'Projection for Ledger Protocol Parameters'
    entity LedgerProtocolParameters as projection on db.LedgerProtocolParameters;

    // ---------------------------------------------------------------------------
    // Actions
    // ---------------------------------------------------------------------------
    @title      : 'Get Network Information'
    @description: 'Retrieve current network information including network type and genesis hash'
    action GetNetworkInformation()                           returns NetworkInformation;

    @title      : 'Get Blocks by Block Hash'
    @description: 'Retrieve block information using the Block Hash'
    action GetBlockByHash(
                          @title: 'Block Hash'
                          @description: 'The unique identifier of the block'
                          hash: db.Blake2b256)               returns Blocks;

    @title      : 'Get Epochs by Epoch Number'
    @description: 'Retrieve epoch information using the Epoch Number'
    action GetEpochByNumber(
                            @title: 'Epoch Number'
                            @description: 'The sequential number of the epoch'
                            epochNumber: Integer)            returns Epochs;

    @title      : 'Get Pools by Pool Id'
    @description: 'Retrieve pool information using the Pool Id'
    action GetPoolById(
                       @title: 'Pool Id'
                       @description: 'The unique identifier of the stake pool'
                       poolId: String)                       returns Pools;

    @title      : 'Get Dreps by Drep Id'
    @description: 'Retrieve drep information using the Drep Id'
    action GetDrepById(
                       @title: 'Drep Id'
                       @description: 'The unique identifier of the drep'
                       drepId: String)                       returns Dreps;

    @title      : 'Get Accounts by Stake Address'
    @description: 'Retrieve account information using the Bech32 Stake Address'
    action GetAccountByStakeAddress(
                                    @title: 'Stake Address'
                                    @description: 'The Bech32 encoded stake address'
                                    stakeAddress: db.Bech32) returns Accounts;

    @title      : 'Get Transactions by Tx Hash'
    @description: 'Retrieve transaction information using the Transaction Hash'
    action GetTransactionByHash(
                                @title: 'Transaction Hash'
                                @description: 'The unique identifier of the transaction'
                                hash: db.Blake2b256)         returns Transactions;

    @title      : 'Get Transaction Metadata by Tx Hash'
    @description: 'Retrieve transaction metadata using the Transaction Hash'
    action GetMetadataByTxHash(
                               @title: 'Transaction Hash'
                               @description: 'The unique identifier of the transaction'
                               tx_hash: db.Blake2b256)       returns many TransactionMetadata;

    @title      : 'Get Addresses by Bech32 Address'
    @description: 'Retrieve address information using the Bech32 Address'
    action GetAddressByBech32(
                              @title: 'Bech32 Address'
                              @description: 'The Bech32 encoded address'
                              address: db.Bech32)            returns Addresses;

    @title      : 'Get UTxOs by Bech32 Address'
    @description: 'Retrieve UTxO information using the Bech32 Address'
    action GetUTxOsByAddress(
                             @title: 'Bech32 Address'
                             @description: 'The Bech32 encoded address'
                             address: db.Bech32)             returns many AddressUTxOs;

    @title      : 'Get Assets by Bech32 Address'
    @description: 'Retrieve asset information using the Bech32 Address'
    action GetAssetsByAddress(
                              @title: 'Bech32 Address'
                              @description: 'The Bech32 encoded address'
                              address: db.Bech32)            returns many AddressAssets;

    @title      : 'Get Latest Block'
    @description: 'Retrieve the latest block information'
    action GetLatestBlock()                                  returns Blocks;

    @title      : 'Get Latest Epoch'
    @description: 'Retrieve the latest epoch information'
    action GetLatestEpoch()                                  returns Epochs;

    @title      : 'Get Ledger Protocol Parameters'
    @description: 'Retrieve the current ledger protocol parameters'
    action GetLedgerProtocolParameters()                     returns LedgerProtocolParameters;
}
