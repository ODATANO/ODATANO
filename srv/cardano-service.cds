using {odatano.cardano} from '../db/schema';

service CardanoODataService {
    // ---------------------------------------------------------------------------
    // Entity Projections
    // ---------------------------------------------------------------------------
    // general network informations
    entity NetworkInformation      as projection on cardano.NetworkInformation;
    entity LatestBlock             as projection on cardano.LatestBlock;
    entity LatestEpoch             as projection on cardano.LatestEpoch;

    // core entities
    entity Transactions            as projection on cardano.Transactions;
    entity Addresses               as projection on cardano.Addresses;
    entity Metadata                as projection on cardano.Metadata;

    // metadata labels
    entity MetadataLabels          as projection on cardano.MetadataLabels;

    // address details
    entity AddressAssets           as projection on cardano.AddressAssets;
    entity AddressUTxOs            as projection on cardano.AddressUTxOs;
    entity UTxOAssets              as projection on cardano.UTxOAssets;

    // transaction details
    entity TransactionInputs       as projection on cardano.TransactionInputs;
    entity TransactionOutputs      as projection on cardano.TransactionOutputs;
    entity TransactionInputAssets  as projection on cardano.TransactionInputAssets;
    entity TransactionOutputAssets as projection on cardano.TransactionOutputAssets;

    action GetNetworkInformation()                          returns NetworkInformation;
    action GetLatestBlock()                                 returns LatestBlock;
    action GetLatestEpoch()                                 returns LatestEpoch;
    action GetTransactionByHash(txHash: cardano.Blake2b256) returns Transactions;
    action GetAddressByBech32(address: cardano.bech32)      returns Addresses;
    action GetMetadataByTxHash(txHash: cardano.Blake2b256)  returns many Metadata;
    action GetUTxOsByAddress(address: cardano.bech32)       returns many AddressUTxOs;
    action GetAssetsByAddress(address: cardano.bech32)      returns many AddressAssets;

}
