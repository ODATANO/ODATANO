using {odatano} from '../db/schema';

service CardanoODataService {
    entity Transactions as projection on odatano.Transactions;
    entity Addresses    as projection on odatano.Addresses;
    entity Metadata     as projection on odatano.Metadata;
}
