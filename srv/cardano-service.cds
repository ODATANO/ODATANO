using {odatano} from '../db/schema';

service CardanoODataService {
    entity Transactions as projection on odatano.Transactions;
    entity Addresses    as projection on odatano.Addresses;
    entity Metadata     as projection on odatano.Metadata;

    // Action to fetch a transaction by its blockchain hash (hex)
    action GetTransactionByHash(hash: String) returns Transactions;

    // Action to fetch metadata for a transaction by its hash
    action GetMetadataByTx(hash: String)      returns LargeString;
}
