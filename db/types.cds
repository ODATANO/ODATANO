// -----------------------------------------------------
// Basic Cardano Types
// -----------------------------------------------------
@title      : 'Blake2b224'
@description: '28 bytes Blake2b hash as hex string'
type Blake2b224       : String(56);

@title      : 'Blake2b256'
@description: '32 bytes Blake2b hash as hex string'
type Blake2b256       : String(64);

@title      : 'HexBytes'
@description: 'CBOR / bytes as hex string'
type HexBytes         : String(5000);

@title      : 'Lovelace'
@description: 'Amount of ADA in lovelace (1 ADA = 1_000_000 lovelace)'
type Lovelace         : Decimal(20, 0);

@title      : 'Asset Unit'
@description: 'Concatenation of policyId and assetNameHex representing a unique asset'
type AssetUnit        : String(120);

@title      : 'Metadata Label'
@description: 'Metadata label as string — a uint64 (0 .. 18446744073709551615, up to 20 digits)'
type MetadataLabel    : String(20); // was String(5): truncated labels above 5 digits

@title      : 'Bech32 Address'
@description: 'Bech32 encoded address string'
type Bech32           : String(120);

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
    assetNameHex : HexBytes;

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
    @description: 'Metadata label as string — a uint64 (0 .. 18446744073709551615, up to 20 digits)'
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
    inlineDatum         : LargeString;

    @title      : 'Reference Script Hash'
    @description: 'The reference script hash associated with the UTxO'
    referenceScriptHash : Blake2b256;
}

// -----------------------------------------------------
// Status Enums
// -----------------------------------------------------
@title      : 'Submission Status'
@description: 'Enum type for transaction submission status'
type SubmissionStatus : String(20) enum {
    pending = 'pending';
    submitted = 'submitted';
    confirmed = 'confirmed';
    failed = 'failed';
}

@title      : 'Signing Request Status'
@description: 'Enum type for signing request status'
type SigningStatus    : String(20) enum {
    pending = 'pending';
    signed = 'signed';
    verified = 'verified';
    submitting = 'submitting';
    submitted = 'submitted';
    expired = 'expired';
    failed = 'failed';
}

@title      : 'Crawl Sync Status'
@description: 'Enum type for the chain crawler / pre-sync cursor state'
type CrawlSyncStatus  : String(12) enum {
    stopped = 'stopped'; // crawler not running
    syncing = 'syncing'; // actively catching up / streaming
    synced = 'synced'; // caught up to (tip - confirmationDepth)
    error = 'error'; // circuit-broken after repeated failures
}

@title      : 'Reorg Status'
@description: 'Enum type for the lifecycle of a handled chain rollback'
type ReorgStatus      : String(12) enum {
    detected = 'detected';
    rolling_back = 'rolling_back';
    reindexing = 'reindexing';
    completed = 'completed';
}

@title      : 'Wallet Job Status'
@description: 'Enum type for the wallet-worker job lifecycle'
type WalletJobStatus  : String(12) enum {
    pending = 'pending'; // queued, waiting for the worker to pick it up
    building = 'building'; // build + sign + submit in progress
    submitted = 'submitted'; // accepted into the mempool, awaiting confirmation
    confirmed = 'confirmed'; // on-chain at the configured confirmation depth
    failed = 'failed'; // terminal failure (see errorCode/errorMessage)
    cancelled = 'cancelled'; // cancelled by the caller while still pending
}

@title      : 'Wallet Job Kind'
@description: 'Enum type for the transaction kind a wallet-worker job executes'
type WalletJobKind    : String(12) enum {
    simpleAda = 'simpleAda'; // BuildSimpleAdaTransaction payload
    metadata = 'metadata'; // BuildTransactionWithMetadata payload
    multiAsset = 'multiAsset'; // BuildMultiAssetTransaction payload
    mint = 'mint'; // BuildMintTransaction payload
    plutusSpend = 'plutusSpend'; // BuildPlutusSpendTransaction payload
    submitSigned = 'submitSigned'; // externally signed CBOR — managed submit + confirm only
}

@title      : 'Worker Signer Type'
@description: 'Enum type for how a worker wallet signs transactions'
type WorkerSignerType : String(10) enum {
    hsm = 'hsm'; // PKCS#11 HSM (production) — keys never leave the module
    software = 'software'; // operator-configured Ed25519 key (dev/test)
}

// -----------------------------------------------------
// Parsed Transaction (ParseTransactionCbor action result)
// -----------------------------------------------------
@title      : 'Parsed Transaction Input'
@description: 'A UTxO reference consumed by a parsed transaction'
type ParsedInput {
    @title      : 'UTxO Transaction Hash'
    @description: 'The 32-byte hash of the transaction that produced this UTxO'
    txHash      : Blake2b256;

    @title      : 'UTxO Output Index'
    @description: 'The output index within the producing transaction'
    outputIndex : Integer;
}

