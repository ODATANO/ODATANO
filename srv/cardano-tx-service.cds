using {odatano.cardano as db} from '../db/schema';

/**
 * Cardano Transaction Service
 *
 * Handles transaction building and submission operations.
 * Separate from the read-only CardanoODataService to provide
 * clear separation between general query and command operations.
 */
service CardanoTransactionService @(impl: 'srv/cardano-tx-service') {
    // ---------------------------------------------------------------------------
    // Entity Projections - Transaction Building & Submission
    // ---------------------------------------------------------------------------

    @title      : 'Transaction Builds'
    @description: 'Projection for Transaction Builds'
    entity TransactionBuilds            as projection on db.TransactionBuilds;

    @title      : 'Transaction Build Inputs'
    @description: 'Projection for Transaction Build Inputs'
    entity TransactionBuildInputs       as projection on db.TransactionBuildInputs;

    @title      : 'Transaction Build Outputs'
    @description: 'Projection for Transaction Build Outputs'
    entity TransactionBuildOutputs      as projection on db.TransactionBuildOutputs;

    @title      : 'Transaction Build Input Assets'
    @description: 'Projection for Transaction Build Input Assets'
    entity TransactionBuildInputAssets  as projection on db.TransactionBuildInputAssets;

    @title      : 'Transaction Build Output Assets'
    @description: 'Projection for Transaction Build Output Assets'
    entity TransactionBuildOutputAssets as projection on db.TransactionBuildOutputAssets;

    @title      : 'Transaction Submissions'
    @description: 'Projection for Transaction Submissions'
    entity TransactionSubmissions       as projection on db.TransactionSubmissions;

    @title      : 'Transaction Submission Errors'
    @description: 'Projection for Transaction Submission Errors'
    entity TransactionSubmissionErrors  as projection on db.TransactionSubmissionErrors;

    // ---------------------------------------------------------------------------
    // Transaction Building Actions
    // ---------------------------------------------------------------------------

    @title      : 'Build Simple ADA Transaction'
    @description: 'Build a simple ADA transfer transaction from sender to recipient with specified amount and change address'
    action BuildSimpleAdaTransaction(
                                     @title: 'Sender Address'
                                     @description: 'The Bech32 encoded address of the sender'
                                     senderAddress: db.Bech32,
                                     @title: 'Recipient Address'
                                     @description: 'The Bech32 encoded address of the recipient'
                                     recipientAddress: db.Bech32,
                                     @title: 'Lovelace Amount'
                                     @description: 'The amount of ADA to send in lovelace'
                                     lovelaceAmount: db.Lovelace,
                                     @title: 'Change Address'
                                     @description: 'The Bech32 encoded address for returning change -defaults to sender address if not specified'
                                     changeAddress: db.Bech32) returns TransactionBuilds;

    @title : 'Build Transaction with Metadata'
    @description: 'Build a transaction with custom metadata from sender to recipient with specified amount and change address'
    action BuildTransactionWithMetadata(
                                            @title: 'Sender Address'
                                            @description: 'The Bech32 encoded address of the sender'
                                            senderAddress: db.Bech32,
                                            @title: 'Recipient Address'
                                            @description: 'The Bech32 encoded address of the recipient'
                                            recipientAddress: db.Bech32,
                                            @title: 'Lovelace Amount'
                                            @description: 'The amount of ADA to send in lovelace'
                                            lovelaceAmount: db.Lovelace,
                                            @title: 'Change Address'
                                            @description: 'The Bech32 encoded address for returning change -defaults to sender address if not specified'
                                            changeAddress: db.Bech32,
                                            @title: 'Metadata JSON'
                                            @description: 'The JSON representation of the transaction metadata as string'
                                            metadataJson: String) returns TransactionBuilds;

    @title : 'Build Multi-Asset Transaction'
    @description: 'Build a transaction to send native assets (tokens) along with ADA'
    action BuildMultiAssetTransaction(
                                        @title: 'Sender Address'
                                        @description: 'The Bech32 encoded address of the sender'
                                        senderAddress: db.Bech32,
                                        @title: 'Recipient Address'
                                        @description: 'The Bech32 encoded address of the recipient'
                                        recipientAddress: db.Bech32,
                                        @title: 'Lovelace Amount'
                                        @description: 'The amount of ADA to send in lovelace'
                                        lovelaceAmount: db.Lovelace,
                                        @title: 'Assets JSON'
                                        @description: 'JSON array of assets to send (format: [{"unit":"policyId+assetName","quantity":"amount"}])'
                                        assetsJson: String,
                                        @title: 'Change Address'
                                        @description: 'The Bech32 encoded address for returning change -defaults to sender address if not specified'
                                        changeAddress: db.Bech32) returns TransactionBuilds;

    @title : 'Build Minting Transaction'
    @description: 'Build a transaction to mint or burn native assets'
    action BuildMintTransaction(
                                @title: 'Sender Address'
                                @description: 'The Bech32 encoded address of the sender (pays fees)'
                                senderAddress: db.Bech32,
                                @title: 'Recipient Address'
                                @description: 'The Bech32 encoded address to receive minted assets'
                                recipientAddress: db.Bech32,
                                @title: 'Lovelace Amount'
                                @description: 'The amount of ADA to send with minted assets in lovelace'
                                lovelaceAmount: db.Lovelace,
                                @title: 'Mint Actions JSON'
                                @description: 'JSON array of mint/burn actions (format: [{"assetUnit":"policyId+assetName","quantity":"amount"}])'
                                mintActionsJson: String,
                                @title: 'Minting Policy Script'
                                @description: 'The minting policy script in CBOR hex format'
                                mintingPolicyScript: String,
                                @title: 'Change Address'
                                @description: 'The Bech32 encoded address for returning change -defaults to sender address if not specified'
                                changeAddress: db.Bech32) returns TransactionBuilds;
                                            
    @title      : 'Get Build Details'
    @description: 'Retrieve transaction build details using the Build Id'
    action GetBuildDetails(
                           @title: 'Build Id'
                           @description: 'The unique identifier of the transaction build'
                           buildId: UUID)                      returns TransactionBuilds;

    @title      : 'Submit Transaction'
    @description: 'Submit a transaction to the Cardano network using a build ID and signed CBOR'
    action SubmitTransaction(
                             @title: 'Build Id'
                             @description: 'The unique identifier of the transaction build'
                             buildId: UUID,
                             @title: 'Signed Transaction CBOR'
                             @description: 'The CBOR of the signed transaction'
                             signedTxCbor: String)             returns TransactionSubmissions;

    @title      : 'Submit Signed Transaction'
    @description: 'Submit a signed transaction to the Cardano network'
    action SubmitSignedTransaction(
                                   @title: 'Signed Transaction CBOR'
                                   @description: 'The CBOR of the signed transaction'
                                   signedTxCbor: String,
                                   @title: 'Network'
                                   @description: 'The Cardano network to submit the transaction to (e.g., mainnet, testnet)'
                                   network: String(10))        returns TransactionSubmissions;

    @title      : 'Check Submission Status'
    @description: 'Check the status of a submitted transaction using the Submission Id'
    action CheckSubmissionStatus(
                                 @title: 'Submission Id'
                                 @description: 'The unique identifier of the transaction submission'
                                 submissionId: UUID)           returns TransactionSubmissions;

    // ---------------------------------------------------------------------------
    // M3 - External Signing Workflow Entities & Actions
    // ---------------------------------------------------------------------------

    @title      : 'Signing Requests'
    @description: 'Projection for Signing Requests - tracks external signing workflow'
    entity SigningRequests              as projection on db.SigningRequests;

    @title      : 'Signature Verifications'
    @description: 'Projection for Signature Verifications - stores verification results'
    entity SignatureVerifications       as projection on db.SignatureVerifications;

    @title      : 'Create Signing Request'
    @description: 'Create a signing request for external signing. Returns transaction details, signing instructions, and CLI commands. The request is persisted for audit trail.'
    action CreateSigningRequest(
                                @title: 'Build ID'
                                @description: 'The unique identifier of the transaction build'
                                buildId: UUID,
                                @title: 'Message to Signer'
                                @description: 'A message to include for the signer'
                                message: String)             returns SigningRequests;

    @title      : 'Get Signing Request'
    @description: 'Retrieve an existing signing request by ID'
    action GetSigningRequest(
                             @title: 'Signing Request ID'
                             @description: 'The unique identifier of the signing request'
                             signingRequestId: UUID)         returns SigningRequests;

    @title      : 'Verify Signature'
    @description: 'Verify the signature of a signed transaction. Stores the verification result for audit trail.'
    action VerifySignature(
                           @title: 'Signing Request ID'
                           @description: 'The signing request to verify against'
                           signingRequestId: UUID,
                           @title: 'Signed Transaction CBOR'
                           @description: 'The signed transaction CBOR to verify'
                           signedTxCbor: String,
                           @title: 'Signer Type'
                           @description: 'Type of signer used (cardano-cli | browser-wallet | hardware-wallet | custom)'
                           signerType: String(20),
                           @title: 'Signer Info'
                           @description: 'Additional signer information (wallet name, etc.)'
                           signerInfo: String(100))          returns SignatureVerifications;

    @title      : 'Submit Verified Transaction'
    @description: 'Verify and submit a signed transaction in one step. Updates the signing request status and creates submission record.'
    action SubmitVerifiedTransaction(
                                     @title: 'Signing Request ID'
                                     @description: 'The signing request to submit'
                                     signingRequestId: UUID,
                                     @title: 'Signed Transaction CBOR'
                                     @description: 'The signed transaction CBOR'
                                     signedTxCbor: String,
                                     @title: 'Signer Type'
                                     @description: 'Type of signer used'
                                     signerType: String(20),
                                     @title: 'Signer Info'
                                     @description: 'Additional signer information'
                                     signerInfo: String(100)) returns TransactionSubmissions;
}
