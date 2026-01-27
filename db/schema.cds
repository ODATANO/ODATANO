using {temporal, } from '@sap/cds/common';

namespace odatano.cardano;

// -----------------------------------------------------
// Basic Cardano Types
// -----------------------------------------------------
@title      : 'Blake2b224'
@description: '28 bytes Blake2b hash as hex string'
type Blake2b224    : String(56);

@title      : 'Blake2b256'
@description: '32 bytes Blake2b hash as hex string'
type Blake2b256    : String(64);

@title      : 'HexBytes'
@description: 'CBOR / bytes as hex string'
type HexBytes      : String(8192);

@title      : 'Lovelace'
@description: 'Amount of ADA in lovelace (1 ADA = 1_000_000 lovelace)'
type Lovelace      : Decimal(20, 0);

@title      : 'Asset Unit'
@description: 'Concatenation of policyId and assetNameHex representing a unique asset'
type AssetUnit     : String(120);

@title      : 'Metadata Label'
@description: 'Metadata label as string (max 5 digits)'
type MetadataLabel : String(5);

@title      : 'Bech32 Address'
@description: 'Bech32 encoded address string'
type Bech32        : String(120);

// -----------------------------------------------------
// Shared structural slices
// -----------------------------------------------------
@title      : 'Asset Slice'
@description: 'Structural slice for asset details'
type AssetSlice {

    @title      : 'Asset Quantity'
    @description: 'Quantity of the Asset'
    quantity     : Lovelace;

    @title      : 'Asset Policy Id'
    @description: 'Policy Id of the Asset'
    policyId     : Blake2b224;

    @title      : 'Asset Name Hex'
    @description: 'Asset Name as Hex String'
    assetNameHex : String(64);

    @title      : 'Asset Name'
    @description: 'Asset Name as UTF-8 String'
    assetName    : String(128);

    @title      : 'Asset Fingerprint'
    @description: 'CIP-14 Asset Fingerprint'
    fingerprint  : String(44);
}

@title      : 'Metadata Slice'
@description: 'Structural slice for metadata details'
type MetadataSlice {

    @title      : 'Metadata Label'
    @description: 'Metadata label as string (max 5 digits)'
    label   : MetadataLabel;

    @title      : 'Metadata Payload'
    @description: 'Metadata payload as JSON string'
    payload : LargeString;
}

@title      : 'UTxO Data Slice'
@description: 'Structural slice for UTxO specific data'
type UTxODataSlice {

    @title      : 'Datum Hash'
    @description: 'The datum hash associated with the UTxO'
    dataHash            : Blake2b256;

    @title      : 'Inline Datum'
    @description: 'The inline datum associated with the UTxO as hex CBOR'
    inlineDatum         : HexBytes;

    @title      : 'Reference Script Hash'
    @description: 'The reference script hash associated with the UTxO'
    referenceScriptHash : Blake2b256;
}

@title      : 'Network Information Entity'
@description: 'General information entity definition'
entity NetworkInformation : temporal {

        @title      : 'Network (key)'
        @description: 'The Cardano network type mainnet | preprod | preview'
    key network           : String(10);

        @title      : 'Max Supply'
        @description: 'The maximum supply of ADA'
        maxSupply         : Lovelace;

        @title      : 'Total Supply'
        @description: 'Current total supply of ADA'
        totalSupply       : Lovelace;

        @title      : 'Circulating Supply'
        @description: 'Current circulating supply of ADA'
        circulatingSupply : Lovelace;

        @title      : 'Locked Supply'
        @description: 'Current locked supply of ADA'
        lockedSupply      : Lovelace;

        @title      : 'Treasury Supply'
        @description: 'Current treasury supply of ADA'
        treasurySupply    : Lovelace;

        @title      : 'Reserves Supply'
        @description: 'Current reserves supply of ADA'
        reservesSupply    : Lovelace;

        @title      : 'Live Stake'
        @description: 'Current live stake of ADA'
        liveStake         : Lovelace;

        @title      : 'Active Stake'
        @description: 'Current active stake of ADA'
        activeStake       : Lovelace;
}

@title      : 'Block Entity'
@description: 'Block information entity definition'
entity Blocks {

        @title      : 'Block Hash (Key)'
        @description: 'Block hash as hex string'
    key hash        : String(64);

        @title      : 'Block Time'
        @description: 'Block time as ISO 8601 string'
        time        : String;

        @title      : 'Block Height'
        @description: 'Block height as integer'
        height      : Integer;

        @title      : 'Block SlotLeader'
        @description: 'Slot leader id as hex string'
        slotLeader  : String;

        @title      : 'Block Epoch Number'
        @description: 'Epoch number as integer'
        epochNumber : Integer;

        @title      : 'Block epoch Association'
        @description: 'Association to Epochs entity'
        epoch       : Association to Epochs
                          on epoch.epoch = $self.epochNumber;

        @title      : 'Block Slot within Epoch'
        @description: 'Slot number within the epoch as integer'
        epochSlot   : Integer;

        @title      : 'Block Size'
        @description: 'Block size in bytes'
        size        : Integer;

        @title      : 'Block Transaction Count'
        @description: 'Number of transactions in the block'
        txCount     : Integer;

        @title      : 'Block Fees'
        @description: 'Total fees in the block'
        fees        : Lovelace;
}

