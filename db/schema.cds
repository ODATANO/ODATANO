using {temporal} from '@sap/cds/common';

namespace odatano.cardano;

// -----------------------------------------------------
// Basic Cardano Types
// -----------------------------------------------------
type Blake2b224 : String(56); // 28 bytes hex
type Blake2b256 : String(64); // 32 bytes hex
type HexBytes   : String(4000); // CBOR / bytes as hex
type Lovelace   : Decimal(20, 0); // up to 1e20
type AssetUnit  : String(120);

// -----------------------------------------------------
// Shared structural slices
// -----------------------------------------------------

// UTxO / IO structural block
type UTxOSlice {
    address             : Association to Addresses;
    valueLovelace       : Lovelace;
    dataHash            : Blake2b256;
    inlineDatum         : HexBytes;
    referenceScriptHash : HexBytes;
}

// Asset structural block
type AssetSlice {
    quantity  : Lovelace;
    policyId  : Blake2b224;
    assetName : String(128);
}

// -----------------------------------------------------
// Addresses & Balance
// -----------------------------------------------------
entity Addresses : temporal {
    key bech32        : String(120);
        stakeAddress  : String(120);
        type          : String(20);
        isScript      : Boolean;
        totalLovelace : Lovelace;
        assets        : Composition of many AddressAssets
                            on assets.bech32 = $self;
}

entity AddressAssets : temporal {
    key bech32 : Association to Addresses;
    key unit   : AssetUnit;
        asset  : AssetSlice;
}


// -----------------------------------------------------
// Transactions (high-level metadata)
// -----------------------------------------------------
entity Transactions {
    key hash                 : Blake2b256 @assert.format: '^[a-f0-9]{64}$';
        blockHash            : Blake2b256;
        blockHeight          : Integer;
        blockTime            : Timestamp;
        slot                 : Integer;
        txIndex              : Integer;
        fee                  : Lovelace;
        deposit              : Lovelace;
        size                 : Integer;
        utxoCount            : Integer;
        withdrawalCount      : Integer;
        mirCertCount         : Integer;
        delegationCount      : Integer;
        stakeCertCount       : Integer;
        poolUpdateCount      : Integer;
        poolRetireCount      : Integer;
        assetMintOrBurnCount : Integer;
        redeemerCount        : Integer;
        validContract        : Boolean;
        metadata             : Association to Metadata;
        inputs               : Composition of many TransactionInputs
                                   on inputs.txHash = $self.hash;
        outputs              : Composition of many TransactionOutputs
                                   on outputs.txHash = $self.hash;
}

// -----------------------------------------------------
// Transaction Inputs
// -----------------------------------------------------
entity TransactionInputs {
    key txHash            : Blake2b256;
    key inputIndex        : Integer;
        tx                : Association to Transactions
                                on tx.hash = txHash;
        sourceTxHash      : Blake2b256;
        sourceOutputIndex : Integer;
        utxo              : UTxOSlice;
        isCollateral      : Boolean;
        isReference       : Boolean;
        assets            : Composition of many TransactionInputAssets
                                on  assets.txHash     = $self.txHash
                                and assets.inputIndex = $self.inputIndex;
}

entity TransactionInputAssets {
    key txHash     : Blake2b256;
    key inputIndex : Integer;
    key unit       : AssetUnit;
        asset      : AssetSlice;
}

// -----------------------------------------------------
// Transaction Outputs  (potentielle UTxOs einer Tx)
// -----------------------------------------------------
entity TransactionOutputs {
    key txHash           : Blake2b256; // Hash der Transaktion
    key outputIndex      : Integer; // output_index im outputs[]-Array
        tx               : Association to Transactions
                               on tx.hash = txHash;
        utxo             : UTxOSlice;
        consumedByTxHash : Blake2b256; // Hash der Tx, die diesen Output als Input konsumiert (optional/null)
        assets           : Composition of many TransactionOutputAssets
                               on  assets.txHash      = $self.txHash
                               and assets.outputIndex = $self.outputIndex;
}

entity TransactionOutputAssets {
    key txHash      : Blake2b256;
    key outputIndex : Integer;
    key unit        : AssetUnit;
        asset       : AssetSlice;
}


// -----------------------------------------------------
// Current UTxO Set (spendable UTxOs)
// -----------------------------------------------------
entity UTxOs : temporal {
    key txHash      : Blake2b256;
    key outputIndex : Integer;
        utxo        : UTxOSlice;
        spent       : Boolean; // false = unspent, true = bereits verbraucht
}


// -----------------------------------------------------
// Inline Datums (decoded)
// -----------------------------------------------------
entity Datums {
    key hash        : Blake2b256;
        rawCbor     : HexBytes;
        typeName    : String(80);
        decodedJson : LargeString;
        createdAt   : Timestamp;
}

// -----------------------------------------------------
// CIP-10 Metadata
// -----------------------------------------------------
entity Metadata {
    key txHash      : Blake2b256;
        rawCbor     : HexBytes;
        createdAt   : Timestamp;
        decodedJson : LargeString;
}
