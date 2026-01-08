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
    
    @title : 'Transaction Builds'
    @description : 'Projection for Transaction Builds'
    entity TransactionBuilds            as projection on db.TransactionBuilds;

    @title : 'Ledger Protocol Parameters'
    @description : 'Projection for Ledger Protocol Parameters'
    entity LedgerProtocolParameters     as projection on db.LedgerProtocolParameters;
    
    @title : 'Transaction Build Inputs'
    @description : 'Projection for Transaction Build Inputs'
    entity TransactionBuildInputs       as projection on db.TransactionBuildInputs;
    
    @title : 'Transaction Build Outputs'
    @description : 'Projection for Transaction Build Outputs'
    entity TransactionBuildOutputs      as projection on db.TransactionBuildOutputs;
    
    @title : 'Transaction Build Input Assets'
    @description : 'Projection for Transaction Build Input Assets'
    entity TransactionBuildInputAssets  as projection on db.TransactionBuildInputAssets;
    
    @title : 'Transaction Build Output Assets'
    @description : 'Projection for Transaction Build Output Assets'
    entity TransactionBuildOutputAssets as projection on db.TransactionBuildOutputAssets;
    
    @title : 'Transaction Submissions'
    @description : 'Projection for Transaction Submissions'
    entity TransactionSubmissions       as projection on db.TransactionSubmissions;
    
    @title : 'Transaction Submission Errors'
    @description : 'Projection for Transaction Submission Errors'
    entity TransactionSubmissionErrors  as projection on db.TransactionSubmissionErrors;

    @title : 'Latest Block'
    @description : 'Projection for Latest Block'
    entity LatestBlock                  as projection on db.Blocks;

    @title : 'Latest Epoch'
    @description : 'Projection for Latest Epoch'
    entity LatestEpoch                  as projection on db.Epochs;

    // ---------------------------------------------------------------------------
    // Query Actions
    // ---------------------------------------------------------------------------

    @title : 'Get Latest Block'
    @description : 'Retrieve the latest block information'
    action GetLatestBlock() returns LatestBlock;

    @title : 'Get Latest Epoch'
    @description : 'Retrieve the latest epoch information'
    action GetLatestEpoch() returns LatestEpoch;

    @title : 'Get Ledger Protocol Parameters'
    @description : 'Retrieve the current ledger protocol parameters'
    action GetProtocolParameters() returns LedgerProtocolParameters;

    // ---------------------------------------------------------------------------
    // Transaction Building Actions
    // ---------------------------------------------------------------------------
    
    @title : 'Build Simple ADA Transaction'
    @description : 'Build a simple ADA transfer transaction from sender to recipient with specified amount and change address'
    action BuildSimpleAdaTransaction(
        @title : 'Network'
        @description : 'The Cardano network to build the transaction for (e.g., mainnet, testnet)'
        network        : String(10),
        @title : 'Sender Address'
        @description : 'The Bech32 encoded address of the sender'
        senderAddress  : db.bech32,
        @title : 'Recipient Address'
        @description : 'The Bech32 encoded address of the recipient'
        recipientAddress: db.bech32,
        @title : 'Lovelace Amount'
        @description : 'The amount of ADA to send in lovelace'
        lovelaceAmount : db.Lovelace,
        @title : 'Change Address'
        @description : 'The Bech32 encoded address for returning change -defaults to sender address if not specified'
        changeAddress  : db.bech32
    ) returns TransactionBuilds;
    
    @title : 'Get Build Details'
    @description : 'Retrieve transaction build details using the Build Id'
    action GetBuildDetails(
        @title : 'Build Id'
        @description : 'The unique identifier of the transaction build'
        buildId : UUID
    ) returns TransactionBuilds;

    @title : 'Submit Transaction'
    @description : 'Submit a transaction to the Cardano network using a build ID and signed CBOR'
    action SubmitTransaction(
        @title : 'Build Id'
        @description : 'The unique identifier of the transaction build'
        buildId      : UUID,
        @title : 'Signed Transaction CBOR'
        @description : 'The CBOR of the signed transaction'
        signedTxCbor : String
    ) returns TransactionSubmissions;
    
    @title : 'Submit Signed Transaction'
    @description : 'Submit a signed transaction to the Cardano network'
    action SubmitSignedTransaction(
        @title : 'Signed Transaction CBOR'
        @description : 'The CBOR of the signed transaction'
        signedTxCbor : String,
        @title : 'Network'
        @description : 'The Cardano network to submit the transaction to (e.g., mainnet, testnet)'
        network      : String(10)
    ) returns TransactionSubmissions;

    @title : 'Check Submission Status'
    @description : 'Check the status of a submitted transaction using the Submission Id'
    action CheckSubmissionStatus(
        @title : 'Submission Id'
        @description : 'The unique identifier of the transaction submission'
        submissionId : UUID
    ) returns TransactionSubmissions;
}