@title      : 'Epoch Entity'
@description: 'Epoch information entity definition'
entity Epochs {

        @title      : 'Epoch Number (Key)'
        @description: 'Epoch number as integer'
    key epoch         : Integer;

        @title      : 'Epoch Start Time'
        @description: 'Epoch start time as unix timestamp'
        startTime      : Integer;

        @title      : 'Epoch End Time'
        @description: 'Epoch end time as unix timestamp'
        endTime        : Integer;

        @title      : 'First Block Time'
        @description: 'First block time as unix timestamp'
        firstBlockTime : Integer;

        @title      : 'Last Block Time'
        @description: 'Last block time as unix timestamp'
        lastBlockTime  : Integer;

        @title      : 'Block Count'
        @description: 'Number of blocks in the epoch'
        blockCount     : Integer;

        @title      : 'Transaction Count'
        @description: 'Number of transactions in the epoch'
        txCount        : Integer;

        @title      : 'Total Output'
        @description: 'Total output in the epoch as string to avoid precision issues'
        output         : String;

        @title      : 'Total Fees'
        @description: 'Total fees in the epoch'
        fees           : Lovelace;

        @title      : 'Active Stake'
        @description: 'Total active stake in the epoch'
        activeStake    : Lovelace;
}

@title      : 'Pool Entity'
@description: 'Stake pool information entity definition'
entity Pools {

        @title      : 'Pool Id (Key)'
        @description: 'Unique stake pool identifier'
    key poolId         : String;

        @title      : 'VRF Key Hash'
        @description: 'Pool VRF key hash as hex string'
        vrfKeyHash     : String;

        @title      : 'Blocks Minted'
        @description: 'Total number of blocks minted by the pool'
        blocksMinted   : Integer;

        @title      : 'Blocks in Epoch'
        @description: 'Number of blocks minted in the current epoch'
        blocksEpoch    : Integer;

        @title      : 'Live Stake'
        @description: 'Current live stake delegated to the pool'
        liveStake      : Lovelace;

        @title      : 'Live Size'
        @description: 'Current live size as fraction of total active stake'
        liveSize       : Decimal(5, 4);

        @title      : 'Live Saturation'
        @description: 'Current live saturation as fraction of ideal size'
        liveSaturation : Decimal(5, 4);

        @title      : 'Live Delegators'
        @description: 'Current number of live delegators'
        liveDelegators : Integer;

        @title      : 'Active Stake'
        @description: 'Current active stake delegated to the pool'
        activeStake    : Lovelace;

        @title      : 'Active Size'
        @description: 'Current active size as fraction'
        activeSize     : Decimal(5, 4);

        @title      : 'Pledge'
        @description: 'Pool pledge in lovelace'
        pledge         : Lovelace;

        @title      : 'Margin'
        @description: 'Pool margin as fraction'
        margin         : Decimal(5, 4);

        @title      : 'Fixed Cost'
        @description: 'Pool fixed cost in lovelace'
        fixedCost      : Lovelace;

        @title      : 'Reward Account'
        @description: 'Pool reward account in bech32 format'
        rewardAccount  : String;
}

@title      : 'Drep Entity'
@description: 'Drep information entity definition'
entity Dreps {

        @title      : 'Drep Id (Key)'
        @description: 'Unique drep identifier'
    key drepId          : String;

        @title      : 'Drep VRF Key Hash'
        @description: 'Drep VRF key hash as hex string'
        hex             : String;

        @title      : 'Vote Power'
        @description: 'Amount of vote power in lovelace'
        amount          : Lovelace;

        @title      : 'Has Script'
        @description: 'Indicates if drep is a script drep'
        hasScript       : Boolean;

        @title      : 'Last Active Epoch'
        @description: 'Epoch number of last activity'
        lastActiveEpoch : Integer;

        @title      : 'Retired'
        @description: 'Indicates if drep is retired'
        retired         : Boolean;

        @title      : 'Expired'
        @description: 'Indicates if drep is expired'
        expired         : Boolean;
}

