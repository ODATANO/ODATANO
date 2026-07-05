import cds, { Request } from '@sap/cds';
import { handleRequest} from './utils/backend-request-handler';
import { rejectInvalid, throwIfValidationErrors,rejectMissing, TransactionAlreadySubmittedError } from './utils/errors';
import { mapError } from './utils/mappers';
import { validateTransactionInputs, isValidBech32Address, extractPaymentCredential } from './utils/validators';
import { parseTransaction } from './cbor';
import { getCardanoIndexer, getCardanoClient, getHsmConfig } from './server';
import { getExternalSignerModule } from './blockchain/signing/external-signer';
import { getHsmSigner } from './blockchain/signing/hsm-signer';
import { verifyDataSignature } from './blockchain/signing/cose-verifier';
import { combineTransactionWithWitnesses, isWitnessSetCbor } from './utils/signing-helper';
import { extractTxCacheTargets } from './utils/tx-build-helper';
const { SELECT, UPDATE } = cds.ql;

const logger = cds.log('CardanoSignService');

interface TransactionBuildRecord {
  id: string;
  senderAddress: string;
  unsignedTxCbor: string;
  txBodyHash: string;
  network: string;
}

/**
 * Verify that a build exists and, when an address is provided, that it matches
 * the build's senderAddress. Always fetches the build from DB.
 */
async function verifyBuildOwnership(
  req: Request, db: cds.Transaction, buildId: string, address: string | undefined, TransactionBuilds: unknown, actionName: string
): Promise<TransactionBuildRecord> {
  const build = await db.run(SELECT.one.from(TransactionBuilds as never).where({ id: buildId })) as TransactionBuildRecord | undefined;
  if (!build) rejectInvalid(req, actionName, 'Build not found', 'buildId');
  // rejectInvalid returns `never` → build is narrowed to non-null here
  if (address && build.senderAddress !== address) {
    rejectInvalid(req, actionName, 'Address does not match build owner', 'address');
  }
  return build;
}

/**
 * Check if a signing request has expired and update its status.
 * @returns true if expired, false otherwise
 */
async function checkAndExpireSigningRequest(
  db: cds.Transaction, signingRequest: { id: string; status: string }, SigningRequests: unknown
): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await db.run(
    UPDATE.entity(SigningRequests as never)
      .set({ status: 'expired' })
      // status filter: only PENDING requests may expire — without it an old
      // 'submitted'/'verified' record would be flipped to 'expired' here
      .where({ id: signingRequest.id, status: 'pending', expiresAt: { '<=': now } })
  ) as number;
  if (result > 0) {
    signingRequest.status = 'expired';
    return true;
  }
  // NOTE: when the surrounding request is subsequently rejected, CAP rolls the
  // managed transaction back — including this update. The expiry status is
  // then re-applied on the next touch; reads always re-check expiresAt.
  return false;
}

/**
 * Resolve the key hashes that MUST witness a signing request:
 * - the `required_signers` declared in the unsigned tx body (extra_signatories)
 * - the payment KEY hash of the associated build's senderAddress (the fee
 *   payer's inputs require its witness on-chain anyway; script credentials
 *   are skipped — scripts witness via redeemers, not vkeys)
 *
 * Previously NONE of this was checked: any valid signature from ANY key
 * flipped the request to 'verified' / let SubmitVerifiedTransaction proceed.
 * Returns undefined when nothing is derivable (no over-restriction).
 */
