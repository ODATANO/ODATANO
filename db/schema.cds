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
type Lovelace      : Decimal(20, 0); // 1 ADA = 1_000_000 Lovelace
type AssetUnit     : String(120); // policyId + assetNameHex
type MetadataLabel : String(5); // max 5 digits
type bech32        : String(120) // bech32 encoded address
@assert.format: '^(addr1|stake1|addr_test1|stake_test1)[0-9a-z]+$';

// -----------------------------------------------------
// Shared structural slices
// -----------------------------------------------------
// Asset structural block
type AssetSlice {
    quantity     : Lovelace; // for fungible assets, number of tokens
    policyId     : Blake2b224; // asset policy id
    assetNameHex : String(64); // asset name as hex string
    assetName    : String(128); // asset name as utf8 string
    fingerprint  : String(44); // CIP-14 asset fingerprint
}

// UTxO structural data block
type UTxODataSlice {
    dataHash            : Blake2b256; // optional utxo datum hash
    inlineDatum         : HexBytes; // optional utxo inline datum as hex CBOR
    referenceScriptHash : Blake2b256; // optional utxo reference script hash
}

// -----------------------------------------------------
// Network Info Entity
// -----------------------------------------------------
entity NetworkInformation : temporal {
    key network           : String; // 'mainnet' | 'preview' | 'preprod' | 'testnet'
        maxSupply         : Lovelace; // 45_000_000_000_000_000
        totalSupply       : Lovelace; // current total supply
        circulatingSupply : Lovelace; // current circulating supply
        lockedSupply      : Lovelace; // current locked supply
        treasurySupply    : Lovelace; // current treasury supply
        reservesSupply    : Lovelace; // current reserves supply
        liveStake         : Lovelace; // current live stake
        activeStake       : Lovelace; // current active stake
}

entity LatestBlock : temporal {
    key hash        : String; // block hash as hex
        time        : String; // block time as ISO 8601 string
        height      : Integer; // block height
        slotLeader  : String; // slot leader id as hex
        epochNumber : Integer; // epoch number
        epoch       : Association to LatestEpoch
                          on epoch.epoch = $self.epochNumber; // association to epoch
        epochSlot   : Integer; // slot number within the epoch
        size        : Integer; // block size in bytes
        txCount     : Integer; // number of transactions in the block
        fees        : Lovelace; // total fees in the block
}

entity LatestEpoch : temporal {
    key epoch          : Integer; // epoch number
        startTime      : Integer; // epoch start time as unix timestamp
        endTime        : Integer; // epoch end time as unix timestamp
        firstBlockTime : Integer; // first block time as unix timestamp
        lastBlockTime  : Integer; // last block time as unix timestamp
        blockCount     : Integer; // number of blocks in the epoch
        txCount        : Integer; // number of transactions in the epoch
        output         : String; // total output in the epoch as string to avoid precision issues
        fees           : Lovelace; // total fees in the epoch
        activeStake    : Lovelace; // total active stake in the epoch
}

// -----------------------------------------------------
// Address related Entitys
// -----------------------------------------------------
entity Addresses : temporal {
    key address       : bech32; // full address in bech32 format
        stakeAddress  : bech32; // associated stake address in bech32 format
        type          : String(20); // 'base' | 'enterprise' | 'pointer' | 'reward' | 'script' | 'unknown'
        isScript      : Boolean; // true if address is a script address
        totalLovelace : Lovelace; // total lovelace on this address
        assets        : Composition of many AddressAssets
                            on assets.address = $self; // all assets on this address
        utxos         : Composition of many AddressUTxOs
                            on utxos.address = $self; // all current utxos on this address
}

// -----------------------------------------------------
// Address Assets
// -----------------------------------------------------
entity AddressAssets : temporal {
    key address : Association to Addresses; // address association
    key unit    : AssetUnit; // asset unit
        asset   : AssetSlice; // asset details
}

