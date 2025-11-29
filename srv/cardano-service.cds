using {odatano} from '../db/schema';

service CardanoODataService {
    // ---------------------------------------------------------------------------
    // Entity Projections
    // ---------------------------------------------------------------------------
    // general network informations
    entity NetworkInformation      as projection on odatano.cardano.NetworkInformation;

    // core entities
    entity Transactions            as projection on odatano.cardano.Transactions;
    entity Addresses               as projection on odatano.cardano.Addresses;
    entity Metadata                as projection on odatano.cardano.Metadata;

    // address details
    entity AddressAssets           as projection on odatano.cardano.AddressAssets;
    entity AddressUTxOs            as projection on odatano.cardano.AddressUTxOs;
    entity UTxOAssets              as projection on odatano.cardano.UTxOAssets;

    // transaction details
    entity TransactionInputs       as projection on odatano.cardano.TransactionInputs;
    entity TransactionOutputs      as projection on odatano.cardano.TransactionOutputs;
    entity TransactionInputAssets  as projection on odatano.cardano.TransactionInputAssets;
    entity TransactionOutputAssets as projection on odatano.cardano.TransactionOutputAssets;

}