@title      : 'Parsed Asset'
@description: 'A single asset entry from a parsed transaction output or mint value'
type ParsedAsset {
    @title      : 'Asset Unit'
    @description: 'Concatenation of policyId (56 hex) and assetNameHex (0-64 hex)'
    unit     : AssetUnit;

    @title      : 'Asset Quantity'
    @description: 'Signed decimal string (BigInt-safe); negative entries indicate burns in a mint value'
    quantity : String(40);
}

@title      : 'Parsed Transaction Output'
@description: 'A single output of a parsed transaction'
type ParsedOutput {
    @title      : 'Output Address'
    @description: 'Bech32 recipient address'
    address            : Bech32;

    @title      : 'Output Lovelace'
    @description: 'ADA amount in lovelace (decimal string)'
    lovelace           : Lovelace;

    @title      : 'Output Assets'
    @description: 'Native assets attached to the output'
    assets             : many ParsedAsset;

    @title      : 'Datum Hash'
    @description: 'Blake2b-256 datum hash when the output references a datum by hash; null if inline or absent'
    datumHash          : Blake2b256;

    @title      : 'Inline Datum CBOR'
    @description: 'Hex-encoded PlutusData CBOR when the output carries an inline datum; null otherwise'
    inlineDatumHex     : LargeString;

    @title      : 'Reference Script CBOR'
    @description: 'Hex-encoded CIP-33 reference script CBOR when present; null otherwise'
    referenceScriptHex : LargeString;
}

@title      : 'Parsed Witness Counts'
@description: 'Counts of witness entries in a parsed transaction (no secrets included)'
type ParsedWitnesses {
    @title      : 'VKey Witness Count'
    @description: 'Number of Ed25519 verification-key witnesses'
    vkeyCount     : Integer;

    @title      : 'Native Script Count'
    @description: 'Number of native scripts in the witness set'
    nativeScripts : Integer;

    @title      : 'Plutus Script Count'
    @description: 'Total count of Plutus V1/V2/V3 scripts in the witness set'
    plutusScripts : Integer;

    @title      : 'Plutus Data Count'
    @description: 'Number of PlutusData entries attached as witnesses'
    plutusData    : Integer;

    @title      : 'Redeemer Count'
    @description: 'Number of redeemers in the witness set'
    redeemers     : Integer;
}

@title      : 'Parsed Transaction'
@description: 'Structured view of a hex-encoded transaction CBOR. Returned by the ParseTransactionCbor action.'
type ParsedTransaction {
    @title      : 'Transaction Body Hash'
    @description: 'Blake2b-256 hash of the transaction body. Stable across signed/unsigned CBOR of the same body.'
    txHash          : Blake2b256;

    @title      : 'Network'
    @description: '"mainnet" or "testnet" from the tx body network ID byte; null if absent. preview vs preprod cannot be distinguished from CBOR alone.'
    network         : String(10);

    @title      : 'Inputs'
    @description: 'UTxOs consumed by the transaction'
    inputs          : many ParsedInput;

    @title      : 'Outputs'
    @description: 'Outputs produced by the transaction'
    outputs         : many ParsedOutput;

    @title      : 'Validity Interval Start'
    @description: 'Slot number at which the transaction becomes valid (decimal string); null if absent'
    validityStart   : String(20);

    @title      : 'Validity Interval End'
    @description: 'TTL slot number after which the transaction becomes invalid (decimal string); null if absent'
    validityEnd     : String(20);

    @title      : 'Fee'
    @description: 'Transaction fee in lovelace'
    fee             : Lovelace;

    @title      : 'Mint'
    @description: 'Signed native-asset mint/burn entries; empty array if the tx does not mint'
    mint            : many ParsedAsset;

    @title      : 'Metadata Labels'
    @description: 'Metadata labels (uint64 as decimal strings) present in the auxiliary data; full payload via GetMetadataByTxHash once submitted'
    metadataLabels  : many String;

    @title      : 'Collateral Inputs'
    @description: 'Collateral UTxOs for phase-2 validation (empty when no Plutus scripts run)'
    collateral      : many ParsedInput;

    @title      : 'Required Signers'
    @description: '28-byte Ed25519 key hashes listed in the tx body required_signers field'
    requiredSigners : many Blake2b224;

    @title      : 'Script Data Hash'
    @description: 'Blake2b-256 hash over datum/redeemer/costmodels section; null if no Plutus data is present'
    scriptDataHash  : Blake2b256;

    @title      : 'Witness Counts'
    @description: 'Shape summary of the witness set (no secret material exposed)'
    witnesses       : ParsedWitnesses;
}
