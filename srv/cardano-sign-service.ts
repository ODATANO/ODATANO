import cds, { Request } from '@sap/cds';
import { handleRequest} from './utils/backend-request-handler';
import { rejectInvalid, throwIfValidationErrors,rejectMissing } from './utils/errors';
import { mapError } from './utils/mappers';
import { validateTransactionInputs, isValidBech32Address, extractPaymentCredential } from './utils/validators';
import { parseTransaction } from './cbor';
import { getCardanoIndexer, getHsmConfig } from './server';
import { getExternalSignerModule } from './blockchain/signing/external-signer';
import { getHsmSigner } from './blockchain/signing/hsm-signer';
import { verifyDataSignature } from './blockchain/signing/cose-verifier';
import { combineTransactionWithWitnesses, isWitnessSetCbor } from './utils/signing-helper';
import { detachedTx } from './utils/tx-utils';
import { submitAndFinalize, scheduleDeferredSubmit } from './blockchain/signing/submission-finalizer';
const { SELECT, UPDATE } = cds.ql;

const logger = cds.log('CardanoSignService');

interface TransactionBuildRecord {
  id: string;
  senderAddress: string;
  unsignedTxCbor: string;
  txBodyHash: string;
  network: string;
}

/** Load a build and, when an address is given, check it matches the build's senderAddress. */
async function verifyBuildOwnership(
  req: Request, db: cds.Transaction, buildId: string, address: string | undefined, TransactionBuilds: unknown, actionName: string
): Promise<TransactionBuildRecord> {
  const build = await db.run(SELECT.one.from(TransactionBuilds as never).where({ id: buildId })) as TransactionBuildRecord | undefined;
  if (!build) rejectInvalid(req, actionName, 'Build not found', 'buildId');
  if (address && build.senderAddress !== address) {
    rejectInvalid(req, actionName, 'Address does not match build owner', 'address');
  }
  return build;
}

/**
 * Expire a pending signing request past its TTL.
 * @returns true if expired, false otherwise
 */
async function checkAndExpireSigningRequest(
  db: cds.Transaction, signingRequest: { id: string; status: string }, SigningRequests: unknown
): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await db.run(
    UPDATE.entity(SigningRequests as never)
      .set({ status: 'expired' })
      // Only pending requests may expire; never flip a 'submitted'/'verified' row.
      .where({ id: signingRequest.id, status: 'pending', expiresAt: { '<=': now } })
  ) as number;
  if (result > 0) {
    signingRequest.status = 'expired';
    return true;
  }
  // A later req.reject rolls this update back; the next touch re-applies it.
  return false;
}

/**
 * Key hashes that must witness a signing request: the body's `required_signers` plus the
 * payment key hash of the build's senderAddress (script credentials skipped).
 * Returns undefined when nothing is derivable.
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
    // Body-hash verification still protects integrity.
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

/** 403 unless the user holds hsm.requiresRole (no-op when none is configured). */
function enforceHsmRole(req: Request, actionName: string): void {
  const hsmConfig = getHsmConfig();
  if (hsmConfig?.requiresRole && !req.user?.is(hsmConfig.requiresRole)) {
    req.reject(403, `Action '${actionName}' requires role '${hsmConfig.requiresRole}'`);
  }
}

