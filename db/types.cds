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
@description: 'Metadata label as string (max 5 digits)'
type MetadataLabel    : String(5);

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
    submitted = 'submitted';
    expired = 'expired';
    failed = 'failed';
}