@title      : 'Address Entity'
@description: 'Address information entity definition'
entity Addresses : temporal {

        @title      : 'Bech32 Address (Key)'
        @description: 'The Bech32 encoded address string'
    key address       : Bech32;

        @title      : 'Associated Stake Address'
        @description: 'The associated stake address in bech32 format'
        stakeAddress  : Bech32;

        @title      : 'Address Type'
        @description: 'The type of address (base | enterprise | pointer | reward | script | unknown)'
        type          : String(20);

        @title      : 'Is Script Address'
        @description: 'Indicates if the address is a script address'
        isScript      : Boolean;

        @title      : 'Total Lovelace'
        @description: 'Total lovelace on this address'
        totalLovelace : Lovelace;

        @title      : 'Address Assets'
        @description: 'Composition of all assets on this address'
        assets        : Composition of many AddressAssets
                            on assets.address = $self;

        @title      : 'Address UTxOs'
        @description: 'Composition of all UTxOs on this address'
        utxos         : Composition of many AddressUTxOs
                            on utxos.address = $self;

        @title      : 'Address Has Assets'
        @description: 'Indicates if address has native assets'
        hasAssets     : Boolean;

        @title      : 'Address Has UTxOs'
        @description: 'Indicates if address has UTxOs'
        hasUTxOs      : Boolean;


}

@title      : 'Address Assets'
@description: 'Association entity for assets held by an address'
entity AddressAssets : temporal {

        @title      : 'Address (key)'
        @description: 'The Bech32 encoded address associated with the asset'
    key address : Association to Addresses;

        @title      : 'Asset Unit (key)'
        @description: 'The unique identifier for the asset unit'
    key unit    : AssetUnit;

        @title      : 'Asset Details'
        @description: 'Structural slice for asset details'
        asset   : AssetSlice;
}

@title      : 'Address UTxOs'
@description: 'Association entity for UTxOs held by an address'
entity AddressUTxOs : temporal {

        @title      : 'Address (key)'
        @description: 'The Bech32 encoded address associated with the UTxO'
    key address   : Association to Addresses;

        @title      : 'UTxO Key (key)'
        @description: 'The unique identifier for the UTxO (tx hash + index)'
    key hash      : Blake2b256;

        @title      : 'UTxO Index (key)'
        @description: 'The output index of the UTxO'
    key index     : Integer;

        @title      : 'Block Hash'
        @description: 'Block hash containing the UTxO'
        blockHash : Blake2b256;

        @title      : 'UTxO Data'
        @description: 'UTxO specific data'
        utxodata  : UTxODataSlice;

        @title      : 'Lovelace Amount'
        @description: 'Lovelace amount in the UTxO'
        lovelace  : Lovelace;

        @title      : 'UTxO Assets'
        @description: 'Assets in this UTxO'
        assets    : Composition of many UTxOAssets
                        on assets.utxo = $self;

        @title      : 'UTxO Has Assets'
        @description: 'Indicates if utxo has assets'
        hasAssets : Boolean;
}

@title      : 'UTxO Assets'
@description: 'Association entity for assets held by a UTxO'
entity UTxOAssets : temporal {

        @title: 'UTxO (key)'
    key utxo  : Association to AddressUTxOs; // utxo association

        @title      : 'Asset Unit'
        @description: 'The unique identifier for the asset unit'
        unit  : AssetUnit; // asset unit

        @title      : 'Asset Details'
        @description: 'Structural slice for asset details'
        asset : AssetSlice; // asset details
}

@title      : 'Accounts Entity'
@description: 'Account information entity definition'
entity Accounts : temporal {

        @title      : 'Stake Address (Key)'
        @description: 'The Bech32 encoded stake address string'
    key stakeAddress       : String;

        @title      : 'Active Status'
        @description: 'Indicates if the account is active'
        active             : Boolean;

        @title      : 'Last Active Epoch'
        @description: 'Epoch number of last activity'
        activeEpoch        : Integer;

        @title      : 'Controlled Amount'
        @description: 'Total controlled amount in lovelace'
        controlledAmount   : Lovelace;

        @title      : 'Rewards Sum'
        @description: 'Total rewards sum in lovelace'
        rewardsSum         : Lovelace;

        @title      : 'Withdrawals Sum'
        @description: 'Total withdrawals sum in lovelace'
        withdrawalsSum     : Lovelace;

        @title      : 'Reserves Sum'
        @description: 'Total reserves sum in lovelace'
        reservesSum        : Lovelace;

        @title      : 'Treasury Sum'
        @description: 'Total treasury sum in lovelace'
        treasurySum        : Lovelace;

        @title      : 'Withdrawable Amount'
        @description: 'Total withdrawable amount in lovelace'
        withdrawableAmount : Lovelace;

        @title      : 'Pool ID'
        @description: 'Associated pool ID'
        poolId             : Association to Pools;

        @title      : 'DRep ID'
        @description: 'Associated DRep ID'
        drepId             : Association to Dreps;

        @title      : 'Addresses'
        @description: 'All addresses for this account'
        Address            : Composition of many Addresses
                                 on Address.stakeAddress = $self.stakeAddress;

        @title      : 'Has Addresses'
        @description: 'Indicates if account has associated addresses'
        hasAddresses       : Boolean;
}

