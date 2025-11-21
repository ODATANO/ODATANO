using {odatano} from '../db/schema';

service CardanoODataService {

    // Core entities
    entity Transactions            as projection on odatano.cardano.Transactions;
    entity Addresses               as projection on odatano.cardano.Addresses;
    entity AddressAssets           as projection on odatano.cardano.AddressAssets;
    entity UTxOs                   as projection on odatano.cardano.UTxOs;
    entity Metadata                as projection on odatano.cardano.Metadata;
    entity Datums                  as projection on odatano.cardano.Datums;

    // Transaction details
    entity TransactionInputs       as projection on odatano.cardano.TransactionInputs;
    entity TransactionOutputs      as projection on odatano.cardano.TransactionOutputs;
    entity TransactionInputAssets  as projection on odatano.cardano.TransactionInputAssets;
    entity TransactionOutputAssets as projection on odatano.cardano.TransactionOutputAssets;
}
