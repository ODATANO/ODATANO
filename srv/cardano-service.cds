using {odatano} from '../db/schema';

service CardanoODataService {

    // core entities
    entity Transactions            as projection on odatano.cardano.Transactions;
    entity Addresses               as projection on odatano.cardano.Addresses;
    entity Metadata                as projection on odatano.cardano.Metadata;

    // address details
    entity AddressAssets           as projection on odatano.cardano.AddressAssets;
    entity AddressUtxos            as projection on odatano.cardano.AddressUtxos;
    entity UtxoAssets              as projection on odatano.cardano.UtxoAssets;

    // transaction details
    entity TransactionInputs       as projection on odatano.cardano.TransactionInputs;
    entity TransactionOutputs      as projection on odatano.cardano.TransactionOutputs;
    entity TransactionInputAssets  as projection on odatano.cardano.TransactionInputAssets;
    entity TransactionOutputAssets as projection on odatano.cardano.TransactionOutputAssets;
}
