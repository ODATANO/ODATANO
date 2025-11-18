using {odatano} from '../db/schema';

service CardanoODataService {
    // Core entities
    entity Transactions            as projection on odatano.cardano.Transactions;
    entity Addresses               as projection on odatano.cardano.Addresses;
    entity Assets                  as projection on odatano.cardano.Assets;
    entity Metadata                as projection on odatano.cardano.Metadata;
    entity Datums                  as projection on odatano.cardano.Datums;

    // Transaction details
    entity TransactionInputs       as projection on odatano.cardano.TransactionInputs;
    entity TransactionOutputs      as projection on odatano.cardano.TransactionOutputs;
    entity TransactionInputAssets  as projection on odatano.cardano.TransactionInputAssets;
    entity TransactionOutputAssets as projection on odatano.cardano.TransactionOutputAssets;

    // Actions for hash-based lookups
    action GetTransactionByHash(hash: String) returns Transactions;
    action GetMetadataByTx(hash: String)      returns LargeString;
    action GetAddressByBech32(bech32: String) returns Addresses;
}