@title      : 'Transaction Entity'
@description: 'Transaction information entity definition'
entity Transactions {

        @title      : 'Transaction Hash (Key)'
        @description: 'The unique transaction identifier as hex string'
    key hash        : Blake2b256;

        @title      : 'Transaction  Block Hash'
        @description: 'The block hash containing the transaction'
        blockHash   : Blake2b256;

        @title      : 'Transaction  Block Height'
        @description: 'The block height containing the transaction'
        blockHeight : Integer;

        @title      : 'Transaction  Block Time'
        @description: 'The block time as integer unix timestamp'
        blockTime   : Integer64;

        @title      : 'Transaction Slot'
        @description: 'The slot number containing the transaction'
        slot        : Integer64;

        @title      : 'Transaction Index'
        @description: 'The transaction index within the block'
        txIndex     : Integer;

        @title      : 'Transaction Fee'
        @description: 'The transaction fee in lovelace'
        fee         : Lovelace;

        @title      : 'Transaction Deposit'
        @description: 'The deposit change in lovelace'
        deposit     : Lovelace;

        @title      : 'Transaction Size'
        @description: 'The transaction size in bytes'
        size        : Integer;

        @title      : 'Transaction Metadata'
        @description: 'The transaction metadata'
        metadata    : Composition of many TransactionMetadata
                          on metadata.tx = $self;

        @title      : 'Transaction Inputs'
        @description: 'The transaction inputs composition'
        inputs      : Composition of many TransactionInputs
                          on inputs.tx = $self;

        @title      : 'Transaction Outputs'
        @description: 'The transaction outputs composition'
        outputs     : Composition of many TransactionOutputs
                          on outputs.tx = $self;

        @title      : 'Transaction Has Metadata'
        @description: 'Indicates if transaction has metadata'
        hasMetadata : Boolean;

        @title      : 'Transaction Has Inputs'
        @description: 'Indicates if transaction has inputs'
        hasInputs   : Boolean;

        @title      : 'Transaction Has Outputs'
        @description: 'Indicates if transaction has outputs'
        hasOutputs  : Boolean;
}

@title      : 'Transaction Inputs'
@description: 'Projection for Transaction Inputs'
entity TransactionInputs {

        @title      : 'Transaction (key)'
        @description: 'The associated transaction'
    key tx           : Association to Transactions;

        @title      : 'Input Index (key)'
        @description: 'The input index of the input utxo'
    key inputIndex   : Integer;

        @title      : 'Input Address'
        @description: 'The associated address of the input utxo'
        address      : Association to Addresses;

        @title      : 'Input UTxO Data'
        @description: 'The UTxO specific data of the input utxo'
        utxoData     : UTxODataSlice; // input utxo data

        @title      : 'Input Lovelace Amount'
        @description: 'The lovelace amount of the input utxo'
        isCollateral : Boolean;

        @title      : 'Is Reference Input'
        @description: 'Indicates if the input is used as reference input'
        isReference  : Boolean;

        @title      : 'Input Assets'
        @description: 'Composed assets associated with the input utxo'
        assets       : Composition of many TransactionInputAssets
                           on assets.input = $self;

        @title      : 'Input Has Addresses'
        @description: 'Indicates if input has associated addresses'
        hasAddresses : Boolean;

        @title      : 'Input Has Assets'
        @description: 'Indicates if input has assets'
        hasAssets    : Boolean;
}

@title      : 'Transaction Input Assets'
@description: 'Projection for Transaction Input Assets'
entity TransactionInputAssets {

        @title      : 'Transaction Input (key)'
        @description: 'The associated transaction input'
    key input : Association to TransactionInputs;

        @title      : 'Asset Unit (key)'
        @description: 'The asset unit'
    key unit  : AssetUnit;

        @title      : 'Asset Details'
        @description: 'Structural slice for asset details'
        asset : AssetSlice;
}

