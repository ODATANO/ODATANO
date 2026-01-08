using {odatano.cardano as srv} from '../db/schema';

service CardanoODataService @(impl: 'srv/cardano-service') {
    // ---------------------------------------------------------------------------
    // Entity Projections
    // ---------------------------------------------------------------------------
    
    @title : 'Network Information'
    @description : 'Projection for Network Information'
    entity NetworkInformation      as projection on srv.NetworkInformation;

    @title : 'Blocks'
    @description : 'Projection for Blocks'
    entity Blocks                  as projection on srv.Blocks;
    
    @title : 'Epochs'
    @description : 'Projection for Epochs'
    entity Epochs                  as projection on srv.Epochs;
    
    @title : 'Pools'
    @description : 'Projection for Pools'
    entity Pools                   as projection on srv.Pools;
    
    @title : 'Dreps'
    @description : 'Projection for Dreps'
    entity Dreps                   as projection on srv.Dreps;

    @title : 'Transactions'
    @description : 'Projection for Transactions'
    entity Transactions            as projection on srv.Transactions;
    
    @title : 'Transaction Inputs'
    @description : 'Projection for Transaction Inputs'
    entity TransactionInputs       as projection on srv.TransactionInputs;
    
    @title : 'Transaction Outputs'
    @description : 'Projection for Transaction Outputs'
    entity TransactionOutputs      as projection on srv.TransactionOutputs;
    
    @title : 'Transaction Input Assets'
    @description : 'Projection for Transaction Input Assets'
    entity TransactionInputAssets  as projection on srv.TransactionInputAssets;
    
    @title : 'Transaction Output Assets'
    @description : 'Projection for Transaction Output Assets'
    entity TransactionOutputAssets as projection on srv.TransactionOutputAssets;

    @title : 'Accounts'
    @description : 'Projection for Accounts'
    entity Accounts                as projection on srv.Accounts;
    
    @title : 'Addresses'
    @description : 'Projection for Addresses'
    entity Addresses               as projection on srv.Addresses;
    
    @title : 'Address Assets'
    @description : 'Projection for Address Assets'
    entity AddressAssets           as projection on srv.AddressAssets;
    
    @title : 'Address UTxOs'
    @description : 'Projection for Address UTxOs'
    entity AddressUTxOs            as projection on srv.AddressUTxOs;

    @title : 'UTxO Assets'
    @description : 'Projection for UTxO Assets'
    entity UTxOAssets              as projection on srv.UTxOAssets;

    @title : 'Transaction Metadata'
    @description : 'Projection for Transaction Metadata'
    entity TransactionMetadata     as projection on srv.TransactionMetadata;

    // ---------------------------------------------------------------------------
    // Actions
    // ---------------------------------------------------------------------------
    
    @title : 'Get Network Information'
    @description : 'Retrieve current network information including network type and genesis hash'
    action GetNetworkInformation() returns NetworkInformation;
    
    @title : 'Get Blocks by Block Hash'
    @description : 'Retrieve block information using the Block Hash'
    action GetBlockByHash(
        @title : 'Block Hash'
        @description : 'The unique identifier of the block'
        hash: srv.Blake2b256) returns Blocks;
    
    @title : 'Get Epochs by Epoch Number'
    @description : 'Retrieve epoch information using the Epoch Number'
    action GetEpochByNumber(
        @title : 'Epoch Number'
        @description : 'The sequential number of the epoch'
        number: Integer) returns Epochs;
    
    @title : 'Get Pools by Pool Id'
    @description : 'Retrieve pool information using the Pool Id'
    action GetPoolById(
        @title : 'Pool Id'
        @description : 'The unique identifier of the stake pool'
        poolId: String
    ) returns Pools;

    @title : 'Get Dreps by Drep Id'
    @description : 'Retrieve drep information using the Drep Id'
    action GetDrepById(
        @title : 'Drep Id'
        @description : 'The unique identifier of the drep'
        drepId: String
    ) returns Dreps;
    
    @title : 'Get Accounts by Stake Address'
    @description : 'Retrieve account information using the Bech32 Stake Address'
    action GetAccountByStakeAddress(
        @title : 'Stake Address'
        @description : 'The Bech32 encoded stake address'
        stakeAddress: srv.bech32) returns Accounts;

    @title : 'Get Transactions by Tx Hash'
    @description : 'Retrieve transaction information using the Transaction Hash'
    action GetTransactionByHash(
        @title : 'Transaction Hash'
        @description : 'The unique identifier of the transaction'
        hash: srv.Blake2b256) returns Transactions;

    @title : 'Get Transaction Metadata by Tx Hash'
    @description : 'Retrieve transaction metadata using the Transaction Hash'
    action GetMetadataByTxHash(
        @title : 'Transaction Hash'
        @description : 'The unique identifier of the transaction'
        hash: srv.Blake2b256) returns many TransactionMetadata;

    @title : 'Get Addresses by Bech32 Address'
    @description : 'Retrieve address information using the Bech32 Address'
    action GetAddressByBech32(
        @title : 'Bech32 Address'
        @description : 'The Bech32 encoded address'
        address: srv.bech32)            returns Addresses;

    @title : 'Get UTxOs by Bech32 Address'
    @description : 'Retrieve UTxO information using the Bech32 Address'
    action GetUTxOsByAddress(
        @title : 'Bech32 Address'
        @description : 'The Bech32 encoded address'
        address: srv.bech32)            returns many AddressUTxOs;

    @title : 'Get Assets by Bech32 Address'
    @description : 'Retrieve asset information using the Bech32 Address'
    action GetAssetsByAddress(
        @title : 'Bech32 Address'
        @description : 'The Bech32 encoded address'
        address: srv.bech32)            returns many AddressAssets;
}
