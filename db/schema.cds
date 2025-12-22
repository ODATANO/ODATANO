using {temporal, } from '@sap/cds/common';

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
    key network           : String; // 'mainnet' | 'preview' | 'preprod'
        maxSupply         : Lovelace; // 45_000_000_000_000_000
        totalSupply       : Lovelace; // current total supply
        circulatingSupply : Lovelace; // current circulating supply
        lockedSupply      : Lovelace; // current locked supply
        treasurySupply    : Lovelace; // current treasury supply
        reservesSupply    : Lovelace; // current reserves supply
        liveStake         : Lovelace; // current live stake
        activeStake       : Lovelace; // current active stake
}

entity Blocks {
    key hash        : String; // block hash as hex
        time        : String; // block time as ISO 8601 string
        height      : Integer; // block height
        slotLeader  : String; // slot leader id as hex
        epochNumber : Integer; // epoch number
        epoch       : Association to Epochs
                          on epoch.epoch = $self.epochNumber; // association to epoch
        epochSlot   : Integer; // slot number within the epoch
        size        : Integer; // block size in bytes
        txCount     : Integer; // number of transactions in the block
        fees        : Lovelace; // total fees in the block
}

entity Epochs {
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

entity Pools {
    key poolId         : String; // stake pool id as hex
        vrfKeyHash     : String; // pool vrf key hash as hex
        blocksMinted   : Integer; // total number of blocks minted by the pool
        blocksEpoch    : Integer; // number of blocks minted in the current epoch
        liveStake      : Lovelace; // current live stake delegated to the pool
        liveSize       : Decimal(5, 4); // current live size as fraction of total active stake
        liveSaturation : Decimal(5, 4); // current live saturation as fraction of ideal size
        liveDelegators : Integer; // current number of live delegators
        activeStake    : Lovelace; // current active stake delegated to the pool
        activeSize     : Decimal(5, 4); // current active size as fraction
        pledge         : Lovelace; // pool pledge in lovelace
        margin         : Decimal(5, 4); // pool margin as fraction
        fixedCost      : Lovelace; // pool fixed cost in lovelace
        rewardAccount  : String; // pool reward account in bech32 format
}

entity Dreps {
    key drepId          : String; // drep id as hex
        hex             : String; // drep vrf key hash as hex
        amount          : Lovelace; // drep stake address in bech32 format
        hasScript       : Boolean; // true if drep is a script drep
        lastActiveEpoch : Integer; // epoch number of last activity
        retired         : Boolean; // true if drep is retired
        expired         : Boolean; // true if drep is expired
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
        hasAssets     : Boolean; // indicates if address has assets
        hasUTxOs      : Boolean; // indicates if address has utxos
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
        hasAssets : Boolean; // indicates if utxo has assets
}

// -----------------------------------------------------
// UTxO Assets
// -----------------------------------------------------
entity UTxOAssets : temporal {
    key utxo  : Association to AddressUTxOs; // utxo association
        unit  : AssetUnit; // asset unit
        asset : AssetSlice; // asset details
}

entity Accounts : temporal {
    key stakeAddress       : String; // stake address in bech32 format
        active             : Boolean; // true if account is active
        activeEpoch        : Integer; // epoch number of last activity
        controlledAmount   : Lovelace; // total controlled amount in lovelace
        rewardsSum         : Lovelace; // total rewards sum in lovelace
        withdrawalsSum     : Lovelace; // total withdrawals sum in lovelace
        reservesSum        : Lovelace; // total reserves sum in lovelace
        treasurySum        : Lovelace; // total treasury sum in lovelace
        withdrawableAmount : Lovelace; // total withdrawable amount in lovelace
        poolId             : Association to Pools; // associated pool id
        drepId             : Association to Dreps; // associated drep id
        Address            : Composition of many Addresses
                                 on Address.stakeAddress = $self.stakeAddress; // all addresses for this account
        // all current utxos for this account
        hasAddresses       : Boolean; // indicates if account has assets

}

// -----------------------------------------------------
// Transactions Entitys
// -----------------------------------------------------
entity Transactions {
    key hash        : Blake2b256 @assert.format: '^[a-f0-9]{64}$'; // transaction hash as hex
        blockHash   : Blake2b256; // block hash containing the transaction
        blockHeight : Integer; // block height containing the transaction
        blockTime   : Timestamp; // block time containing the transaction
        slot        : Integer64; // slot number containing the transaction
        txIndex     : Integer; // transaction index within the block
        fee         : Lovelace; // transaction fee in lovelace
        deposit     : Lovelace; // deposit change in lovelace
        size        : Integer; // transaction size in bytes
        metadata    : Composition of many TransactionMetadata // transaction metadata
                          on metadata.tx = $self;
        inputs      : Composition of many TransactionInputs // transaction inputs
                          on inputs.tx = $self;
        outputs     : Composition of many TransactionOutputs // transaction outputs
                          on outputs.tx = $self;
        hasMetadata : Boolean; // indicates if transaction has metadata
        hasInputs   : Boolean; // indicates if transaction has inputs
        hasOutputs  : Boolean; // indicates if transaction has outputs
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
        hasAddresses : Boolean; // indicates if input has associated addresses
        hasAssets    : Boolean; // indicates if input has assets
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
    key tx           : Association to Transactions; // transaction association
    key outputIndex  : Integer; // output index within the transaction
        address      : Association to Addresses; // output address
        utxo         : UTxODataSlice; // output utxo data
        assets       : Composition of many TransactionOutputAssets // output assets
                           on assets.output = $self;
        hasAddresses : Boolean; // indicates if output has associated addresses
        hasAssets    : Boolean; // indicates if output has assets
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