@title      : 'Transaction Outputs'
@description: 'Projection for Transaction Outputs'
entity TransactionOutputs {

        @title      : 'Transaction (key)'
        @description: 'The associated transaction'
    key tx           : Association to Transactions;

        @title      : 'Output Index (key)'
        @description: 'The output index of the output utxo'
    key outputIndex  : Integer;

        @title      : 'Output Address'
        @description: 'The associated address of the output utxo'
        address      : Association to Addresses;

        @title      : 'UTxO Data'
        @description: 'The UTxO specific data of the output utxo'
        utxo         : UTxODataSlice;

        @title      : 'Transaction Output Assets'
        @description: 'Composed assets associated with the output utxo'
        assets       : Composition of many TransactionOutputAssets
                           on assets.output = $self;

        @title      : 'Has Addresses'
        @description: 'Indicates if output has associated addresses'
        hasAddresses : Boolean;

        @title      : 'Has Assets'
        @description: 'Indicates if output has assets'
        hasAssets    : Boolean;
}

@title      : 'Transaction Output Assets'
@description: 'Projection for Transaction Output Assets'
entity TransactionOutputAssets {

        @title      : 'Transaction Output (key)'
        @description: 'The associated transaction output'
    key output : Association to TransactionOutputs;

        @title      : 'Asset Unit (key)'
        @description: 'The asset unit'
    key unit   : AssetUnit;

        @title      : 'Asset Details'
        @description: 'Structural slice for asset details'
        asset  : AssetSlice;
}

@title      : 'Transaction Metadata'
@description: 'Projection for Transaction Metadata'
entity TransactionMetadata {

        @title      : 'ID (key)'
        @description: 'Unique identifier for the metadata entry'
    key id      : Integer;

        @title      : 'Transaction (key)'
        @description: 'The associated transaction'
    key tx      : Association to Transactions;

        @title      : 'Label'
        @description: 'The metadata label as string'
        label   : String;

        @title      : 'Metadata Payload'
        @description: 'The metadata payload as JSON string'
        payload : LargeString;
}

//-----------------------------------------------------
// M2 - transaction building and submission entities
//-----------------------------------------------------
@title      : 'Ledger Protocol Parameters'
@description: 'Entity for storing ledger protocol parameters for transaction building'
entity LedgerProtocolParameters {

        @title      : 'Network (key)'
        @description: 'The Cardano network type mainnet | preprod | preview'
    key network               : String(16);

        @title      : 'Epoch Number (key)'
        @description: 'The epoch number these parameters are valid for'
    key epoch                 : Integer;

        @title      : 'Minimum Fee A'
        @description: 'The minimum fee factor a for transaction fee calculation'
        minFeeA               : Integer;

        @title      : 'Minimum Fee B'
        @description: 'The minimum fee constant b for transaction fee calculation'
        minFeeB               : Integer;

        @title      : 'Maximum Sizes'
        @description: 'Maximum sizes for blocks and transactions'
        maxBlockSize          : Integer;

        @title      : 'Maximum Transaction Size'
        @description: 'The maximum size for a transaction in bytes'
        maxTxSize             : Integer;

        @title      : 'Maximum Block Header Size'
        @description: 'The maximum size for a block header in bytes'
        maxBlockHeaderSize    : Integer;

        @title      : 'Key Deposit'
        @description: 'The key deposit amount in lovelace'
        keyDeposit            : String(32);

        @title      : 'Pool Deposit'
        @description: 'The pool deposit amount in lovelace'
        poolDeposit           : String(32);

        @title      : 'Epochs for Pool Retirement'
        @description: 'The number of epochs before a retiring pool is removed from the ledger'
        eMax                  : Integer;

        @title      : 'nOpt Parameter'
        @description: 'Stake pool target number parameter nOpt'
        nOpt                  : Integer;

        @title      : 'a0 Parameter'
        @description: 'Pool pledge influence parameter a0'
        a0                    : Decimal(18, 10);

        @title      : 'Rho Parameter'
        @description: 'Monetary expansion parameter rho'
        rho                   : Decimal(18, 10);

        @title      : 'Tau Parameter'
        @description: 'Treasury cut parameter tau'
        tau                   : Decimal(18, 10);

        @title      : 'Minimum Pool Cost'
        @description: 'The minimum pool cost in lovelace'
        minPoolCost           : String(32);

        @title      : 'Decentralisation Parameter'
        @description: 'The decentralisation parameter of the network'
        decentralisationParam : Decimal(18, 10);

        @title      : 'Extra Entropy'
        @description: 'The extra entropy for pool key generation'
        extraEntropy          : String(128);

        @title      : 'Protocol Major Version'
        @description: 'The major version of the protocol'
        protocolMajorVer      : Integer;

        @title      : 'Protocol Minor Version'
        @description: 'The minor version of the protocol'
        protocolMinorVer      : Integer;

        @title      : 'Min UTxO Value'
        @description: 'The minimum UTxO value in lovelace'
        minUtxo               : String(32);

        @title      : 'Min Pool Cost'
        @description: 'The minimum pool cost in lovelace'
        nonce                 : String(128);

        @title      : 'Cost Models'
        @description: 'The cost models for script execution as JSON blob'
        costModels            : LargeString;

        @title      : 'Execution Prices'
        @description: 'The execution prices for script execution'
        priceMem              : Decimal(18, 10);

        @title      : 'Execution Steps Price'
        @description: 'The execution steps price for script execution'
        priceStep             : Decimal(18, 10);

        @title      : 'Maximum Execution Units'
        @description: 'The maximum execution units for transactions and blocks'
        maxTxExMem            : String(32);

        @title      : 'Maximum Execution Steps'
        @description: 'The maximum execution steps for transactions and blocks'
        maxTxExSteps          : String(32);

        @title      : 'Maximum Block Execution Units'
        @description: 'The maximum execution units for blocks'
        maxBlockExMem         : String(32);

        @title      : 'Maximum Block Execution Steps'
        @description: 'The maximum execution steps for blocks'
        maxBlockExSteps       : String(32);

        @title      : 'Maximum Value Size'
        @description: 'The maximum size for a value in bytes'
        maxValSize            : String(32);

        @title      : 'Collateral Percent'
        @description: 'The required collateral percentage for script transactions'
        collateralPercent     : Integer;

        @title      : 'Maximum Collateral Inputs'
        @description: 'The maximum number of collateral inputs for script transactions'
        maxCollateralInputs   : Integer;

        @title      : 'Coins Per UTxO Size'
        @description: 'The coins per UTxO size parameter for calculating min UTxO value'
        coinsPerUtxoSize      : String(32);

        @title      : 'Coins Per UTxO Word'
        @description: 'The coins per UTxO word parameter for calculating min UTxO value (alonzo legacy)'
        coinsPerUtxoWord      : String(32);

        @title      : 'Fetched At'
        @description: 'Timestamp when these parameters were fetched'
        fetchedAt             : Timestamp;

        @title      : 'Source'
        @description: 'Source from which these parameters were fetched'
        source                : String(32);
}

