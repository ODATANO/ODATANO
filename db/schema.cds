using {temporal} from '@sap/cds/common';

namespace odatano.cardano;

// -----------------------------------------------------
// Basic Cardano Types
// -----------------------------------------------------
type Blake2b224    : String(56); // 28 bytes hex
type Blake2b256    : String(64); // 32 bytes hex
type HexBytes      : String(4000); // CBOR / bytes as hex
type Lovelace      : Decimal(20, 0); // up to 1e20
type AssetUnit     : String(120);
type bech32        : String(120);
type MetadataLabel : Integer;

// -----------------------------------------------------
// Shared structural slices
// -----------------------------------------------------
// asset structural block
type AssetSlice {
    quantity     : Lovelace;
    policyId     : Blake2b224;
    assetNameHex : String(14);
    assetName    : String(128);
    fingerprint  : String(120);
}

// UTxO / IO structural block
type UTxODataSlice {
    dataHash            : Blake2b256;
    inlineDatum         : HexBytes;
    referenceScriptHash : HexBytes;
}

// -----------------------------------------------------
// Address related Entitys
// -----------------------------------------------------
entity Addresses : temporal {
    key address       : bech32;
        stakeAddress  : bech32;
        type          : String(20);
        isScript      : Boolean;
        totalLovelace : Lovelace;
        assets        : Composition of many AddressAssets
                            on assets.address = $self;
}

// assets in one address independet from the utxos
entity AddressAssets : temporal {
    key address : Association to Addresses;
    key unit    : AssetUnit;
        asset   : AssetSlice;
}

// current utxos on a specific address
entity AddressUtxos : temporal {
    key address   : Association to Addresses;
    key hash      : Blake2b256;
    key index     : Integer;
        blockHash : Blake2b256;
        utxodata  : UTxODataSlice;
        assets    : Composition of many UtxoAssets
                        on assets.hash = $self.hash;
}

// utxo specific assets
entity UtxoAssets {
    key hash       : Blake2b256;
    key inputIndex : Integer;
    key unit       : AssetUnit;
        asset      : AssetSlice;
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
        metadata             : Association to Metadata
                                   on metadata.txHash = $self.hash;
        inputs               : Composition of many TransactionInputs
                                   on inputs.txHash = $self.hash;
        outputs              : Composition of many TransactionOutputs
                                   on outputs.txHash = $self.hash;
}

// -----------------------------------------------------
// Transaction Inputs
// -----------------------------------------------------
entity TransactionInputs {
    key txHash       : Blake2b256;
    key inputIndex   : Integer;
        tx           : Association to Transactions
                           on tx.hash = txHash;
        address      : Association to Addresses;
        utxoData     : UTxODataSlice;
        isCollateral : Boolean;
        isReference  : Boolean;
        assets       : Composition of many TransactionInputAssets
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
// Transaction Outputs
// -----------------------------------------------------
entity TransactionOutputs {
    key txHash         : Blake2b256;
    key outputIndex    : Integer;
        tx             : Association to Transactions
                             on tx.hash = $self.txHash;
        bech32_address : bech32;
        address        : Association to Addresses
                             on address.address = $self.bech32_address;
        utxo           : UTxODataSlice;
        assets         : Composition of many TransactionOutputAssets
                             on  assets.txHash      = $self.txHash
                             and assets.outputIndex = $self.outputIndex;
}

entity TransactionOutputAssets {
    key txHash      : Blake2b256;
    key outputIndex : Integer;
    key unit        : AssetUnit;
        asset       : AssetSlice;
}


entity Metadata {
    key txHash      : Blake2b256;
        label       : MetadataLabel;
        payloadJson : LargeString;
}