async function resolveRequiredSigners(
  db: cds.Transaction,
  signingRequest: { unsignedTxCbor: string; build_id?: string | null },
  TransactionBuilds: unknown
): Promise<string[] | undefined> {
  const signers = new Set<string>();

  try {
    const parsed = parseTransaction(signingRequest.unsignedTxCbor);
    for (const s of parsed.requiredSigners ?? []) signers.add(s.toLowerCase());
  } catch (err: unknown) {
    // body-hash verification still protects integrity; just log
    logger.warn(`Could not parse unsigned tx for required_signers: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (signingRequest.build_id) {
    const build = await db.run(
      SELECT.one.from(TransactionBuilds as never).where({ id: signingRequest.build_id })
    ) as { senderAddress?: string } | undefined;
    if (build?.senderAddress) {
      const cred = extractPaymentCredential(build.senderAddress);
      if (cred && !cred.isScript) signers.add(cred.hash.toLowerCase());
    }
  }

  return signers.size > 0 ? [...signers] : undefined;
}

/** Shape persisted by indexVerifiedTransactionSubmission. */
interface FinalizeParams {
  signingRequestId: string;
  buildId: string;
  fullSignedTxCbor: string;
  txHash: string;
  verificationResult: {
    txBodyHash: string;
    witnessCount: number;
    signerKeyHashes: string[];
    warnings: string[];
  };
  signerType?: string;
  signerInfo?: string;
}

/**
 * Submit a verified+claimed signing request to the blockchain and persist the
 * outcome — DELIBERATELY outside the caller's request transaction.
 *
 * The caller must already have durably committed `status:'submitting'` (the
 * claim). This function then:
 *   1. submits with NO DB write-lock held (the lock was the reason concurrent
 *      submits serialized and the SQLite busy-timeout could fire mid-network),
 *   2. on submit failure: marks the request 'failed' in its own committed tx
 *      and rethrows (NOT rolled back to a pre-submit status — losing the
 *      attempt would hide a tx the node may have accepted),
 *   3. on success: persists the submission + 'submitted' status in a committed
 *      transaction.
 *
 * Crash window: a process death between (1) and (3) leaves the request durably
 * at 'submitting' — the operator/poller checks the chain — instead of silently
 * reverting to 'pending'/'verified' with no on-chain trace.
 */
async function submitAndFinalize(
  SigningRequests: unknown,
  params: FinalizeParams,
  afterFinalize?: (db: cds.Transaction) => Promise<void>
): Promise<unknown> {
  // Persist the submission + 'submitted' status in its own committed transaction.
  const finalizeSubmitted = () => cds.tx(async (db: cds.Transaction) => {
    const submission = await getCardanoIndexer().indexVerifiedTransactionSubmission(db as never, params);
    if (afterFinalize) await afterFinalize(db);
    // Invalidate stale UTxO cache (spent inputs + output addresses) — best-effort,
    // must never roll back the durable submission record.
    try {
      await getCardanoIndexer().invalidateUtxoCacheForTx(db as never, extractTxCacheTargets(params.fullSignedTxCbor));
    } catch (invalidateErr: unknown) {
      logger.warn(`UTxO cache invalidation failed (submit unaffected): ${invalidateErr instanceof Error ? invalidateErr.message : String(invalidateErr)}`);
    }
    return submission;
  });

  try {
    await getCardanoClient().submitTransaction(params.fullSignedTxCbor);
  } catch (submitErr: unknown) {
    // Already-submitted means the tx reached the mempool — e.g. the first backend accepted
    // it but its response was lost and a fallback observed the duplicate. That is SUCCESS,
    // not failure: finalize it as 'submitted' (same as the happy path) instead of durably
    // recording a spurious 'failed' for a tx the node already holds.
    if (submitErr instanceof TransactionAlreadySubmittedError) {
      logger.info({ signingRequestId: params.signingRequestId, txHash: params.txHash },
        'Submit reported already-submitted — finalizing as submitted (tx already in mempool)');
      return finalizeSubmitted();
    }
    try {
      await cds.tx((db: cds.Transaction) => db.run(
        UPDATE.entity(SigningRequests as never).set({ status: 'failed' }).where({ id: params.signingRequestId })
      ));
    } catch (markErr: unknown) {
      logger.error({ err: markErr, signingRequestId: params.signingRequestId },
        'Could not durably mark signing request failed after submit error');
    }
    throw submitErr;
  }

  return finalizeSubmitted();
}

/**
 * Enforce HSM role check if hsm.requiresRole is configured.
 * Rejects with 403 if the user lacks the required role.
 */
function enforceHsmRole(req: Request, actionName: string): void {
  const hsmConfig = getHsmConfig();
  if (hsmConfig?.requiresRole && !req.user?.is(hsmConfig.requiresRole)) {
    req.reject(403, `Action '${actionName}' requires role '${hsmConfig.requiresRole}'`);
  }
}

/**
 * Cardano Sign Service Implementation
 * Handles transaction signing operations & some additional data queries.
 */
module.exports = (srv: cds.Service) => {
  logger.info('Module loaded - registering handlers');

  const {
    SigningRequests,
      AddressSigningRequests,
      TransactionBuilds,
  } = require('#cds-models/CardanoSignService');

  /**
   * before-READ handler for SigningRequests: bulk expiration check
   * Atomically expires all pending requests past their TTL (handles both single and collection reads)
   * Throttled to run at most once per 60 seconds to avoid write amplification on every READ.
   */
  let lastExpiryCheck = 0;
  const EXPIRY_CHECK_INTERVAL_MS = 60_000;

  srv.before('READ', SigningRequests, async (req: Request) => {
    const now = Date.now();
    if (now - lastExpiryCheck < EXPIRY_CHECK_INTERVAL_MS) return;
    lastExpiryCheck = now;

    await cds.tx(req).run(
      UPDATE.entity(SigningRequests)
        .set({ status: 'expired' })
        .where({ status: 'pending', expiresAt: { '<=': new Date().toISOString() } })
    );
  });


  /**
   * Create a new signing request for external signing
   * Persists the request for audit trail and workflow tracking
   * @param req - CDS request object (with buildId)
   * @returns {SigningRequest} Signing request entity
   */
  srv.on('CreateSigningRequest', async (req: Request) => {
    logger.debug('CreateSigningRequest Action handler called');
    const { buildId , message } = req.data;

    // Validate inputs
    const errors = validateTransactionInputs({ buildId }, ['buildId']);
    throwIfValidationErrors(req, 'CreateSigningRequest', errors);

    return handleRequest(req, async (db) => {
      // Fetch the build
      const build = await db.run(SELECT.one.from(TransactionBuilds).where({ id: buildId }));
      if (!build) rejectInvalid(req, 'CreateSigningRequest', 'Build not found', 'buildId');

      // Check if signing request already exists for this build
      const existingRequest = await db.run(
        SELECT.one.from(SigningRequests).where({ build_id: buildId, status: 'pending' })
      );
      if (existingRequest) {
        logger.info({ buildId, signingRequestId: existingRequest.id }, 'Returning existing signing request');
        return existingRequest;
      }

      // Create signing request using external signer module
      const signerModule = getExternalSignerModule();
      const signingPayload = signerModule.createSigningRequest(
        build.id,
        build.unsignedTxCbor,
        build.txBodyHash,
        build.network, 
        message
      );

      // Delegate persistence to indexer
      const signingRequestRecord = await getCardanoIndexer().persistSigningRequest(db, {
        buildId,
        signingPayload,
      });

      logger.info({ buildId, signingRequestId: signingRequestRecord.id }, 'Created signing request');

      return signingRequestRecord;
    });
  });

  /**
   * Get an existing signing request by ID
   * @param req - CDS request object (with signingRequestId)
   * @returns {SigningRequest} signing request entity
   */
  srv.on('GetSigningRequest', async (req: Request) => {
    logger.debug('GetSigningRequest Action handler called');
    const { signingRequestId } = req.data;

    // Validate inputs
    const errors = validateTransactionInputs({ signingRequestId }, ['signingRequestId']);
    throwIfValidationErrors(req, 'GetSigningRequest', errors);

    // Fetch the signing request within transaction context
    return handleRequest(req, async (db) => {
      const signingRequest = await db.run(SELECT.one.from(SigningRequests).where({ id: signingRequestId }));
      if (!signingRequest) rejectInvalid(req, 'GetSigningRequest', 'Signing request not found', 'signingRequestId');

      // Check if expired and update status if needed
      if (signingRequest.status === 'pending') {
        await checkAndExpireSigningRequest(db, signingRequest, SigningRequests);
      }

      return signingRequest;
    });
  });

  /**
   * Verify signature of a signed transaction (unbound action)
   * @param req - CDS request with signingRequestId + signedTxCbor in data
   * @returns {SignatureVerification} Persisted signature verification entity
   */
  srv.on('VerifySignature', async (req: Request) => {
    logger.debug('VerifySignature Action handler called');
    const { signingRequestId, signedTxCbor, signerType, signerInfo, address } = req.data;

    const errors = validateTransactionInputs(
      { signingRequestId, signedTxCbor },
      ['signingRequestId', 'signedTxCbor']
    );
    throwIfValidationErrors(req, 'VerifySignature', errors);
    if (address && !isValidBech32Address(address)) rejectInvalid(req, 'VerifySignature', 'Invalid bech32 address format', 'address');

    return handleRequest(req, async (db) => {
      // Fetch the signing request (@from already validated by framework)
      const signingRequest = await db.run(SELECT.one.from(SigningRequests).where({ id: signingRequestId }));
      if (!signingRequest) rejectInvalid(req, 'VerifySignature', 'Signing request not found', 'signingRequestId');

      // Ownership check: verify address matches build owner (defense-in-depth)
      if (address && signingRequest.build_id) {
        await verifyBuildOwnership(req, db, signingRequest.build_id, address, TransactionBuilds, 'VerifySignature');
      }

      // Atomically CLAIM the pending request (pending → 'signed' = verification
      // in progress). Replaces the read-then-check pattern that let two
      // concurrent verifies both pass `status === 'pending'` and double-insert
      // verification records (last-writer-wins on status). The final status is
      // overwritten to 'verified'/'failed' by persistSignatureVerification.
      const now = new Date().toISOString();
      const claimed = await db.run(
        UPDATE.entity(SigningRequests)
          .set({ status: 'signed' })
          .where({ id: signingRequestId, status: 'pending', expiresAt: { '>': now } })
      );
      if (claimed === 0) {
        // re-read the committed state for an accurate message (a concurrent
        // verify may have moved it since our SELECT above)
        const current = await db.run(SELECT.one.from(SigningRequests).where({ id: signingRequestId }));
        if (current && current.status === 'pending' && current.expiresAt <= now) {
          await db.run(UPDATE.entity(SigningRequests).set({ status: 'expired' }).where({ id: signingRequestId, status: 'pending' }));
          rejectInvalid(req, 'VerifySignature', 'Signing request has expired', 'signingRequestId');
        }
        rejectInvalid(req, 'VerifySignature', `Signing request status is '${current?.status ?? 'unknown'}', expected 'pending'`, 'signingRequestId');
      }

      // Detect if signedTxCbor is a witness set (CIP-30) or a full signed transaction (cardano-cli)
      let fullSignedTxCbor: string;
      if (isWitnessSetCbor(signedTxCbor)) {
        // CIP-30 wallet returns only witness set — combine with unsigned tx
        fullSignedTxCbor = combineTransactionWithWitnesses(signingRequest.unsignedTxCbor, signedTxCbor);
        logger.debug({ signingRequestId }, 'Combined witness set with unsigned transaction for verification');
      } else {
        // Full signed transaction provided (e.g., from cardano-cli)
        fullSignedTxCbor = signedTxCbor;
      }

      // Verify the signature — bound to the keys that must actually witness
      // this transaction (declared required_signers + the build's fee payer)
      const requiredSigners = await resolveRequiredSigners(db, signingRequest, TransactionBuilds);
      const signerModule = getExternalSignerModule();
      const result = signerModule.verifySignedTransaction(fullSignedTxCbor, signingRequest.txBodyHash, { requiredSigners });

      // Delegate persistence to indexer (store full signed tx for later submission)
      const verificationRecord = await getCardanoIndexer().persistSignatureVerification(db, {
        signingRequestId,
        signedTxCbor: fullSignedTxCbor,
        verificationResult: result,
        signerType,
        signerInfo,
      });

      logger.info({
        signingRequestId,
        verificationId: verificationRecord.id,
        isValid: result.isValid,
        witnessCount: result.witnessCount,
      }, 'Signature verification completed');

      return verificationRecord;
    });
  });

  /**
   * Verify and submit a signed transaction in one step (unbound action)
   * @param req - CDS request with signingRequestId + signedTxCbor in data
   * @returns {TransactionSubmission} Transaction submission details
   */
  srv.on('SubmitVerifiedTransaction', async (req: Request) => {
    logger.debug('SubmitVerifiedTransaction Action handler called');
    const { signingRequestId, signedTxCbor, signerType, signerInfo, address } = req.data;

    const errors = validateTransactionInputs(
      { signingRequestId, signedTxCbor },
      ['signingRequestId', 'signedTxCbor']
    );
    throwIfValidationErrors(req, 'SubmitVerifiedTransaction', errors);
    if (address && !isValidBech32Address(address)) rejectInvalid(req, 'SubmitVerifiedTransaction', 'Invalid bech32 address format', 'address');

    // Three committed phases instead of one request-long transaction (see
    // submitAndFinalize): the network submit must NOT run inside an open DB
    // transaction. Errors are mapped the same way handleRequest would.
    try {
      // PHASE 1 (committed): atomically claim → 'submitting' and fully verify.
      // A reject/verification failure here rolls the claim back, so a bad
      // signature never strands the request in 'submitting'.
      const prep = await cds.tx(async (db: cds.Transaction) => {
        const now = new Date().toISOString();
        const claimed = await db.run(
          UPDATE.entity(SigningRequests)
            .set({ status: 'submitting' })
            .where({
              id: signingRequestId,
              status: { in: ['pending', 'verified'] },
              expiresAt: { '>': now },
            })
        );

        if (claimed === 0) {
          // Claim failed — fetch to provide a specific error message
          const existing = await db.run(SELECT.one.from(SigningRequests).where({ id: signingRequestId }));
          if (!existing) rejectInvalid(req, 'SubmitVerifiedTransaction', 'Signing request not found', 'signingRequestId');
          if (existing.expiresAt <= now) rejectInvalid(req, 'SubmitVerifiedTransaction', 'Signing request has expired', 'signingRequestId');
          rejectInvalid(req, 'SubmitVerifiedTransaction', `Signing request status is '${existing.status}', expected 'pending' or 'verified'`, 'signingRequestId');
        }

        // Re-fetch the full record (now with status='submitting')
        const signingRequest = await db.run(SELECT.one.from(SigningRequests).where({ id: signingRequestId }));

        // Ownership check: verify address matches build owner (defense-in-depth)
        if (address && signingRequest.build_id) {
          await verifyBuildOwnership(req, db, signingRequest.build_id, address, TransactionBuilds, 'SubmitVerifiedTransaction');
        }

        // Check if build association exists
        if (!signingRequest.build_id) {
          rejectInvalid(req, 'SubmitVerifiedTransaction', 'Signing request has no associated build', 'signingRequestId');
        }

        // Detect if signedTxCbor is a witness set (CIP-30) or a full signed transaction (cardano-cli)
        const fullSignedTxCbor = isWitnessSetCbor(signedTxCbor)
          ? combineTransactionWithWitnesses(signingRequest.unsignedTxCbor, signedTxCbor)
          : signedTxCbor;

        // Verify signature (throws on failure) — bound to the keys that must
        // actually witness this transaction (required_signers + fee payer)
        const requiredSigners = await resolveRequiredSigners(db, signingRequest, TransactionBuilds);
        const verificationResult = getExternalSignerModule().verifyOrThrow(fullSignedTxCbor, signingRequest.txBodyHash, { requiredSigners });

        return { buildId: signingRequest.build_id as string, txHash: signingRequest.txBodyHash as string, fullSignedTxCbor, verificationResult };
      });

      logger.info({ signingRequestId, witnessCount: prep.verificationResult.witnessCount }, 'Signature verified, proceeding with submission');

      // PHASES 2+3: submit outside any DB tx, then finalize in its own tx
      const submissionRecord = await submitAndFinalize(SigningRequests, {
        signingRequestId,
        buildId: prep.buildId,
        fullSignedTxCbor: prep.fullSignedTxCbor,
        txHash: prep.txHash,
        verificationResult: prep.verificationResult,
        signerType,
        signerInfo,
      });

      logger.info({ signingRequestId, txHash: prep.txHash }, 'Transaction submitted and all records updated');
      return submissionRecord;
    } catch (e: unknown) {
      logger.error({ err: e }, 'SubmitVerifiedTransaction error');
      return mapError(req, e, 'SubmitVerifiedTransaction');
    }
  });

  /**
   * Verify a CIP-30 signData (COSE_Sign1) message signature (unbound action).
   * Stateless crypto check behind wallet-based login — no DB write, no state.
   * Public (@requires:'any' in CDS) because the caller is not yet authenticated.
   * @param req - CDS request with address, coseSignature, coseKey, expectedPayload
   * @returns { valid, reason, signedPayload, signerVkh }
   */
  srv.on('VerifyDataSignature', async (req: Request) => {
    logger.debug('VerifyDataSignature Action handler called');
    const { address, coseSignature, coseKey, expectedPayload } = req.data;

    // Validate inputs before the crypto check
    if (!address) rejectMissing(req, 'VerifyDataSignature', 'address');
    if (!isValidBech32Address(address)) rejectInvalid(req, 'VerifyDataSignature', 'Invalid bech32 address format', 'address');
    if (!coseSignature) rejectMissing(req, 'VerifyDataSignature', 'coseSignature');
    if (!coseKey) rejectMissing(req, 'VerifyDataSignature', 'coseKey');

    // verifyDataSignature never throws: a bad/forged signature is a 200 with
    // valid:false + reason, not an error. Only malformed *inputs* reject above.
    return verifyDataSignature({ address, coseSignature, coseKey, expectedPayload });
  });

  /**
   * Get all existing signing requests by address
   * @param req - CDS request object (with address)
   * @returns {AddressSigningRequests} Address signing request associations
   */
  srv.on('GetSigningRequestsByAddress', async (req: Request) => {
    logger.debug('GetSigningRequestsByAddress Action handler called');
    const { address } = req.data;
    // Validate input before business logic
    if (!address) rejectMissing(req, 'GetSigningRequestsByAddress', 'address');
    if (!isValidBech32Address(address)) rejectInvalid(req, 'GetSigningRequestsByAddress', 'Invalid bech32 address format', 'address');
    // Fetch the address-signing request associations
    return handleRequest(req, async (db) => {
      return db.run(SELECT.from(AddressSigningRequests).where({ address_address: address }));
    });
  });

  // ---------------------------------------------------------------------------
  // HSM (Hardware Security Module) Signing Actions
  // ---------------------------------------------------------------------------

  /**
   * Sign a transaction using the configured HSM.
   * Creates signing request, signs with HSM, verifies the signature.
   * @param req - CDS request object (with buildId)
   * @returns {SigningRequest} Signing request with status 'verified'
   */
  srv.on('SignWithHsm', async (req: Request) => {
    logger.debug('SignWithHsm Action handler called');
    enforceHsmRole(req, 'SignWithHsm');
    const { buildId, address } = req.data;

    // Validate input
    const errors = validateTransactionInputs({ buildId }, ['buildId']);
    throwIfValidationErrors(req, 'SignWithHsm', errors);
    if (address && !isValidBech32Address(address)) rejectInvalid(req, 'SignWithHsm', 'Invalid bech32 address format', 'address');

    // Check HSM is available (before handleRequest — same pattern as validation)
    const hsmSigner = getHsmSigner();
    if (!hsmSigner || !hsmSigner.isConnected()) {
      rejectInvalid(req, 'SignWithHsm', 'HSM is not configured or not connected', 'hsm');
    }

    return handleRequest(req, async (db) => {
      // 1. Fetch the build (with ownership check)
      const build = await verifyBuildOwnership(req, db, buildId, address, TransactionBuilds, 'SignWithHsm');

      // HSM can only sign builds for its own address
      const hsmAddress = hsmSigner!.getAddress();
      if (build.senderAddress !== hsmAddress) {
        rejectInvalid(req, 'SignWithHsm', `Build sender '${build.senderAddress}' does not match HSM address '${hsmAddress}'`, 'buildId');
      }

      // 2. Create signing request internally (reuse external signer module)
      const signerModule = getExternalSignerModule();
      const signingPayload = signerModule.createSigningRequest(
        build.id, build.unsignedTxCbor, build.txBodyHash, build.network, 'HSM signing'
      );

      const signingRequestRecord = await getCardanoIndexer().persistSigningRequest(db, {
        buildId,
        signingPayload,
      });

      // 3. Sign with HSM
      const signedTxCbor = hsmSigner!.signTransaction(build.unsignedTxCbor, build.txBodyHash);

      // 4. Verify the HSM signature (same verification path as external signing)
      const verificationResult = signerModule.verifySignedTransaction(signedTxCbor, build.txBodyHash);

      const hsmStatus = hsmSigner!.getStatus();
      const hsmKeyIdentifier = hsmStatus.keyLabel || hsmStatus.keyId || 'unknown';

      // A failed HSM verification is an HSM/server fault, not a successful sign —
      // reject (rolls back) instead of returning 200 with status 'failed', matching
      // SignAndSubmitWithHsm.
      if (!verificationResult.isValid) {
        logger.error({ signingRequestId: signingRequestRecord.id, hsmKey: hsmKeyIdentifier }, 'HSM signature verification failed');
        rejectInvalid(req, 'SignWithHsm', 'HSM signature verification failed', 'signedTxCbor');
      }

      // 5. Persist verification
      await getCardanoIndexer().persistSignatureVerification(db, {
        signingRequestId: signingRequestRecord.id,
        signedTxCbor,
        verificationResult,
        signerType: 'hsm',
        signerInfo: `HSM key: ${hsmKeyIdentifier}`,
      });

      // 6. Update HSM audit field
      await db.run(
        UPDATE.entity(SigningRequests)
          .set({ hsmKeyId: hsmKeyIdentifier })
          .where({ id: signingRequestRecord.id })
      );

      logger.info({
        buildId,
        signingRequestId: signingRequestRecord.id,
        isValid: verificationResult.isValid,
        hsmKey: hsmKeyIdentifier,
      }, 'Transaction signed with HSM');

      // Return updated signing request
      return db.run(SELECT.one.from(SigningRequests).where({ id: signingRequestRecord.id }));
    });
  });

  /**
   * Sign a transaction with HSM and submit to blockchain atomically.
   * Creates signing request, signs, verifies, and submits in one operation.
   * @param req - CDS request object (with buildId)
   * @returns {TransactionSubmission} Transaction submission details
   */
  srv.on('SignAndSubmitWithHsm', async (req: Request) => {
    logger.debug('SignAndSubmitWithHsm Action handler called');
    enforceHsmRole(req, 'SignAndSubmitWithHsm');
    const { buildId, address } = req.data;

    // Validate input
    const errors = validateTransactionInputs({ buildId }, ['buildId']);
    throwIfValidationErrors(req, 'SignAndSubmitWithHsm', errors);
    if (address && !isValidBech32Address(address)) rejectInvalid(req, 'SignAndSubmitWithHsm', 'Invalid bech32 address format', 'address');

    // Check HSM is available
    const hsmSigner = getHsmSigner();
    if (!hsmSigner || !hsmSigner.isConnected()) {
      rejectInvalid(req, 'SignAndSubmitWithHsm', 'HSM is not configured or not connected', 'hsm');
    }

    try {
      // PHASE 1 (committed): fetch build, sign with HSM, verify. A failure
      // here rolls back the freshly-created signing request.
      const prep = await cds.tx(async (db: cds.Transaction) => {
        // 1. Fetch the build (with ownership check)
        const build = await verifyBuildOwnership(req, db, buildId, address, TransactionBuilds, 'SignAndSubmitWithHsm');

        // HSM can only sign builds for its own address
        const hsmAddress = hsmSigner!.getAddress();
        if (build.senderAddress !== hsmAddress) {
          rejectInvalid(req, 'SignAndSubmitWithHsm', `Build sender '${build.senderAddress}' does not match HSM address '${hsmAddress}'`, 'buildId');
        }

        // 2. Create signing request
        const signerModule = getExternalSignerModule();
        const signingPayload = signerModule.createSigningRequest(
          build.id, build.unsignedTxCbor, build.txBodyHash, build.network, 'HSM signing + submit'
        );
        const signingRequestRecord = await getCardanoIndexer().persistSigningRequest(db, { buildId, signingPayload });

        // 3. Sign with HSM
        const signedTxCbor = hsmSigner!.signTransaction(build.unsignedTxCbor, build.txBodyHash);

        // 4. Verify HSM signature — reject (rolls back) if invalid before submitting
        const verificationResult = signerModule.verifySignedTransaction(signedTxCbor, build.txBodyHash);
        const hsmStatus = hsmSigner!.getStatus();
        const hsmKeyIdentifier = hsmStatus.keyLabel || hsmStatus.keyId || 'unknown';

        if (!verificationResult.isValid) {
          logger.error({ signingRequestId: signingRequestRecord.id, hsmKey: hsmKeyIdentifier }, 'HSM signature verification failed — aborting submission');
          rejectInvalid(req, 'SignAndSubmitWithHsm', 'HSM signature verification failed', 'signedTxCbor');
        }

        // Claim the request as 'submitting' in this same committed phase
        await db.run(UPDATE.entity(SigningRequests).set({ status: 'submitting', hsmKeyId: hsmKeyIdentifier }).where({ id: signingRequestRecord.id }));

        return { signingRequestId: signingRequestRecord.id as string, signedTxCbor, txHash: build.txBodyHash as string, verificationResult, hsmKeyIdentifier };
      });

      logger.info({ signingRequestId: prep.signingRequestId, witnessCount: prep.verificationResult.witnessCount, hsmKey: prep.hsmKeyIdentifier }, 'HSM signature verified, proceeding with submission');

      // PHASES 2+3: submit outside any DB tx, then finalize (re-set hsmKeyId,
      // which indexVerifiedTransactionSubmission does not touch)
      const submissionRecord = await submitAndFinalize(
        SigningRequests,
        {
          signingRequestId: prep.signingRequestId,
          buildId,
          fullSignedTxCbor: prep.signedTxCbor,
          txHash: prep.txHash,
          verificationResult: prep.verificationResult,
          signerType: 'hsm',
          signerInfo: `HSM key: ${prep.hsmKeyIdentifier}`,
        },
        (db) => db.run(UPDATE.entity(SigningRequests).set({ hsmKeyId: prep.hsmKeyIdentifier }).where({ id: prep.signingRequestId })).then(() => undefined)
      );

      logger.info({ signingRequestId: prep.signingRequestId, txHash: prep.txHash }, 'HSM-signed transaction submitted and all records updated');
      return submissionRecord;
    } catch (e: unknown) {
      logger.error({ err: e }, 'SignAndSubmitWithHsm error');
      return mapError(req, e, 'SignAndSubmitWithHsm');
    }
  });

  /**
   * Get HSM connection status and key information.
   * Returns null fields if HSM is not configured.
   */
  srv.on('GetHsmStatus', async (_req: Request) => {
    enforceHsmRole(_req, 'GetHsmStatus');
    const hsmSigner = getHsmSigner();
    if (!hsmSigner) {
      return {
        connected: false,
        keyId: null,
        keyLabel: null,
        publicKeyHash: null,
        cardanoAddress: null,
      };
    }
    const status = hsmSigner.getStatus();
    return {
      connected: status.connected,
      keyId: status.keyId || null,
      keyLabel: status.keyLabel || null,
      publicKeyHash: status.publicKeyHash || null,
      cardanoAddress: status.address || null,
    };
  });
};