@title      : 'Transaction Builds'
@description: 'Entity for storing transaction build attempts and details'
entity TransactionBuilds : temporal {

        @title      : 'Build ID (key)'
        @description: 'Unique identifier for the transaction build attempt'
    key id             : UUID;

        @title      : 'Network'
        @description: 'The Cardano network type mainnet | preprod | preview'
        network        : String(10);

        @title      : 'Builder Engine'
        @description: 'The transaction builder engine used for this build'
        builderEngine  : String(20);

        @title      : 'Sender Address'
        @description: 'The sender/source address'
        senderAddress  : Bech32;

        @title      : 'Change Address'
        @description: 'The change address (defaults to sender address if not specified)'
        changeAddress  : Bech32;

        @title      : 'Unsigned Tx CBOR'
        @description: 'The unsigned transaction CBOR as hex string'
        unsignedTxCbor : LargeString;

        @title      : 'Tx Body Hash'
        @description: 'The transaction body hash as hex string'
        txBodyHash     : Blake2b256;

        @title      : 'Estimated Fee'
        @description: 'The estimated transaction fee in lovelace'
        fee            : Lovelace;

        @title      : 'Transaction Size'
        @description: 'The transaction size in bytes'
        size           : Integer;

        @title      : 'Build Created At'
        @description: 'The timestamp when the build was created'
        createdAt      : Integer64;

        @title      : 'Build Inputs'
        @description: 'The inputs used in the transaction build'
        inputs         : Composition of many TransactionBuildInputs
                             on inputs.build = $self;

        @title      : 'Build Outputs'
        @description: 'The outputs created in the transaction build'
        outputs        : Composition of many TransactionBuildOutputs
                             on outputs.build = $self;

        @title      : 'Associated Submission'
        @description: 'Association to the transaction submission if submitted'
        submission     : Association to one TransactionSubmissions
                             on submission.build = $self;

        @title      : 'Has Inputs'
        @description: 'Indicates if the build has inputs'
        hasInputs      : Boolean;

        @title      : 'Has Outputs'
        @description: 'Indicates if the build has outputs'
        hasOutputs     : Boolean;

        @title      : 'Was Submitted'
        @description: 'Indicates if the build was submitted'
        wasSubmitted   : Boolean;
}

@title      : 'Transaction Build Inputs'
@description: 'Entity for storing transaction build input details'
entity TransactionBuildInputs {

        @title      : 'Build (key)'
        @description: 'Association to parent transaction build'
    key build       : Association to TransactionBuilds;

        @title      : 'Input Index (key)'
        @description: 'Index of the input in the transaction build'
    key inputIndex  : Integer;

        @title      : 'UTxO Transaction Hash'
        @description: 'UTxO transaction hash'
        txHash      : Blake2b256;

        @title      : 'UTxO Output Index'
        @description: 'UTxO output index'
        outputIndex : Integer;

        @title      : 'Input Address'
        @description: 'UTxO address'
        address     : Bech32;

        @title      : 'Input Lovelace Amount'
        @description: 'Lovelace amount of the input UTxO'
        lovelace    : Lovelace;

        @title      : 'Input Assets'
        @description: 'Assets associated with the input UTxO'
        assets      : Composition of many TransactionBuildInputAssets
                          on assets.input = $self;

        @title      : 'Input Has Assets'
        @description: 'Indicates if input has native assets'
        hasAssets   : Boolean;
}

