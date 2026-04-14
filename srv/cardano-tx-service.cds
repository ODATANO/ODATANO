using {odatano.cardano as db} from '../db/schema';
using {Bech32, Lovelace} from '../db/types';


/**
 * Cardano Transaction Service
 *
 * Handles transaction building and submission operations.
 * Separate from the read-only CardanoODataService to provide
 * clear separation between general query and command operations.
 *
 * Security note: see CardanoODataService (cardano-service.cds) for the rationale
 * on service-level auth without per-resource ownership enforcement.
 */
@requires: 'authenticated-user'
service CardanoTransactionService @(impl: './cardano-tx-service') {
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
    entity TransactionSubmissions       as projection on db.TransactionSubmissions
        actions {
            @title      : 'Check Submission Status'
            @description: 'Check the status of a submitted transaction by querying the blockchain for confirmation'
            action CheckSubmissionStatus() returns TransactionSubmissions;
        };
    /**
     * TransactionSubmissions status flow:
     *   pending ──[submit to chain]──→ submitted  (internal, in SubmitTransaction handler)
     *   submitted ──[CheckSubmissionStatus]──→ confirmed | stays submitted  (conditional)
     *   pending | submitted ──→ failed  (blockchain error)
     */
    annotate CardanoTransactionService.TransactionSubmissions with @flow.status: status actions {
        CheckSubmissionStatus                                      @from       : [ #submitted];
    };

    @title      : 'Transaction Submission Errors'
    @description: 'Projection for Transaction Submission Errors'
    entity TransactionSubmissionErrors  as projection on db.TransactionSubmissionErrors;

    @title      : 'Address Transaction Builds'
    @description: 'Projection for retrieving transaction builds by address'
    entity AddressTransactionBuilds     as projection on db.AddressTransactionBuilds;

    // ---------------------------------------------------------------------------
    // Transaction Building Actions
    // ---------------------------------------------------------------------------

    @title      : 'Build Simple ADA Transaction'
    @description: 'Build a simple ADA transfer transaction from sender to recipient with specified amount and change address'
    action BuildSimpleAdaTransaction(
                                     @title: 'Sender Address'
                                     @description: 'The Bech32 encoded address of the sender'
                                     senderAddress: Bech32,
                                     @title: 'Recipient Address'
                                     @description: 'The Bech32 encoded address of the recipient'
                                     recipientAddress: Bech32,
                                     @title: 'Lovelace Amount'
                                     @description: 'The amount of ADA to send in lovelace'
                                     lovelaceAmount: Lovelace,
                                     @title: 'Change Address'
                                     @description: 'The Bech32 encoded address for returning change - defaults to sender address if not specified'
                                     changeAddress: Bech32,
                                     @title: 'Output Datum JSON'
                                     @description: 'Optional inline datum to attach to the recipient output (JSON, cardano-cli DetailedSchema format). Required when sending to a script address.'
                                     outputDatumJson: String,
                                     @title: 'Assets JSON'
                                     @description: 'Optional JSON array of native assets to include in the output ([{"unit":"policyId+assetName","quantity":"amount"}]). Use when locking tokens at a script address.'
                                     assetsJson: String,
                                     @title: 'Force Inputs JSON'
                                     @description: 'Optional JSON array of {txHash, outputIndex} UTxOs that MUST be consumed as inputs. Added before coin selection. Use for one-shot minting seeds, token-carrying UTxOs, or deterministic input control.'
                                     forceInputsJson: String)  returns TransactionBuilds;

    @title      : 'Build Transaction with Metadata'
    @description: 'Build a transaction with custom metadata from sender to recipient with specified amount and change address'
    action BuildTransactionWithMetadata(
                                        @title: 'Sender Address'
                                        @description: 'The Bech32 encoded address of the sender'
                                        senderAddress: Bech32,
                                        @title: 'Recipient Address'
                                        @description: 'The Bech32 encoded address of the recipient'
                                        recipientAddress: Bech32,
                                        @title: 'Lovelace Amount'
                                        @description: 'The amount of ADA to send in lovelace'
                                        lovelaceAmount: Lovelace,
                                        @title: 'Change Address'
                                        @description: 'The Bech32 encoded address for returning change -defaults to sender address if not specified'
                                        changeAddress: Bech32,
                                        @title: 'Metadata JSON'
                                        @description: 'The JSON representation of the transaction metadata as string'
                                        metadataJson: String)  returns TransactionBuilds;

    @title      : 'Build Multi-Asset Transaction'
    @description: 'Build a transaction to send native assets (tokens) along with ADA'
    action BuildMultiAssetTransaction(
                                      @title: 'Sender Address'
                                      @description: 'The Bech32 encoded address of the sender'
                                      senderAddress: Bech32,
                                      @title: 'Recipient Address'
                                      @description: 'The Bech32 encoded address of the recipient'
                                      recipientAddress: Bech32,
                                      @title: 'Lovelace Amount'
                                      @description: 'The amount of ADA to send in lovelace'
                                      lovelaceAmount: Lovelace,
                                      @title: 'Assets JSON'
                                      @description: 'JSON array of assets to send (format: [{"unit":"policyId+assetName","quantity":"amount"}])'
                                      assetsJson: String,
                                      @title: 'Change Address'
                                      @description: 'The Bech32 encoded address for returning change -defaults to sender address if not specified'
                                      changeAddress: Bech32,
                                      @title: 'Output Datum JSON'
                                      @description: 'Optional inline datum to attach to the recipient output (JSON, DetailedSchema). Required when sending to a script address.'
                                      outputDatumJson: String) returns TransactionBuilds;

    @title      : 'Build Minting Transaction'
    @description: 'Build a transaction to mint or burn native assets'
    action BuildMintTransaction(
                                @title: 'Sender Address'
                                @description: 'The Bech32 encoded address of the sender (pays fees)'
                                senderAddress: Bech32,
                                @title: 'Recipient Address'
                                @description: 'The Bech32 encoded address to receive minted assets'
                                recipientAddress: Bech32,
                                @title: 'Lovelace Amount'
                                @description: 'The amount of ADA to send with minted assets in lovelace'
                                lovelaceAmount: Lovelace,
                                @title: 'Mint Actions JSON'
                                @description: 'JSON array of mint/burn actions (format: [{"assetUnit":"policyId+assetName","quantity":"amount"}])'
                                mintActionsJson: String,
                                @title: 'Minting Policy Script'
                                @description: 'The minting policy script in CBOR hex format'
                                mintingPolicyScript: String,
                                @title: 'Change Address'
                                @description: 'The Bech32 encoded address for returning change -defaults to sender address if not specified'
                                changeAddress: Bech32,
                                @title: 'Required Signers JSON'
                                @description: 'Optional JSON array of Ed25519 key hashes (hex, 28 bytes each) that must sign the transaction. Required for Plutus validators checking extra_signatories.'
                                requiredSignersJson: String,
                                @title: 'Script Parameters JSON'
                                @description: 'Optional JSON array of PlutusData parameters to apply to the minting policy script before building. For parameterized validators.'
                                scriptParamsJson: String,
                                @title: 'Output Inline Datum JSON'
                                @description: 'Optional PlutusData JSON to attach as inline datum on the recipient output. Used when minted tokens must carry on-chain state.'
                                inlineDatumJson: String,
                                @title: 'Mint Redeemer JSON'
                                @description: 'Optional PlutusData JSON for the minting policy redeemer. Defaults to integer 0 if not specified.'
                                mintRedeemerJson: String,
                                @title: 'Lock on Script Address'
                                @description: 'When true and scriptParamsJson is provided, routes the output to the enterprise script address derived from the applied script hash instead of recipientAddress. Returns scriptAddress in the response.'
                                lockOnScript: Boolean,
                                @title: 'Force Inputs JSON'
                                @description: 'Optional JSON array of {txHash, outputIndex} UTxOs that MUST be consumed as inputs. Added before coin selection. Use for one-shot minting seeds, token-carrying UTxOs, or deterministic input control.'
                                forceInputsJson: String)       returns TransactionBuilds;

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

    @title      : 'Build Plutus Spend Transaction'
    @description: 'Build a transaction to spend a UTxO locked at a Plutus script address'
    action BuildPlutusSpendTransaction(
                                       @title: 'Sender Address'
                                       @description: 'The Bech32 encoded address of the sender (pays fees)'
                                       senderAddress: Bech32,
                                       @title: 'Recipient Address'
                                       @description: 'The Bech32 encoded address to receive the unlocked funds'
                                       recipientAddress: Bech32,
                                       @title: 'Lovelace Amount'
                                       @description: 'The amount of ADA to send to the recipient in lovelace'
                                       lovelaceAmount: Lovelace,
                                       @title: 'Validator Script'
                                       @description: 'The Plutus validator script in CBOR hex format'
                                       validatorScript: String,
                                       @title: 'Script UTxO Transaction Hash'
                                       @description: 'The transaction hash of the UTxO locked at the script address (64-char hex)'
                                       scriptTxHash: String,
                                       @title: 'Script UTxO Output Index'
                                       @description: 'The output index of the UTxO locked at the script address'
                                       scriptOutputIndex: Integer,
                                       @title: 'Redeemer JSON'
                                       @description: 'The redeemer data as JSON string (will be converted to PlutusData)'
                                       redeemerJson: String,
                                       @title: 'Datum JSON'
                                       @description: 'The datum data as JSON string (optional, for hash-based datums)'
                                       datumJson: String,
                                       @title: 'Change Address'
                                       @description: 'The Bech32 encoded address for returning change - defaults to sender address if not specified'
                                       changeAddress: Bech32,
                                       @title: 'Required Signers JSON'
                                       @description: 'Optional JSON array of Ed25519 key hashes (hex, 28 bytes each) that must sign the transaction. Required for Plutus validators checking extra_signatories.'
                                       requiredSignersJson: String,
                                       @title: 'Script Parameters JSON'
                                       @description: 'Optional JSON array of PlutusData parameters to apply to the validator script before building. For parameterized validators.'
                                       scriptParamsJson: String,
                                       @title: 'Output Inline Datum JSON'
                                       @description: 'Optional PlutusData JSON to attach as inline datum on the recipient output. Used for state-machine validators that require continuing output datum.'
                                       inlineDatumJson: String,
                                       @title: 'Lock on Script Address'
                                       @description: 'When true and scriptParamsJson is provided, routes the output to the enterprise script address derived from the applied script hash instead of recipientAddress. Returns scriptAddress in the response.'
                                       lockOnScript: Boolean,
                                       @title: 'Force Inputs JSON'
                                       @description: 'Optional JSON array of {txHash, outputIndex} UTxOs that MUST be consumed as inputs. Added before coin selection. Use for one-shot minting seeds, token-carrying UTxOs, or deterministic input control.'
                                       forceInputsJson: String,
                                       @title: 'Extra Outputs JSON'
                                       @description: 'Optional JSON array of additional outputs appended after the primary recipient output, before change. Each entry: {address, lovelaceAmount, assets?: [{unit, quantity}], inlineDatumJson?}. Use for multi-output state-machine transitions (counter updates + batch NFT outputs). Each extra output is independently min-ADA checked.'
                                       extraOutputsJson: String,
                                       @title: 'Mint Actions JSON'
                                       @description: 'Optional JSON array of mint/burn actions ([{"assetUnit", "quantity"}]). When provided, triggers a combined spend+mint transaction in a single atomic step. Required together with mintingPolicyScript.'
                                       mintActionsJson: String,
                                       @title: 'Minting Policy Script'
                                       @description: 'Optional Plutus minting policy CBOR hex. Required when mintActionsJson is provided. If byte-equal to validatorScript, scriptParamsJson is applied to it as well (multi-purpose script).'
                                       mintingPolicyScript: String,
                                       @title: 'Mint Redeemer JSON'
                                       @description: 'Optional PlutusData JSON for the minting policy redeemer. Defaults to integer 0 if not specified. Supports __INPUT_IDX:txHash#n__ placeholders (Buildooor only).'
                                       mintRedeemerJson: String) returns TransactionBuilds;

    @title      : 'Set Collateral'
    @description: 'Ensure a dedicated ADA-only collateral UTxO exists for Plutus transactions. Checks if the address has at least 2 UTxOs with >= 5 ADA each. If not, builds a self-send transaction to create a 5 ADA collateral UTxO.'
    action SetCollateral(
                         @title: 'Address'
                         @description: 'The Bech32 encoded address to check and set up collateral for'
                         address: Bech32)                   returns TransactionBuilds;
    @title      : 'Address Transaction Builds'
    @description: 'Projection for retrieving transaction builds by address'
    action GetTransactionBuildsByAddress(
                                         @title: 'Bech32 Address'
                                         @description: 'The Bech32 encoded address to retrieve transaction builds for'
                                         address: Bech32)   returns array of AddressTransactionBuilds;

}


