using {odatano.cardano as db} from '../db/schema';
using {Bech32, ResolvedOutcome} from '../db/types';

// External signing: signing requests, signature checks, submission and HSM signing.
// The service itself is 'any': CAP checks the service before the operation, so anything stricter
// would 401 the anonymous VerifyDataSignature. Each element carries its own requirement.
@requires: 'any'
service CardanoSignService @(impl: './cardano-sign-service') {

    // ---------------------------------------------------------------------------
    // Signing Workflow Projections
    // ---------------------------------------------------------------------------
    @readonly
    @title      : 'Signature Verifications'
    @description: 'Projection for Signature Verifications - stores verification results'
    @requires   : 'Sign'
    entity SignatureVerifications as projection on db.SignatureVerifications;

    @readonly
    @title      : 'Address Signing Requests'
    @description: 'Signing requests of an address, ordered by request id'
    @requires   : 'Sign'
    entity AddressSigningRequests as projection on db.AddressSigningRequests;

    @readonly
    @title      : 'Transaction Builds'
    @description: 'Projection for Transaction Builds - needed by CreateSigningRequest to look up build details'
    @requires   : 'Sign'
    entity TransactionBuilds      as projection on db.TransactionBuilds;


    @readonly
    @title      : 'Transaction Submissions'
    @description: 'Projection for Transaction Submissions - stores submission results'
    @requires   : 'Sign'
    entity TransactionSubmissions as projection on db.TransactionSubmissions;

            @readonly
            @title      : 'Signing Requests'
            @description: 'Projection for Signing Requests - tracks signing workflow'
    @requires   : 'Sign'
    entity SigningRequests as projection on db.SigningRequests;

    @title      : 'Verify Signature'
    @description: 'Verify the signature of a signed transaction. Stores the verification result for audit trail.'
    @requires   : 'Sign'
    @odatano.agent: 'grant'
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
    @requires   : 'Sign'
    @odatano.agent: 'grant'
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
                                     address: Bech32,
                                     @title: 'Defer Submit'
                                     @description: 'When true, verify + claim run on the caller''s transaction and the network submit happens detached AFTER the caller''s commit. Returns immediately with the tx hash (= tx body hash) and status ''pending''. Designed for in-process CAP consumers whose request transaction would otherwise deadlock the pooled sqlite connection. Track the outcome via the signing request / submission status.'
                                     deferSubmit: Boolean)    returns TransactionSubmissions;


    // ---------------------------------------------------------------------------
    // CIP-30 signData (COSE_Sign1) message-signature verification
    // ---------------------------------------------------------------------------

    // Public override: this action is the crypto check behind wallet-based LOGIN,
    // so the caller is not yet authenticated. It writes nothing and touches no key, so it leaks nothing.
    @requires   : 'any'
    @title      : 'Verify Data Signature (CIP-30 signData)'
    @description: 'Verify a COSE_Sign1 message signature against a bech32 address. Confirms EdDSA over an Ed25519 key, that the signed header names the given address, that the signer key hashes to its credential (payment credential, or stake credential of a reward address), the Ed25519 signature, and (optionally) that the signed payload matches an expected value.'
    @odatano.agent: 'read'
    action VerifyDataSignature(
                               @description: 'Bech32 payment or reward address the wallet signed with'
                               address        : Bech32,
                               @description: 'Hex-encoded COSE_Sign1 CBOR (the `signature` field from CIP-30 signData)'
                               coseSignature  : String(65536),
                               @description: 'Hex-encoded COSE_Key CBOR (the `key` field from CIP-30 signData)'
                               coseKey        : String(512),
                               @description: 'Optional expected UTF-8 payload; when set, the signed payload must equal it byte for byte (anti-replay). Required when the wallet signed the hash of the message. When omitted, the decoded payload is returned for the caller to check.'
                               expectedPayload: String(16384))  returns {
        @description: 'Whether the signature is valid and all checks passed'  valid                              : Boolean;
        @description: 'Failure detail when not valid'  reason                                                : String;
        @description: 'The signed message as text; empty when the payload is not UTF-8'  signedPayload        : String;
        @description: 'The payload bytes as signed, hex; the blake2b-224 of the message when the wallet hashed it'  signedPayloadHex : String;
        @description: 'Hex blake2b-224 of the signer public key'  signerVkh                                   : String;
    };

    // ---------------------------------------------------------------------------
    // General Signing Workflow Actions
    // ---------------------------------------------------------------------------

    @title      : 'Create Signing Request'
    @description: 'Create a signing request for external signing. Returns transaction details, signing instructions, and CLI commands. The request is persisted for audit trail.'
    @requires   : 'Sign'
    @odatano.agent: 'grant'
    action CreateSigningRequest(
                                @title: 'Build ID'
                                @description: 'The unique identifier of the transaction build'
                                buildId: UUID,
                                @title: 'Message to Signer'
                                @description: 'A message to include for the signer'
                                message: String)        returns SigningRequests;

    @title      : 'Get Signing Request'
    @description: 'Retrieve an existing signing request by ID'
    @requires   : 'Sign'
    @odatano.agent: 'read'
    action GetSigningRequest(
                             @title: 'Signing Request ID'
                             @description: 'The unique identifier of the signing request'
                             signingRequestId: UUID)    returns SigningRequests;

    @title      : 'Address Signing Requests'
    @description: 'Projection for retrieving signing requests by address'
    @requires   : 'Sign'
    @odatano.agent: 'read'
    action GetSigningRequestsByAddress(
                                       @title: 'Bech32 Address'
                                       @description: 'The Bech32 encoded address to retrieve signing requests for'
                                       address: Bech32,
                                       @title: 'Limit'
                                       @description: 'Maximum number of rows (default 1000, at most 5000)'
                                       @assert.range: [1, 5000]
                                       limit: Integer,
                                       @title: 'Skip'
                                       @description: 'Number of rows to skip (default 0)'
                                       @assert.range: [0, _]
                                       skip: Integer) returns array of AddressSigningRequests;

    // ---------------------------------------------------------------------------
    // HSM (Hardware Security Module) Signing Actions
    // ---------------------------------------------------------------------------

    @title      : 'Sign with HSM'
    @description: 'Sign a transaction using the configured Hardware Security Module. Creates a signing request, signs with the HSM, and verifies the signature. Returns the signing request with status verified.'
    @requires   : 'Sign'
    @odatano.agent: 'operator'
    action SignWithHsm(
                       @title: 'Build ID'
                       @description: 'The unique identifier of the transaction build to sign'
                       buildId: UUID,
                       @title: 'Sender Address'
                       @description: 'Optional sender address for ownership verification. When provided, verifies the build belongs to this address.'
                       address: Bech32)                 returns SigningRequests;

    @title      : 'Sign and Submit with HSM'
    @description: 'Sign a transaction using the HSM and submit it to the blockchain in one atomic operation. Returns the transaction submission details.'
    @requires   : 'Sign'
    @odatano.agent: 'operator'
    action SignAndSubmitWithHsm(
                                @title: 'Build ID'
                                @description: 'The unique identifier of the transaction build to sign and submit'
                                buildId: UUID,
                                @title: 'Sender Address'
                                @description: 'Optional sender address for ownership verification. When provided, verifies the build belongs to this address.'
                                address: Bech32,
                                @title: 'Defer Submit'
                                @description: 'When true, sign + verify + claim run on the caller''s transaction and the network submit happens detached AFTER the caller''s commit (see SubmitVerifiedTransaction.deferSubmit).'
                                deferSubmit: Boolean)   returns TransactionSubmissions;

    @title      : 'Resolve Signing Request'
    @description: 'Settle an unresolved signing request after reading the chain: confirmed when its transaction is on chain with passing scripts (the submission record is then written), failed when it is not and can no longer land; failed is refused with 409 while the transaction is not expired and an input of it is unspent. txHash, when given, must be the request transaction.'
    @requires   : 'Admin'
    @odatano.agent: 'operator'
    action ResolveSigningRequest(
                                 @title: 'Signing Request ID' signingRequestId: UUID not null,
                                 @title: 'Outcome' @assert.range outcome: ResolvedOutcome not null,
                                 @title: 'Transaction Hash' txHash: String(64),
                                 @title: 'Note' note: String(300)) returns SigningRequests;

    @title      : 'Get HSM Status'
    @description: 'Check the current status of the HSM connection and key availability.'
    @requires   : 'Sign'
    @odatano.agent: 'read'
    action GetHsmStatus()                               returns {
        @title: 'Connected'        @description: 'Whether the HSM session is active'  connected                                                    : Boolean;
        @title: 'Key ID'           @description: 'The PKCS#11 key identifier in use'  keyId                                                        : String;
        @title: 'Key Label'        @description: 'The PKCS#11 key label in use'  keyLabel                                                          : String;
        @title: 'Public Key Hash'  @description: 'Blake2b-224 hash of the HSM Ed25519 public key (= Cardano verification key hash)'  publicKeyHash : String;
        @title: 'Cardano Address'  @description: 'Enterprise Cardano address derived from the HSM public key'  cardanoAddress                      : String;
    };

}