@title      : 'Transaction Build Input Assets'
@description: 'Entity for storing assets associated with transaction build inputs'
entity TransactionBuildInputAssets {

        @title      : 'Transaction Build Input (key)'
        @description: 'Build input association'
    key input : Association to TransactionBuildInputs;

        @title      : 'Asset Unit (key)'
        @description: 'Asset unit (policyId + assetNameHex)'
    key unit  : AssetUnit;

        @title      : 'Asset Details'
        @description: 'Structural slice for asset details'
        asset : AssetSlice;
}

@title      : 'Transaction Build Outputs'
@description: 'Entity for storing transaction build output details'
entity TransactionBuildOutputs {

        @title      : 'Build (key)'
        @description: 'Association to parent transaction build'
    key build       : Association to TransactionBuilds;

        @title      : 'Output Index (key)'
        @description: 'Index in outputs array'
    key outputIndex : Integer;

        @title      : 'Recipient Address'
        @description: 'Recipient address in bech32 format'
        address     : Bech32;

        @title      : 'Lovelace Amount'
        @description: 'Lovelace amount to send'
        lovelace    : Lovelace;

        @title      : 'Is Change Output'
        @description: 'Indicates if this is the change output'
        isChange    : Boolean;

        @title      : 'Output Assets'
        @description: 'Assets associated with this output'
        assets      : Composition of many TransactionBuildOutputAssets
                          on assets.output = $self;

        @title      : 'Has Assets'
        @description: 'Indicates if output has native assets'
        hasAssets   : Boolean;
}

@title      : 'Transaction Build Output Assets'
@description: 'Entity for storing assets associated with transaction build outputs'
entity TransactionBuildOutputAssets {

        @title      : 'Transaction Build Output (key)'
        @description: 'Association to parent transaction build output'
    key output : Association to TransactionBuildOutputs;

        @title      : 'Asset Unit (key)'
        @description: 'Asset unit (policyId + assetNameHex)'
    key unit   : AssetUnit;

        @title      : 'Asset Details'
        @description: 'Structural slice for asset details'
        asset  : AssetSlice;

}

@title      : 'Transaction Submissions'
@description: 'Entity for storing transaction submission attempts and status'
entity TransactionSubmissions {

        @title      : 'Submission ID (key)'
        @description: 'Unique identifier for the transaction submission'
    key id                 : UUID;

        @title      : 'Associated Build'
        @description: 'Association to the transaction build being submitted'
        build              : Association to TransactionBuilds;

        @title      : 'Signged Tx CBOR'
        @description: 'The signed transaction CBOR as hex string'
        signedTxCbor       : LargeString;

        @title      : 'Transaction Hash'
        @description: 'Actual transaction hash after signing'
        txHash             : Blake2b256;

        @title      : 'Submission Time'
        @description: 'Submission time as unix timestamp'
        submittedAt        : Integer64;

        @title      : 'Submission Status'
        @description: 'Current status of the transaction submission (pending, submitted, confirmed, failed, rejected)'
        status             : String(20);

        @title      : 'Error Code'
        @description: 'Error code if failed'
        errorCode          : String(50);

        @title      : 'Error Message'
        @description: 'Detailed error message if failed'
        errorMessage       : LargeString;

        @title      : 'Retry Count'
        @description: 'Number of retry attempts'
        retryCount         : Integer;

        @title      : 'Submission Errors'
        @description: 'Composition of errors associated with this submission'
        errors             : Composition of many TransactionSubmissionErrors
                                 on errors.submission = $self;

        @title      : 'Has Errors'
        @description: 'Indicates if submission has errors'
        hasErrors          : Boolean;
}

@title      : 'Transaction Submission Errors'
@description: 'Entity for storing errors encountered during transaction submission'
entity TransactionSubmissionErrors {

        @title      : 'Error ID (key)'
        @description: 'Unique identifier for the submission error'
    key id            : UUID;

        @title      : 'Associated Submission'
        @description: 'Association to parent transaction submission'
        submission    : Association to TransactionSubmissions;

        @title      : 'Error Occurred At'
        @description: 'Timestamp when the error occurred as unix timestamp'
        occurredAt    : Integer64;

        @title      : 'Error Type'
        @description: 'Type/category of the error encountered'
        errorType     : String(50);

        @title      : 'Error Code'
        @description: 'Specific error code'
        errorCode     : String(50);

        @title      : 'Error Message'
        @description: 'Detailed error message'
        errorMessage  : LargeString;

        @title      : 'Error Details'
        @description: 'Additional error context as JSON'
        errorDetails  : LargeString;

        @title      : 'Is Recoverable'
        @description: 'Indicates if error is recoverable via retry'
        isRecoverable : Boolean;
}

