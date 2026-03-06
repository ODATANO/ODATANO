using {odatano.cardano as db} from '../db/schema';
using {Bech32} from '../db/types';

/**
 * Cardano Sign Service
 *
 * Handles the external signing workflow for Cardano transactions, including:
 * - Creating signing requests with transaction details and signing instructions
 * - Verifying signatures of signed transactions and storing verification results
 * - Submitting verified transactions to the blockchain and tracking submission status
 * - Providing actions for signing with a Hardware Security Module (HSM) and retrieving HSM status
 */
@requires: 'authenticated-user'
service CardanoSignService @(impl: './cardano-sign-service') {

    // ---------------------------------------------------------------------------
    // Signing Workflow Projections
    // ---------------------------------------------------------------------------
    @title      : 'Signature Verifications'
    @description: 'Projection for Signature Verifications - stores verification results'
    entity SignatureVerifications as projection on db.SignatureVerifications;

    @title      : 'Address Signing Requests'
    @description: 'Projection for retrieving signing requests by address'
    entity AddressSigningRequests as projection on db.AddressSigningRequests;

    @title      : 'Transaction Builds'
    @description: 'Projection for Transaction Builds - needed by CreateSigningRequest to look up build details'
    entity TransactionBuilds      as projection on db.TransactionBuilds;


    @title      : 'Transaction Submissions'
    @description: 'Projection for Transaction Submissions - stores submission results'
    entity TransactionSubmissions as projection on db.TransactionSubmissions;

            @title      : 'Signing Requests'
            @description: 'Projection for Signing Requests - tracks signing workflow'
    entity SigningRequests as projection on db.SigningRequests;

    @title      : 'Verify Signature'
    @description: 'Verify the signature of a signed transaction. Stores the verification result for audit trail.'
    action VerifySignature(
                           @title: 'Signing Request ID'
                           @description: 'The unique identifier of the signing request'
                           signingRequestId: UUID,
                           @title: 'Signed Transaction CBOR'
                           @description: 'The signed transaction CBOR to verify'
                           signedTxCbor: String,
                           @title: 'Signer Type'
                           @description: 'Type of signer used (cardano-cli | browser-wallet | hardware-wallet | custom)'
                           signerType: String(20),
                           @title: 'Signer Info'
                           @description: 'Additional signer information (wallet name, etc.)'
                           signerInfo: String(100),
                           @title: 'Sender Address'
                           @description: 'Optional sender address for ownership verification. When provided, verifies the signing request belongs to this address.'
                           address: Bech32)                   returns SignatureVerifications;

    @title      : 'Submit Verified Transaction'
    @description: 'Verify and submit a signed transaction in one step. Updates the signing request status and creates submission record.'
    action SubmitVerifiedTransaction(
                                     @title: 'Signing Request ID'
                                     @description: 'The unique identifier of the signing request'
                                     signingRequestId: UUID,
                                     @title: 'Signed Transaction CBOR'
                                     @description: 'The signed transaction CBOR'
                                     signedTxCbor: String,
                                     @title: 'Signer Type'
                                     @description: 'Type of signer used'
                                     signerType: String(20),
                                     @title: 'Signer Info'
                                     @description: 'Additional signer information'
                                     signerInfo: String(100),
                                     @title: 'Sender Address'
                                     @description: 'Optional sender address for ownership verification. When provided, verifies the signing request belongs to this address.'
                                     address: Bech32)         returns TransactionSubmissions;


    // ---------------------------------------------------------------------------
    // General Signing Workflow Actions
    // ---------------------------------------------------------------------------

    @title      : 'Create Signing Request'
    @description: 'Create a signing request for external signing. Returns transaction details, signing instructions, and CLI commands. The request is persisted for audit trail.'
    action CreateSigningRequest(
                                @title: 'Build ID'
                                @description: 'The unique identifier of the transaction build'
                                buildId: UUID,
                                @title: 'Message to Signer'
                                @description: 'A message to include for the signer'
                                message: String)        returns SigningRequests;

    @title      : 'Get Signing Request'
    @description: 'Retrieve an existing signing request by ID'
    action GetSigningRequest(
                             @title: 'Signing Request ID'
                             @description: 'The unique identifier of the signing request'
                             signingRequestId: UUID)    returns SigningRequests;

    @title      : 'Address Signing Requests'
    @description: 'Projection for retrieving signing requests by address'
    action GetSigningRequestsByAddress(
                                       @title: 'Bech32 Address'
                                       @description: 'The Bech32 encoded address to retrieve signing requests for'
                                       address: Bech32) returns array of AddressSigningRequests;

    // ---------------------------------------------------------------------------
    // HSM (Hardware Security Module) Signing Actions
    // ---------------------------------------------------------------------------

    @title      : 'Sign with HSM'
    @description: 'Sign a transaction using the configured Hardware Security Module. Creates a signing request, signs with the HSM, and verifies the signature. Returns the signing request with status verified.'
    action SignWithHsm(
                       @title: 'Build ID'
                       @description: 'The unique identifier of the transaction build to sign'
                       buildId: UUID,
                       @title: 'Sender Address'
                       @description: 'Optional sender address for ownership verification. When provided, verifies the build belongs to this address.'
                       address: Bech32)                 returns SigningRequests;

    @title      : 'Sign and Submit with HSM'
    @description: 'Sign a transaction using the HSM and submit it to the blockchain in one atomic operation. Returns the transaction submission details.'
    action SignAndSubmitWithHsm(
                                @title: 'Build ID'
                                @description: 'The unique identifier of the transaction build to sign and submit'
                                buildId: UUID,
                                @title: 'Sender Address'
                                @description: 'Optional sender address for ownership verification. When provided, verifies the build belongs to this address.'
                                address: Bech32)        returns TransactionSubmissions;

    @title      : 'Get HSM Status'
    @description: 'Check the current status of the HSM connection and key availability.'
    action GetHsmStatus()                               returns {
        @title: 'Connected'        @description: 'Whether the HSM session is active'  connected                                                    : Boolean;
        @title: 'Key ID'           @description: 'The PKCS#11 key identifier in use'  keyId                                                        : String;
        @title: 'Key Label'        @description: 'The PKCS#11 key label in use'  keyLabel                                                          : String;
        @title: 'Public Key Hash'  @description: 'Blake2b-224 hash of the HSM Ed25519 public key (= Cardano verification key hash)'  publicKeyHash : String;
        @title: 'Cardano Address'  @description: 'Enterprise Cardano address derived from the HSM public key'  cardanoAddress                      : String;
    };

}
