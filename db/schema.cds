using {
    temporal,
    cuid
} from '@sap/cds/common';

namespace odatano.cardano;

// -----------------------------------------------------
// Basic Cardano Types
// -----------------------------------------------------
type Blake2b224    : String(56); // 28 bytes hex
type Blake2b256    : String(64); // 32 bytes hex
type HexBytes      : String(8192); // CBOR / bytes as hex
type Lovelace      : Decimal(20, 0);
type AssetUnit     : String(120);
type CIP10         : String(120);
type MetadataLabel : String(5);

type bech32        : String(120)
@assert.format: '^(addr1|stake1|addr_test1|stake_test1)[0-9a-z]+$';

// -----------------------------------------------------
// Shared structural slices
// -----------------------------------------------------
// asset structural block
type AssetSlice {
    quantity     : Lovelace;
    policyId     : Blake2b224;
    assetNameHex : String(64);
    assetName    : String(128);
    fingerprint  : String(44);
}

// UTxO structural data block
type UTxODataSlice {
    dataHash            : Blake2b256;
    inlineDatum         : HexBytes;
    referenceScriptHash : Blake2b256;
}

// -----------------------------------------------------
// Network Info Entity
// -----------------------------------------------------
entity NetworkInformation : temporal {
    maxSupply         : Lovelace;
    totalSupply       : Lovelace;
    circulatingSupply : Lovelace;
    lockedSupply      : Lovelace;
    treasurySupply    : Lovelace;
    reservesSupply    : Lovelace;
    liveStake         : Lovelace;
    activeStake       : Lovelace;
}

entity LatestBlock : temporal {
    key hash        : String;
        time        : String;
        height      : Integer;
        slotLeader  : String;
        epochNumber : Integer;
        epoch       : Association to LatestEpoch
                          on epoch.epoch = $self.epochNumber;
        epochSlot   : Integer;
        size        : Integer;
        txCount     : Integer;
        fees        : Lovelace;
}

entity LatestEpoch : temporal {
    key epoch          : Integer;
        startTime      : Integer;
        endTime        : Integer;
        firstBlockTime : Integer;
        lastBlockTime  : Integer;
        blockCount     : Integer;
        txCount        : Integer;
        output         : String;
        fees           : Lovelace;
        activeStake    : Lovelace;
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
        utxos         : Composition of many AddressUTxOs
                            on utxos.address = $self;
}

// assets in one address independet from the utxos
entity AddressAssets : temporal {
    key address : Association to Addresses;
    key unit    : AssetUnit;
        asset   : AssetSlice;
}

// current utxos on a specific address
entity AddressUTxOs : temporal {
    key address   : Association to Addresses;
    key hash      : Blake2b256;
    key index     : Integer;
        blockHash : Blake2b256;
        utxodata  : UTxODataSlice;
        assets    : Composition of many UTxOAssets
                        on assets.utxo = $self;
}

// utxo specific assets
entity UTxOAssets : cuid {
    utxo  : Association to AddressUTxOs;
    unit  : AssetUnit;
    asset : AssetSlice;
}

// -----------------------------------------------------
// Transactions
// -----------------------------------------------------
entity Transactions {
    key hash                 : Blake2b256 @assert.format: '^[a-f0-9]{64}$';
        blockHash            : Blake2b256;
        blockHeight          : Integer;
        blockTime            : Timestamp;
        slot                 : Integer64;
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
        metadata             : Association to TransactionMetadata
                                   on metadata.tx = $self;
        inputs               : Composition of many TransactionInputs
                                   on inputs.tx = $self;
        outputs              : Composition of many TransactionOutputs
                                   on outputs.tx = $self;
}

// -----------------------------------------------------
// Transaction Inputs
// -----------------------------------------------------
entity TransactionInputs {
    key tx           : Association to Transactions;
    key inputIndex   : Integer;
        address      : Association to Addresses;
        utxoData     : UTxODataSlice;
        isCollateral : Boolean;
        isReference  : Boolean;
        assets       : Composition of many TransactionInputAssets
                           on assets.input = $self;
}

entity TransactionInputAssets {
    key input : Association to TransactionInputs;
    key unit  : AssetUnit;
        asset : AssetSlice;
}

// -----------------------------------------------------
// Transaction Outputs
// -----------------------------------------------------
entity TransactionOutputs {
    key tx          : Association to Transactions;
    key outputIndex : Integer;
        address     : Association to Addresses;
        utxo        : UTxODataSlice;
        assets      : Composition of many TransactionOutputAssets
                          on assets.output = $self;
}

entity TransactionOutputAssets {
    key output : Association to TransactionOutputs;
    key unit   : AssetUnit;
        asset  : AssetSlice;
}

// -----------------------------------------------------
// Transaction Metadata
// -----------------------------------------------------
entity TransactionMetadata {
    key tx      : Association to Transactions;
    key label   : String;
        payload : LargeString;
}