//-----------------------------------------------------
// M3 - External Signing Workflow Entities
//-----------------------------------------------------

@title      : 'Signing Request Status'
@description: 'Enum type for signing request status'
type SigningStatus : String(20) enum {
    pending   = 'pending';
    signed    = 'signed';
    verified  = 'verified';
    submitted = 'submitted';
    expired   = 'expired';
    failed    = 'failed';
}

@title      : 'Signing Requests'
@description: 'Entity for tracking external signing requests and their workflow state'
entity SigningRequests {

        @title      : 'Signing Request ID (key)'
        @description: 'Unique identifier for the signing request'
    key id               : UUID;

        @title      : 'Associated Build'
        @description: 'Association to the transaction build being signed'
        build            : Association to TransactionBuilds;

        @title      : 'Transaction Body Hash'
        @description: 'The hash of the transaction body (data to be signed)'
        txBodyHash       : Blake2b256;

        @title      : 'Unsigned Transaction CBOR'
        @description: 'The unsigned transaction in CBOR hex format'
        unsignedTxCbor   : LargeString;

        @title      : 'Network'
        @description: 'Cardano network (mainnet | preprod | preview)'
        network          : String(10);

        @title      : 'Status'
        @description: 'Current status of the signing request'
        status           : SigningStatus default 'pending';

        @title      : 'Created At'
        @description: 'Timestamp when the signing request was created'
        createdAt        : Timestamp;

        @title      : 'Expires At'
        @description: 'Timestamp when the signing request expires'
        expiresAt        : Timestamp;

        @title      : 'Signed At'
        @description: 'Timestamp when the transaction was signed'
        signedAt         : Timestamp;

        @title      : 'Submitted At'
        @description: 'Timestamp when the transaction was submitted'
        submittedAt      : Timestamp;

        @title      : 'Cardano CLI Command'
        @description: 'Example command to sign with Cardano CLI'
        cardanoCliCommand : LargeString;

        @title      : 'CIP-30 CBOR'
        @description: 'Transaction CBOR for browser wallet signing (CIP-30)'
        cip30TxCbor      : LargeString;

        @title      : 'Signer Type'
        @description: 'Type of signer used (cardano-cli | browser-wallet | hardware-wallet | custom)'
        signerType       : String(20);

        @title      : 'Signer Info'
        @description: 'Additional information about the signer (wallet name, etc.)'
        signerInfo       : String(100);

        @title      : 'Signature Verifications'
        @description: 'Composition of signature verification attempts'
        verifications    : Composition of many SignatureVerifications
                              on verifications.signingRequest = $self;

        @title      : 'Associated Submission'
        @description: 'Association to the transaction submission (if submitted)'
        submission       : Association to TransactionSubmissions;

        @title      : 'Error Message'
        @description: 'Error message if signing or verification failed'
        errorMessage     : LargeString;
}

@title      : 'Signature Verifications'
@description: 'Entity for storing signature verification results'
entity SignatureVerifications {

        @title      : 'Verification ID (key)'
        @description: 'Unique identifier for the verification attempt'
    key id               : UUID;

        @title      : 'Associated Signing Request'
        @description: 'Association to the parent signing request'
        signingRequest   : Association to SigningRequests;

        @title      : 'Signed Transaction CBOR'
        @description: 'The signed transaction CBOR that was verified'
        signedTxCbor     : LargeString;

        @title      : 'Is Valid'
        @description: 'Whether the signature is valid'
        isValid          : Boolean;

        @title      : 'Transaction Body Hash'
        @description: 'The verified transaction body hash'
        txBodyHash       : Blake2b256;

        @title      : 'Witness Count'
        @description: 'Number of signatures found'
        witnessCount     : Integer;

        @title      : 'Signer Key Hashes'
        @description: 'JSON array of public key hashes that signed the transaction'
        signerKeyHashes  : LargeString;

        @title      : 'Error Message'
        @description: 'Error message if verification failed'
        errorMessage     : LargeString;

        @title      : 'Warnings'
        @description: 'JSON array of warning messages'
        warnings         : LargeString;

        @title      : 'Verified At'
        @description: 'Timestamp when the verification was performed'
        verifiedAt       : Timestamp;
}
