using {odatano.cardano as db} from '../db/schema';

/**
 * Cardano Transaction Service
 *
 * Handles transaction building and submission operations.
 * Separate from the read-only CardanoODataService to provide
 * clear separation between general query and command operations.
 */
service CardanoSignService @(impl: './cardano-sign-service') {
    // ---------------------------------------------------------------------------
    // M3 - External Signing Workflow Entities & Actions
    // ---------------------------------------------------------------------------

    @title      : 'Transaction Submissions'
    @description: 'Projection for Transaction Submissions - stores submission results'
    entity TransactionSubmissions       as projection on db.TransactionSubmissions;

    @title      : 'Signing Requests'
    @description: 'Projection for Signing Requests - tracks signing workflow'
    entity SigningRequests as projection on db.SigningRequests
        actions {

            @title      : 'Verify Signature'
            @description: 'Verify the signature of a signed transaction. Stores the verification result for audit trail.'
            action VerifySignature(
                                   @title: 'Signed Transaction CBOR'
                                   @description: 'The signed transaction CBOR to verify'
                                   signedTxCbor: String,
                                   @title: 'Signer Type'
                                   @description: 'Type of signer used (cardano-cli | browser-wallet | hardware-wallet | custom)'
                                   signerType: String(20),
                                   @title: 'Signer Info'
                                   @description: 'Additional signer information (wallet name, etc.)'
                                   signerInfo: String(100))           returns SignatureVerifications;

            @title      : 'Submit Verified Transaction'
            @description: 'Verify and submit a signed transaction in one step. Updates the signing request status and creates submission record.'
            action SubmitVerifiedTransaction(
                                             @title: 'Signed Transaction CBOR'
                                             @description: 'The signed transaction CBOR'
                                             signedTxCbor: String,
                                             @title: 'Signer Type'
                                             @description: 'Type of signer used'
                                             signerType: String(20),
                                             @title: 'Signer Info'
                                             @description: 'Additional signer information'
                                             signerInfo: String(100)) returns TransactionSubmissions;
        };

    // ---------------------------------------------------------------------------
    // Signing Workflow Status-Transition Flow Annotations
    // ---------------------------------------------------------------------------
    @title      : 'Signature Verifications'
    @description: 'Projection for Signature Verifications - stores verification results'
    entity SignatureVerifications       as projection on db.SignatureVerifications;

    @title      : 'Address Signing Requests'
    @description: 'Projection for retrieving signing requests by address'
    entity AddressSigningRequests       as projection on db.AddressSigningRequests;

    @title      : 'Transaction Builds'
    @description: 'Projection for Transaction Builds - needed by CreateSigningRequest to look up build details'
    entity TransactionBuilds            as projection on db.TransactionBuilds;

    /**
     * SigningRequests status flow:
     *   pending ──[VerifySignature]──→ verified | failed  (conditional in handler)
     *   pending | verified ──[SubmitVerifiedTransaction]──→ submitted
     *   pending ──[checkExpire]──→ expired  (custom time-based logic in handler)
     */
    annotate CardanoSignService.SigningRequests with @flow.status: status actions {
        VerifySignature                                     @from       : [ #pending];
        SubmitVerifiedTransaction                           @from       : [
            #pending,
            #verified
        ]  @to: #submitted;
    };

    // ---------------------------------------------------------------------------
    // Signing Workflow Actions
    // ---------------------------------------------------------------------------

    @title      : 'Create Signing Request'
    @description: 'Create a signing request for external signing. Returns transaction details, signing instructions, and CLI commands. The request is persisted for audit trail.'
    action CreateSigningRequest(
                                @title: 'Build ID'
                                @description: 'The unique identifier of the transaction build'
                                buildId: UUID,
                                @title: 'Message to Signer'
                                @description: 'A message to include for the signer'
                                message: String)               returns SigningRequests;

    @title      : 'Get Signing Request'
    @description: 'Retrieve an existing signing request by ID'
    action GetSigningRequest(
                             @title: 'Signing Request ID'
                             @description: 'The unique identifier of the signing request'
                             signingRequestId: UUID)           returns SigningRequests;

    @title      : 'Address Signing Requests'
    @description: 'Projection for retrieving signing requests by address'
    action GetSigningRequestsByAddress(
                                       @title: 'Bech32 Address'
                                       @description: 'The Bech32 encoded address to retrieve signing requests for'
                                       address: db.Bech32)     returns array of AddressSigningRequests;


}
