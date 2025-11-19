using {
    cuid,
    temporal
} from '@sap/cds/common';

namespace odatano.cardano;

// Basic Types
type Blake2b224 : String(56); // 28 bytes -> 56 hex chars
type Blake2b256 : String(64); // 32 bytes -> 64 hex chars
type HexBytes   : String(4000); // hex-encoded CBOR / byte arrays
type Lovelace   : Decimal(20, 0);

// Addresses & Credentials
entity Addresses : temporal {
    key bech32      : String(120);
        paymentKind : String(10);
        paymentHash : Blake2b224;
        label       : String(80);
}

// Assets & Value
entity Assets : cuid, temporal {
    key ID        : UUID;
        policyId  : Blake2b224; // PolicyId = Hash<Blake2b_224, Script>
        assetName : String(64); // hex-encoded AssetName (0..32 bytes)
        symbol    : String(40);
        decimals  : Integer;
        metadata  : LargeString; // optional JSON (token metadata)
}

// flattened Value entries per transaction input/output
entity TransactionInputAssets : cuid {
    key ID        : UUID;
        input     : Association to TransactionInputs;
        policyId  : Blake2b224;
        assetName : String(64);
        quantity  : Decimal(38, 0);
}

entity TransactionOutputAssets : cuid {
    key ID        : UUID;
        output    : Association to TransactionOutputs;
        policyId  : Blake2b224;
        assetName : String(64);
        quantity  : Decimal(38, 0);
}

// Metadata

entity Metadata : cuid, temporal {
    key ID    : UUID;
        label : String(200);
        json  : LargeString; // raw JSON as string
}

// Transactions
entity Transactions : cuid, temporal {
    key ID        : UUID;
        hash      : Blake2b256 @assert.format: '^[a-f0-9]{64}$';
        block     : Integer;
        blockTime : Timestamp;
        fee       : Lovelace;
        metadata  : Association to Metadata;
        inputs    : Composition of many TransactionInputs
                        on inputs.tx = $self;
        outputs   : Composition of many TransactionOutputs
                        on outputs.tx = $self;
}

// Transaction Inputs
entity TransactionInputs : cuid {
    key ID            : UUID;
        tx            : Association to Transactions;
        index         : Integer;
        sourceTxHash  : Blake2b256;
        sourceIndex   : Integer;
        address       : Association to Addresses;
        valueLovelace : Lovelace;
        assets        : Composition of many TransactionInputAssets
                            on assets.input = $self;
        datumHash     : Blake2b256;
}

// Transaction Outputs
entity TransactionOutputs : cuid {
    key ID              : UUID;
        tx              : Association to Transactions;
        index           : Integer;
        address         : Association to Addresses;
        valueLovelace   : Lovelace;
        assets          : Composition of many TransactionOutputAssets
                              on assets.output = $self;
        datumKind       : String(10);
        datumHash       : Blake2b256;
        inlineDatumCbor : HexBytes;
        referenceScript : Blake2b224;
}

// Datums
entity Datums {
    key hash        : Blake2b256;
        rawCbor     : HexBytes;
        typeName    : String(80);
        decodedJson : LargeString;
        createdAt   : Timestamp;
}
