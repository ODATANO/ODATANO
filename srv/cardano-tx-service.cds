using {odatano.cardano as db} from '../db/schema';

/**
 * Cardano Transaction Service
 * 
 * Handles transaction building and submission operations.
 * Separate from the read-only CardanoODataService to provide
 * clear separation between query and command operations.
 */
service CardanoTransactionService @(impl: 'srv/cardano-tx-service') {
    // ---------------------------------------------------------------------------
    // Entity Projections - Transaction Building & Submission
    // ---------------------------------------------------------------------------
    
    @readonly
    entity TransactionBuilds            as projection on db.TransactionBuilds;

    @readonly
    entity LedgerProtocolParameters     as projection on db.LedgerProtocolParameters;
    
    @readonly
    entity TransactionBuildInputs       as projection on db.TransactionBuildInputs;
    
    @readonly
    entity TransactionBuildOutputs      as projection on db.TransactionBuildOutputs;
    
    @readonly
    entity TransactionBuildInputAssets  as projection on db.TransactionBuildInputAssets;
    
    @readonly
    entity TransactionBuildOutputAssets as projection on db.TransactionBuildOutputAssets;
    
    @readonly
    entity TransactionSubmissions       as projection on db.TransactionSubmissions;
    
    @readonly
    entity TransactionSubmissionErrors  as projection on db.TransactionSubmissionErrors;

    // ---------------------------------------------------------------------------
    // Transaction Building Actions
    // ---------------------------------------------------------------------------
    
    /**
     * Build a simple ADA-only transaction
     * 
        * @param network - Target network ('mainnet', 'preprod', 'preview')
        * @param senderAddress - Source address (must have UTxOs)
        * @param recipientAddress - Recipient address
        * @param lovelaceAmount - Amount of lovelace to send
        * @param changeAddress - Optional change address (defaults to sender)
        * @returns Complete transaction build with unsigned CBOR
     */
    action BuildSimpleAdaTransaction(
        network        : String(10),
        senderAddress  : db.bech32,
        recipientAddress: db.bech32,
        lovelaceAmount : db.Lovelace,
        changeAddress  : db.bech32
    ) returns TransactionBuilds;
    
    /**
     * Get details of a transaction build
     * 
     * @param buildId - UUID of the build
     * @returns Complete build details with all relationships expanded
     */
    action GetBuildDetails(
        buildId : UUID
    ) returns TransactionBuilds;

    // ---------------------------------------------------------------------------
    // Transaction Submission Actions
    // ---------------------------------------------------------------------------
    
    /**
     * Submit a signed transaction to the Cardano network
     * 
     * @param buildId - UUID of the original build
     * @param signedTxCbor - Signed transaction CBOR hex string
     * @returns Submission record with initial status
     */
    action SubmitTransaction(
        buildId      : UUID,
        signedTxCbor : String
    ) returns TransactionSubmissions;
    
    /**
     * Submit a signed transaction without prior build
     * 
     * For transactions built externally or when build record was not created.
     * 
     * @param signedTxCbor - Signed transaction CBOR hex string
     * @param network - Target network
     * @returns Submission record
     */
    action SubmitSignedTransaction(
        signedTxCbor : String,
        network      : String(10)
    ) returns TransactionSubmissions;

    /**
     * Check the status of a transaction submission
     * 
     * Queries the blockchain to update confirmation status.
     * 
     * @param submissionId - UUID of the submission
     * @returns Updated submission record with current status
     */
    action CheckSubmissionStatus(
        submissionId : UUID
    ) returns TransactionSubmissions;

}