namespace odatano;

using {
    cuid,
    temporal
} from '@sap/cds/common';

entity Transactions : cuid, temporal {
    key ID        : UUID;
        hash      : String(64) @assert.format: '^[a-f0-9]{64}$';
        block     : Integer;
        blockTime : Timestamp;
        fee       : Decimal(20, 0);
        inputs    : Composition of many TransactionInputs
                        on inputs.tx = $self;
        outputs   : Composition of many TransactionOutputs
                        on outputs.tx = $self;
        metadata  : Association to Metadata;
}

entity TransactionInputs {
    key tx      : Association to Transactions;
    key index   : Integer;
        address : String;
        amount  : Decimal(20, 0);
}

entity TransactionOutputs {
    key tx      : Association to Transactions;
    key index   : Integer;
        address : String;
        amount  : Decimal(20, 0);
}

entity Addresses {
    key address : String @assert.format: '^addr_test';
        balance : Decimal(20, 0);
        assets  : Composition of many AddressAssets
                      on assets.address = $self;
}

entity AddressAssets {
    key address  : Association to Addresses;
    key unit     : String;
        quantity : Decimal(20, 0);
}

entity Metadata {
    key tx      : Association to Transactions;
    key datakey : String;
        json    : LargeString;
}