/** CardanoSignService handlers: external and HSM signing, verification, submission. */
module.exports = (srv: cds.Service) => {
  logger.info('Module loaded - registering handlers');

  const {
    SigningRequests,
      AddressSigningRequests,
      TransactionBuilds,
  } = require('#cds-models/CardanoSignService');

  // before-READ: bulk-expire pending requests past their TTL, at most once per minute.
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


  // CreateSigningRequest — persist a signing request for a build (idempotent per pending build).
  srv.on('CreateSigningRequest', async (req: Request) => {
    logger.debug('CreateSigningRequest Action handler called');
    const { buildId , message } = req.data;

    const errors = validateTransactionInputs({ buildId }, ['buildId']);
    throwIfValidationErrors(req, 'CreateSigningRequest', errors);

    return handleRequest(req, async (db) => {
      const build = await db.run(SELECT.one.from(TransactionBuilds).where({ id: buildId }));
      if (!build) rejectInvalid(req, 'CreateSigningRequest', 'Build not found', 'buildId');

      const existingRequest = await db.run(
        SELECT.one.from(SigningRequests).where({ build_id: buildId, status: 'pending' })
      );
      if (existingRequest) {
        logger.info({ buildId, signingRequestId: existingRequest.id }, 'Returning existing signing request');
        return existingRequest;
      }

      const signerModule = getExternalSignerModule();
      const signingPayload = signerModule.createSigningRequest(
        build.id,
        build.unsignedTxCbor,
        build.txBodyHash,
        build.network, 
        message
      );

      const signingRequestRecord = await getCardanoIndexer().persistSigningRequest(db, {
        buildId,
        signingPayload,
      });

      logger.info({ buildId, signingRequestId: signingRequestRecord.id }, 'Created signing request');

      return signingRequestRecord;
    });
  });

  // GetSigningRequest — by id; expires a pending request past its TTL on read.
  srv.on('GetSigningRequest', async (req: Request) => {
    logger.debug('GetSigningRequest Action handler called');
    const { signingRequestId } = req.data;

    const errors = validateTransactionInputs({ signingRequestId }, ['signingRequestId']);
    throwIfValidationErrors(req, 'GetSigningRequest', errors);

    return handleRequest(req, async (db) => {
      const signingRequest = await db.run(SELECT.one.from(SigningRequests).where({ id: signingRequestId }));
      if (!signingRequest) rejectInvalid(req, 'GetSigningRequest', 'Signing request not found', 'signingRequestId');

      if (signingRequest.status === 'pending') {
        await checkAndExpireSigningRequest(db, signingRequest, SigningRequests);
      }

      return signingRequest;
    });
  });

  // VerifySignature — verify a signed tx / witness set against the request; persists the result.
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
      const signingRequest = await db.run(SELECT.one.from(SigningRequests).where({ id: signingRequestId }));
      if (!signingRequest) rejectInvalid(req, 'VerifySignature', 'Signing request not found', 'signingRequestId');

      // Ownership check (defense in depth)
      if (address && signingRequest.build_id) {
        await verifyBuildOwnership(req, db, signingRequest.build_id, address, TransactionBuilds, 'VerifySignature');
      }

      // Atomic claim (pending → 'signed') so concurrent verifies cannot both pass;
      // persistSignatureVerification sets the final 'verified'/'failed'.
      const now = new Date().toISOString();
      const claimed = await db.run(
        UPDATE.entity(SigningRequests)
          .set({ status: 'signed' })
          .where({ id: signingRequestId, status: 'pending', expiresAt: { '>': now } })
      );
      if (claimed === 0) {
        // Re-read for an accurate message; a concurrent verify may have moved it.
        const current = await db.run(SELECT.one.from(SigningRequests).where({ id: signingRequestId }));
        if (current && current.status === 'pending' && current.expiresAt <= now) {
          await db.run(UPDATE.entity(SigningRequests).set({ status: 'expired' }).where({ id: signingRequestId, status: 'pending' }));
          rejectInvalid(req, 'VerifySignature', 'Signing request has expired', 'signingRequestId');
        }
        rejectInvalid(req, 'VerifySignature', `Signing request status is '${current?.status ?? 'unknown'}', expected 'pending'`, 'signingRequestId');
      }

      // A CIP-30 wallet returns only the witness set; cardano-cli a full signed tx.
      let fullSignedTxCbor: string;
      if (isWitnessSetCbor(signedTxCbor)) {
        fullSignedTxCbor = combineTransactionWithWitnesses(signingRequest.unsignedTxCbor, signedTxCbor);
        logger.debug({ signingRequestId }, 'Combined witness set with unsigned transaction for verification');
      } else {
        fullSignedTxCbor = signedTxCbor;
      }

      // Verification is bound to the keys that must witness this tx.
      const requiredSigners = await resolveRequiredSigners(db, signingRequest, TransactionBuilds);
      const signerModule = getExternalSignerModule();
      const result = signerModule.verifySignedTransaction(fullSignedTxCbor, signingRequest.txBodyHash, { requiredSigners });

      // Store the full signed tx for later submission
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

  // SubmitVerifiedTransaction — verify and submit in one step.
  srv.on('SubmitVerifiedTransaction', async (req: Request) => {
    logger.debug('SubmitVerifiedTransaction Action handler called');
    const { signingRequestId, signedTxCbor, signerType, signerInfo, address } = req.data;
    const deferSubmit = req.data.deferSubmit === true;

    const errors = validateTransactionInputs(
      { signingRequestId, signedTxCbor },
      ['signingRequestId', 'signedTxCbor']
    );
    throwIfValidationErrors(req, 'SubmitVerifiedTransaction', errors);
    if (address && !isValidBech32Address(address)) rejectInvalid(req, 'SubmitVerifiedTransaction', 'Invalid bech32 address format', 'address');

    // Three committed phases (see submitAndFinalize): the network submit must not run inside
    // an open DB transaction. With deferSubmit, phase 1 joins the caller's transaction, the
    // response carries the tx hash (= body hash) and the submit runs after the caller's commit.
    try {
      // Phase 1: verify, then atomically claim → 'submitting'. The claim is the last statement
      // so a verification failure swallowed by the caller never leaves a stranded claim behind.
      const phase1 = async (db: cds.Transaction) => {
        const now = new Date().toISOString();
        const signingRequest = await db.run(SELECT.one.from(SigningRequests).where({ id: signingRequestId }));
        if (!signingRequest) rejectInvalid(req, 'SubmitVerifiedTransaction', 'Signing request not found', 'signingRequestId');
        if (signingRequest.expiresAt <= now) rejectInvalid(req, 'SubmitVerifiedTransaction', 'Signing request has expired', 'signingRequestId');
        if (!['pending', 'verified'].includes(signingRequest.status)) {
          rejectInvalid(req, 'SubmitVerifiedTransaction', `Signing request status is '${signingRequest.status}', expected 'pending' or 'verified'`, 'signingRequestId');
        }

        // Ownership check (defense in depth)
        if (address && signingRequest.build_id) {
          await verifyBuildOwnership(req, db, signingRequest.build_id, address, TransactionBuilds, 'SubmitVerifiedTransaction');
        }

        if (!signingRequest.build_id) {
          rejectInvalid(req, 'SubmitVerifiedTransaction', 'Signing request has no associated build', 'signingRequestId');
        }

        // CIP-30 witness set or full signed tx
        const fullSignedTxCbor = isWitnessSetCbor(signedTxCbor)
          ? combineTransactionWithWitnesses(signingRequest.unsignedTxCbor, signedTxCbor)
          : signedTxCbor;

        // Throws on failure; bound to the keys that must witness this tx.
        const requiredSigners = await resolveRequiredSigners(db, signingRequest, TransactionBuilds);
        const verificationResult = getExternalSignerModule().verifyOrThrow(fullSignedTxCbor, signingRequest.txBodyHash, { requiredSigners });

        // Atomic claim. Deferred path also persists the signed CBOR + signer metadata so an
        // interrupted submission can be re-driven after a restart.
        const claimed = await db.run(
          UPDATE.entity(SigningRequests)
            .set({
              status: 'submitting',
              ...(deferSubmit ? { signedTxCbor: fullSignedTxCbor, signerType, signerInfo } : {}),
            })
            .where({
              id: signingRequestId,
              status: { in: ['pending', 'verified'] },
              expiresAt: { '>': now },
            })
        );
        if (claimed === 0) {
          rejectInvalid(req, 'SubmitVerifiedTransaction', 'Signing request was claimed by a concurrent submission', 'signingRequestId');
        }

        return { buildId: signingRequest.build_id as string, txHash: signingRequest.txBodyHash as string, fullSignedTxCbor, verificationResult };
      };

      const finalizeParams = (prep: Awaited<ReturnType<typeof phase1>>) => ({
        signingRequestId,
        buildId: prep.buildId,
        fullSignedTxCbor: prep.fullSignedTxCbor,
        txHash: prep.txHash,
        verificationResult: prep.verificationResult,
        signerType,
        signerInfo,
      });

      if (deferSubmit) {
        // Phase 1 on the caller's transaction; validation errors stay synchronous.
        const prep = await phase1(cds.tx(req) as cds.Transaction);
        scheduleDeferredSubmit(req, SigningRequests, finalizeParams(prep));
        logger.info({ signingRequestId, txHash: prep.txHash }, 'Verified and claimed — submit deferred until after the caller commits');
        return {
          id: null,
          build_id: prep.buildId,
          txHash: prep.txHash,
          signedTxCbor: prep.fullSignedTxCbor,
          status: 'pending',
          submittedAt: null,
        };
      }

      const prep = await detachedTx('claim + verify signing request', phase1);

      logger.info({ signingRequestId, witnessCount: prep.verificationResult.witnessCount }, 'Signature verified, proceeding with submission');

      // Phases 2+3: submit outside any DB tx, then finalize in its own tx
      const submissionRecord = await submitAndFinalize(SigningRequests, finalizeParams(prep));

      logger.info({ signingRequestId, txHash: prep.txHash }, 'Transaction submitted and all records updated');
      return submissionRecord;
    } catch (e: unknown) {
      logger.error({ err: e }, 'SubmitVerifiedTransaction error');
      return mapError(req, e, 'SubmitVerifiedTransaction');
    }
  });

  // VerifyDataSignature — stateless CIP-30 signData (COSE_Sign1) check for wallet login.
  // Public (@requires:'any') because the caller is not yet authenticated.
  srv.on('VerifyDataSignature', async (req: Request) => {
    logger.debug('VerifyDataSignature Action handler called');
    const { address, coseSignature, coseKey, expectedPayload } = req.data;

    if (!address) rejectMissing(req, 'VerifyDataSignature', 'address');
    if (!isValidBech32Address(address)) rejectInvalid(req, 'VerifyDataSignature', 'Invalid bech32 address format', 'address');
    if (!coseSignature) rejectMissing(req, 'VerifyDataSignature', 'coseSignature');
    if (!coseKey) rejectMissing(req, 'VerifyDataSignature', 'coseKey');

    // Never throws: a bad signature is a 200 with valid:false + reason.
    return verifyDataSignature({ address, coseSignature, coseKey, expectedPayload });
  });

  // GetSigningRequestsByAddress — address ↔ signing request associations.
  srv.on('GetSigningRequestsByAddress', async (req: Request) => {
    logger.debug('GetSigningRequestsByAddress Action handler called');
    const { address } = req.data;
    if (!address) rejectMissing(req, 'GetSigningRequestsByAddress', 'address');
    if (!isValidBech32Address(address)) rejectInvalid(req, 'GetSigningRequestsByAddress', 'Invalid bech32 address format', 'address');
    return handleRequest(req, async (db) => {
      return db.run(SELECT.from(AddressSigningRequests).where({ address_address: address }));
    });
  });

  // ---------------------------------------------------------------------------
  // HSM signing actions
  // ---------------------------------------------------------------------------

  // SignWithHsm — create a signing request, sign with the HSM, verify; returns the request.
  srv.on('SignWithHsm', async (req: Request) => {
    logger.debug('SignWithHsm Action handler called');
    enforceHsmRole(req, 'SignWithHsm');
    const { buildId, address } = req.data;

    const errors = validateTransactionInputs({ buildId }, ['buildId']);
    throwIfValidationErrors(req, 'SignWithHsm', errors);
    if (address && !isValidBech32Address(address)) rejectInvalid(req, 'SignWithHsm', 'Invalid bech32 address format', 'address');

    const hsmSigner = getHsmSigner();
    if (!hsmSigner || !hsmSigner.isConnected()) {
      rejectInvalid(req, 'SignWithHsm', 'HSM is not configured or not connected', 'hsm');
    }

    return handleRequest(req, async (db) => {
      const build = await verifyBuildOwnership(req, db, buildId, address, TransactionBuilds, 'SignWithHsm');

      // The HSM can only sign builds for its own address
      const hsmAddress = hsmSigner!.getAddress();
      if (build.senderAddress !== hsmAddress) {
        rejectInvalid(req, 'SignWithHsm', `Build sender '${build.senderAddress}' does not match HSM address '${hsmAddress}'`, 'buildId');
      }

      const signerModule = getExternalSignerModule();
      const signingPayload = signerModule.createSigningRequest(
        build.id, build.unsignedTxCbor, build.txBodyHash, build.network, 'HSM signing'
      );

      const signingRequestRecord = await getCardanoIndexer().persistSigningRequest(db, {
        buildId,
        signingPayload,
      });

      const signedTxCbor = hsmSigner!.signTransaction(build.unsignedTxCbor, build.txBodyHash);

      // Same verification path as external signing
      const verificationResult = signerModule.verifySignedTransaction(signedTxCbor, build.txBodyHash);

      const hsmStatus = hsmSigner!.getStatus();
      const hsmKeyIdentifier = hsmStatus.keyLabel || hsmStatus.keyId || 'unknown';

      // A failed HSM verification is a server fault: reject (rolls back) rather than 200 'failed'.
      if (!verificationResult.isValid) {
        logger.error({ signingRequestId: signingRequestRecord.id, hsmKey: hsmKeyIdentifier }, 'HSM signature verification failed');
        rejectInvalid(req, 'SignWithHsm', 'HSM signature verification failed', 'signedTxCbor');
      }

      await getCardanoIndexer().persistSignatureVerification(db, {
        signingRequestId: signingRequestRecord.id,
        signedTxCbor,
        verificationResult,
        signerType: 'hsm',
        signerInfo: `HSM key: ${hsmKeyIdentifier}`,
      });

      // HSM audit field
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

      return db.run(SELECT.one.from(SigningRequests).where({ id: signingRequestRecord.id }));
    });
  });

  // SignAndSubmitWithHsm — create a signing request, sign, verify and submit in one call.
  srv.on('SignAndSubmitWithHsm', async (req: Request) => {
    logger.debug('SignAndSubmitWithHsm Action handler called');
    enforceHsmRole(req, 'SignAndSubmitWithHsm');
    const { buildId, address } = req.data;
    const deferSubmit = req.data.deferSubmit === true;

    const errors = validateTransactionInputs({ buildId }, ['buildId']);
    throwIfValidationErrors(req, 'SignAndSubmitWithHsm', errors);
    if (address && !isValidBech32Address(address)) rejectInvalid(req, 'SignAndSubmitWithHsm', 'Invalid bech32 address format', 'address');

    const hsmSigner = getHsmSigner();
    if (!hsmSigner || !hsmSigner.isConnected()) {
      rejectInvalid(req, 'SignAndSubmitWithHsm', 'HSM is not configured or not connected', 'hsm');
    }

    try {
      // Phase 1 (committed): fetch build, sign, verify. A failure rolls back the new signing
      // request; on the deferred path a swallowed failure leaves a 'pending' row that expires via TTL.
      const phase1 = async (db: cds.Transaction) => {
        const build = await verifyBuildOwnership(req, db, buildId, address, TransactionBuilds, 'SignAndSubmitWithHsm');

        // The HSM can only sign builds for its own address
        const hsmAddress = hsmSigner!.getAddress();
        if (build.senderAddress !== hsmAddress) {
          rejectInvalid(req, 'SignAndSubmitWithHsm', `Build sender '${build.senderAddress}' does not match HSM address '${hsmAddress}'`, 'buildId');
        }

        const signerModule = getExternalSignerModule();
        const signingPayload = signerModule.createSigningRequest(
          build.id, build.unsignedTxCbor, build.txBodyHash, build.network, 'HSM signing + submit'
        );
        const signingRequestRecord = await getCardanoIndexer().persistSigningRequest(db, { buildId, signingPayload });

        const signedTxCbor = hsmSigner!.signTransaction(build.unsignedTxCbor, build.txBodyHash);

        // Reject (rolls back) on an invalid signature before submitting
        const verificationResult = signerModule.verifySignedTransaction(signedTxCbor, build.txBodyHash);
        const hsmStatus = hsmSigner!.getStatus();
        const hsmKeyIdentifier = hsmStatus.keyLabel || hsmStatus.keyId || 'unknown';

        if (!verificationResult.isValid) {
          logger.error({ signingRequestId: signingRequestRecord.id, hsmKey: hsmKeyIdentifier }, 'HSM signature verification failed — aborting submission');
          rejectInvalid(req, 'SignAndSubmitWithHsm', 'HSM signature verification failed', 'signedTxCbor');
        }

        // Claim as 'submitting'; deferred path also persists signed CBOR + signer metadata
        // for the boot-time redrive of interrupted submissions.
        await db.run(UPDATE.entity(SigningRequests).set({
          status: 'submitting',
          hsmKeyId: hsmKeyIdentifier,
          ...(deferSubmit ? { signedTxCbor, signerType: 'hsm', signerInfo: `HSM key: ${hsmKeyIdentifier}` } : {}),
        }).where({ id: signingRequestRecord.id }));

        return { signingRequestId: signingRequestRecord.id as string, signedTxCbor, txHash: build.txBodyHash as string, verificationResult, hsmKeyIdentifier };
      };

      const finalizeParams = (prep: Awaited<ReturnType<typeof phase1>>) => ({
        signingRequestId: prep.signingRequestId,
        buildId,
        fullSignedTxCbor: prep.signedTxCbor,
        txHash: prep.txHash,
        verificationResult: prep.verificationResult,
        signerType: 'hsm',
        signerInfo: `HSM key: ${prep.hsmKeyIdentifier}`,
      });

      if (deferSubmit) {
        // Phase 1 on the caller's transaction; submit runs after its commit.
        const prep = await phase1(cds.tx(req) as cds.Transaction);
        scheduleDeferredSubmit(req, SigningRequests, finalizeParams(prep));
        logger.info({ signingRequestId: prep.signingRequestId, txHash: prep.txHash }, 'HSM-signed and claimed — submit deferred until after the caller commits');
        return {
          id: null,
          build_id: buildId,
          txHash: prep.txHash,
          signedTxCbor: prep.signedTxCbor,
          status: 'pending',
          submittedAt: null,
        };
      }

      const prep = await detachedTx('HSM sign + claim signing request', phase1);

      logger.info({ signingRequestId: prep.signingRequestId, witnessCount: prep.verificationResult.witnessCount, hsmKey: prep.hsmKeyIdentifier }, 'HSM signature verified, proceeding with submission');

      // Phases 2+3: submit outside any DB tx, then finalize (re-sets hsmKeyId, which the
      // generic finalizer does not touch)
      const submissionRecord = await submitAndFinalize(
        SigningRequests,
        finalizeParams(prep),
        (db) => db.run(UPDATE.entity(SigningRequests).set({ hsmKeyId: prep.hsmKeyIdentifier }).where({ id: prep.signingRequestId })).then(() => undefined)
      );

      logger.info({ signingRequestId: prep.signingRequestId, txHash: prep.txHash }, 'HSM-signed transaction submitted and all records updated');
      return submissionRecord;
    } catch (e: unknown) {
      logger.error({ err: e }, 'SignAndSubmitWithHsm error');
      return mapError(req, e, 'SignAndSubmitWithHsm');
    }
  });

  // GetHsmStatus — connection status and key info; null fields when no HSM is configured.
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