// -----------------------------------------------------
// Address UTxOs
// -----------------------------------------------------
entity AddressUTxOs : temporal {
    key address   : Association to Addresses; // address association
    key hash      : Blake2b256; // transaction hash
    key index     : Integer; // output index
        blockHash : Blake2b256; // block hash containing the utxo
        utxodata  : UTxODataSlice; // utxo specific data
        assets    : Composition of many UTxOAssets // assets in this utxo
                        on assets.utxo = $self;
}

// -----------------------------------------------------
// UTxO Assets
// -----------------------------------------------------
entity UTxOAssets : cuid {
    utxo  : Association to AddressUTxOs; // utxo association
    unit  : AssetUnit; // asset unit
    asset : AssetSlice; // asset details
}

// -----------------------------------------------------
// Transactions Entitys
// -----------------------------------------------------
entity Transactions {
    key hash                 : Blake2b256 @assert.format: '^[a-f0-9]{64}$'; // transaction hash as hex
        blockHash            : Blake2b256; // block hash containing the transaction
        blockHeight          : Integer; // block height containing the transaction
        blockTime            : Timestamp; // block time containing the transaction
        slot                 : Integer64; // slot number containing the transaction
        txIndex              : Integer; // transaction index within the block
        fee                  : Lovelace; // transaction fee in lovelace
        deposit              : Lovelace; // deposit change in lovelace
        size                 : Integer; // transaction size in bytes
        utxoCount            : Integer; // number of utxos created by the transaction
        withdrawalCount      : Integer; // number of withdrawals in the transaction
        mirCertCount         : Integer; // number of MIR certificates in the transaction
        delegationCount      : Integer; // number of delegations in the transaction
        stakeCertCount       : Integer; // number of stake certificates in the transaction
        poolUpdateCount      : Integer; // number of pool updates in the transaction
        poolRetireCount      : Integer; // number of pool retirements in the transaction
        assetMintOrBurnCount : Integer; // number of asset minting or burning operations in the transaction
        redeemerCount        : Integer; // number of redeemers in the transaction
        validContract        : Boolean; // true if the transaction's smart contracts are valid
        metadata             : Association to TransactionMetadata // transaction metadata
                                   on metadata.tx = $self;
        inputs               : Composition of many TransactionInputs // transaction inputs
                                   on inputs.tx = $self;
        outputs              : Composition of many TransactionOutputs // transaction outputs
                                   on outputs.tx = $self;
}

// -----------------------------------------------------
// Transaction Inputs & Assets
// -----------------------------------------------------
entity TransactionInputs {
    key tx           : Association to Transactions; // transaction association
    key inputIndex   : Integer; // input index within the transaction
        address      : Association to Addresses; // input address
        utxoData     : UTxODataSlice; // input utxo data
        isCollateral : Boolean; // true if input is used as collateral
        isReference  : Boolean; // true if input is used as reference
        assets       : Composition of many TransactionInputAssets // input assets
                           on assets.input = $self;
}

entity TransactionInputAssets {
    key input : Association to TransactionInputs; // input association
    key unit  : AssetUnit; // asset unit
        asset : AssetSlice; // asset details
}

// -----------------------------------------------------
// Transaction Outputs & Assets
// -----------------------------------------------------
entity TransactionOutputs {
    key tx          : Association to Transactions; // transaction association
    key outputIndex : Integer; // output index within the transaction
        address     : Association to Addresses; // output address
        utxo        : UTxODataSlice; // output utxo data
        assets      : Composition of many TransactionOutputAssets // output assets
                          on assets.output = $self;
}

entity TransactionOutputAssets {
    key output : Association to TransactionOutputs; // output association
    key unit   : AssetUnit; // asset unit
        asset  : AssetSlice; // asset details
}

// -----------------------------------------------------
// Transaction Metadata
// -----------------------------------------------------
entity TransactionMetadata {
    key tx      : Association to Transactions; // transaction association
    key label   : String; // metadata label as string
        payload : LargeString; // metadata payload as JSON string
}
