import cds, { Request } from '@sap/cds';
import { handleRequest} from './utils/backend-request-handler';
import { BackendError, NotFoundError, rejectInvalid, throwIfValidationErrors, rejectMissing } from './utils/errors';
import { ERROR_CODES } from './utils/error-codes';
import { mapError } from './utils/mappers';
import { validateTransactionInputs, isValidBech32Address, isValidBech32StakeAddress, extractPaymentCredential } from './utils/validators';
import { parseTransaction } from './cbor';
import { getCardanoClient, getCardanoIndexer, getHsmConfig } from './server';
import { getExternalSignerModule } from './blockchain/signing/external-signer';
import { getHsmSigner, type HsmSigner } from './blockchain/signing/hsm-signer';
import { verifyDataSignature } from './blockchain/signing/cose-verifier';
import { toSignedTransaction } from './utils/signing-helper';
import { detachedTx, readOutside } from './utils/tx-utils';
import { pageOf } from './utils/paging';
import { answerNumbersAsText } from './utils/result-numbers';
import { submitAndFinalize, scheduleDeferredSubmit } from './blockchain/signing/submission-finalizer';
import { sendProblem } from './blockchain/signing/landing-proof';
import { checkResolvedTxHash, refuseFailedWhileItCanLand, resolutionNote, resolvedConcurrently } from './utils/resolution';
import type { TransactionBuild } from '#cds-models/CardanoSignService';
import { TransactionBuildOutputs } from '#cds-models/odatano/cardano';
const { SELECT, UPDATE } = cds.ql;

const logger = cds.log('CardanoSignService');


/** A stored build: these columns are always set. */
type StoredBuild = Omit<TransactionBuild, 'id' | 'senderAddress' | 'unsignedTxCbor' | 'txBodyHash' | 'network'>
  & { id: string; senderAddress: string; unsignedTxCbor: string; txBodyHash: string; network: string };

/** Load a build and, when an address is given, check it matches the build's senderAddress. */
async function verifyBuildOwnership(
  req: Request, db: cds.Transaction, buildId: string, address: string | undefined, TransactionBuilds: unknown, actionName: string
): Promise<StoredBuild> {
  const build = await db.run(SELECT.one.from(TransactionBuilds as never).where({ id: buildId })) as StoredBuild | undefined;
  if (!build) rejectInvalid(req, actionName, 'Build not found', 'buildId');
  if (address && build.senderAddress !== address) {
    rejectInvalid(req, actionName, 'Address does not match build owner', 'address');
  }
  return build;
}

/** Expires a pending signing request past its TTL. Returns true if it expired. */
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

// Key hashes that must sign: the body's required_signers plus the sender's payment key hash.
// Script credentials are skipped. Returns undefined when nothing can be derived.
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
    mapError(req, new BackendError(`Action '${actionName}' requires role '${hsmConfig.requiresRole}'`, 403, ERROR_CODES.FORBIDDEN), actionName);
  }
}

/** The connected HSM signer. 503 when none is configured or connected: the request is valid, the server lacks the signer. */
function connectedHsm(req: Request, actionName: string): HsmSigner {
  const hsmSigner = getHsmSigner();
  if (!hsmSigner || !hsmSigner.isConnected()) {
    mapError(req, new BackendError('HSM is not configured or not connected', 503, ERROR_CODES.HSM_NOT_CONFIGURED, undefined, undefined, 'hsm'), actionName);
  }
  return hsmSigner;
}

/** A signed external transaction, ready to verify: its request, the full CBOR and the keys that must sign. */
interface ExternalSignature {
  signingRequest: { id: string; status: string; expiresAt: string; build_id?: string | null; unsignedTxCbor: string; txBodyHash: string };
  fullSignedTxCbor: string;
  requiredSigners: string[] | undefined;
}

// Loads the signing request, runs `gate` on it, checks that the build belongs to `address` when one
// is given, and completes a CIP-30 witness set into the full transaction.
async function prepareExternalSignature(
  req: Request,
  db: cds.Transaction,
  actionName: string,
  { signingRequestId, signedTxCbor, address }: { signingRequestId: string; signedTxCbor: string; address?: string },
  SigningRequests: unknown,
  TransactionBuilds: unknown,
  gate?: (signingRequest: ExternalSignature['signingRequest']) => void,
): Promise<ExternalSignature> {
  const signingRequest = await db.run(SELECT.one.from(SigningRequests as never).where({ id: signingRequestId })) as ExternalSignature['signingRequest'] | undefined;
  if (!signingRequest) rejectInvalid(req, actionName, 'Signing request not found', 'signingRequestId');
  gate?.(signingRequest);
  if (address && signingRequest.build_id) {
    await verifyBuildOwnership(req, db, signingRequest.build_id, address, TransactionBuilds, actionName);
  }
  // A CIP-30 wallet returns only the witness set; cardano-cli a full signed tx.
  const fullSignedTxCbor = toSignedTransaction(signingRequest.unsignedTxCbor, signedTxCbor);
  // Verification is bound to the keys that must witness this tx.
  const requiredSigners = await resolveRequiredSigners(db, signingRequest, TransactionBuilds);
  return { signingRequest, fullSignedTxCbor, requiredSigners };
}

/** What signing a build with the HSM produced: its new signing request, the signed CBOR and the check of it. */
interface HsmSigned {
  build: StoredBuild;
  signingRequestId: string;
  signedTxCbor: string;
  verificationResult: ReturnType<ReturnType<typeof getExternalSignerModule>['verifySignedTransaction']>;
  hsmKeyIdentifier: string;
}

// The change of an HSM build must go back to the HSM, or the remainder goes to whoever built it.
// The stored outputs mark the change, and each must equal the output of the unsigned body at its index.
async function assertChangeToHsm(req: Request, db: cds.Transaction, build: StoredBuild, hsmAddress: string, actionName: string): Promise<void> {
  const changeAddress = build.changeAddress ?? build.senderAddress;
  if (changeAddress !== hsmAddress) {
    rejectInvalid(req, actionName, `Build change address '${changeAddress}' is not the HSM address '${hsmAddress}'`, 'buildId');
  }
  const stored = await db.run(
    SELECT.from(TransactionBuildOutputs).columns('outputIndex', 'address', 'isChange').where({ build_id: build.id })
  ) as Array<{ outputIndex: number; address: string; isChange?: boolean | null }>;
  if (!stored.length) return;
  let body: Array<{ address: string }>;
  try {
    body = parseTransaction(build.unsignedTxCbor).outputs;
  } catch {
    return rejectInvalid(req, actionName, 'The unsigned transaction of the build cannot be read', 'buildId');
  }
  for (const output of stored) {
    if (body[output.outputIndex]?.address !== output.address) {
      rejectInvalid(req, actionName, `Stored output ${output.outputIndex} of the build does not match its transaction`, 'buildId');
    }
    if (output.isChange && output.address !== hsmAddress) {
      rejectInvalid(req, actionName, `Build change output ${output.outputIndex} goes to '${output.address}', not to the HSM address '${hsmAddress}'`, 'buildId');
    }
  }
}

// Signs a build with the HSM after checking that it spends from the HSM address and returns its
// change there. A signature that does not verify against the required signers rolls back.
async function signBuildWithHsm(
  req: Request,
  db: cds.Transaction,
  hsmSigner: HsmSigner,
  actionName: string,
  { buildId, address, message }: { buildId: string; address?: string; message: string },
  TransactionBuilds: unknown,
): Promise<HsmSigned> {
  const build = await verifyBuildOwnership(req, db, buildId, address, TransactionBuilds, actionName);
  const hsmAddress = hsmSigner.getAddress();
  if (build.senderAddress !== hsmAddress) {
    rejectInvalid(req, actionName, `Build sender '${build.senderAddress}' does not match HSM address '${hsmAddress}'`, 'buildId');
  }
  await assertChangeToHsm(req, db, build, hsmAddress, actionName);

  const signerModule = getExternalSignerModule();
  const signingPayload = signerModule.createSigningRequest(build.id, build.unsignedTxCbor, build.txBodyHash, build.network, message);
  const signingRequest = await getCardanoIndexer().persistSigningRequest(db, { buildId, signingPayload });

  const signedTxCbor = hsmSigner.signTransaction(build.unsignedTxCbor, build.txBodyHash);
  const requiredSigners = await resolveRequiredSigners(db, { unsignedTxCbor: build.unsignedTxCbor, build_id: build.id }, TransactionBuilds);
  const verificationResult = signerModule.verifySignedTransaction(signedTxCbor, build.txBodyHash, { requiredSigners });
  const hsmStatus = hsmSigner.getStatus();
  const hsmKeyIdentifier = hsmStatus.keyLabel || hsmStatus.keyId || 'unknown';

  if (!verificationResult.isValid) {
    logger.error({ signingRequestId: signingRequest.id, hsmKey: hsmKeyIdentifier }, 'HSM signature verification failed');
    rejectInvalid(req, actionName, 'HSM signature verification failed', 'signedTxCbor');
  }
  return { build, signingRequestId: signingRequest.id as string, signedTxCbor, verificationResult, hsmKeyIdentifier };
}

/** CardanoSignService handlers: external and HSM signing, verification, submission. */
module.exports = (srv: cds.Service) => {
  answerNumbersAsText(srv);
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


  // CreateSigningRequest: persist a signing request for a build (idempotent per pending build).
  srv.on('CreateSigningRequest', async (req: Request) => {
    logger.debug('CreateSigningRequest Action handler called');
    const { buildId , message } = req.data;

    const errors = validateTransactionInputs({ buildId }, ['buildId']);
    throwIfValidationErrors(req, 'CreateSigningRequest', errors);

    return handleRequest(req, async (db) => {
      const build = await db.run(SELECT.one.from(TransactionBuilds).where({ id: buildId }));
      if (!build) rejectInvalid(req, 'CreateSigningRequest', 'Build not found', 'buildId');

      // a pending request past its TTL is expired first, so it is never handed out again
      const now = new Date().toISOString();
      await db.run(UPDATE.entity(SigningRequests).set({ status: 'expired' }).where({ build_id: buildId, status: 'pending', expiresAt: { '<=': now } }));
      const existingRequest = await db.run(
        SELECT.one.from(SigningRequests).where({ build_id: buildId, status: 'pending', expiresAt: { '>': now } })
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

  // GetSigningRequest: by id; expires a pending request past its TTL on read.
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

  // VerifySignature: verify a signed tx or witness set against the request; persists the result.
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
      const { signingRequest, fullSignedTxCbor, requiredSigners } = await prepareExternalSignature(
        req, db, 'VerifySignature', { signingRequestId, signedTxCbor, address }, SigningRequests, TransactionBuilds);

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

  // SubmitVerifiedTransaction: verify and submit in one step.
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
        // the state of the request answers before the signed bytes are read
        const { signingRequest, fullSignedTxCbor, requiredSigners } = await prepareExternalSignature(
          req, db, 'SubmitVerifiedTransaction', { signingRequestId, signedTxCbor, address }, SigningRequests, TransactionBuilds, (request) => {
            if (request.expiresAt <= now) rejectInvalid(req, 'SubmitVerifiedTransaction', 'Signing request has expired', 'signingRequestId');
            if (!['pending', 'verified'].includes(request.status)) {
              rejectInvalid(req, 'SubmitVerifiedTransaction', `Signing request status is '${request.status}', expected 'pending' or 'verified'`, 'signingRequestId');
            }
            if (!request.build_id) rejectInvalid(req, 'SubmitVerifiedTransaction', 'Signing request has no associated build', 'signingRequestId');
          });

        // Throws on failure; bound to the keys that must witness this tx.
        const verificationResult = getExternalSignerModule().verifyOrThrow(fullSignedTxCbor, signingRequest.txBodyHash, { requiredSigners });
        // a build stored before every build had an expiry can still lack one
        const problem = sendProblem(fullSignedTxCbor, getCardanoClient().network);
        if (problem) rejectInvalid(req, 'SubmitVerifiedTransaction', problem, 'signingRequestId');

        // Atomic claim. The signed CBOR, the signer and the claim time go with it, so an
        // interrupted or unresolved submission can be resolved later.
        const claimed = await db.run(
          UPDATE.entity(SigningRequests)
            .set({ status: 'submitting', signedTxCbor: fullSignedTxCbor, signerType, signerInfo, signedAt: now })
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
        logger.info({ signingRequestId, txHash: prep.txHash }, 'Verified and claimed, submit deferred until after the caller commits');
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

  // VerifyDataSignature: stateless CIP-30 signData (COSE_Sign1) check for wallet login.
  // Public (@requires:'any') because the caller is not yet authenticated.
  srv.on('VerifyDataSignature', async (req: Request) => {
    logger.debug('VerifyDataSignature Action handler called');
    const { address, coseSignature, coseKey, expectedPayload } = req.data;

    if (!address) rejectMissing(req, 'VerifyDataSignature', 'address');
    if (!isValidBech32Address(address) && !isValidBech32StakeAddress(address)) {
      rejectInvalid(req, 'VerifyDataSignature', 'Invalid bech32 address format', 'address');
    }
    if (!coseSignature) rejectMissing(req, 'VerifyDataSignature', 'coseSignature');
    if (!coseKey) rejectMissing(req, 'VerifyDataSignature', 'coseKey');

    // Never throws: a bad signature is a 200 with valid:false + reason.
    return verifyDataSignature({ address, coseSignature, coseKey, expectedPayload });
  });

  // GetSigningRequestsByAddress: signing requests linked to an address.
  srv.on('GetSigningRequestsByAddress', async (req: Request) => {
    logger.debug('GetSigningRequestsByAddress Action handler called');
    const { address } = req.data;
    if (!address) rejectMissing(req, 'GetSigningRequestsByAddress', 'address');
    if (!isValidBech32Address(address)) rejectInvalid(req, 'GetSigningRequestsByAddress', 'Invalid bech32 address format', 'address');
    const { limit, skip } = pageOf(req.data, 1000);
    return handleRequest(req, (db) =>
      db.run(SELECT.from(AddressSigningRequests).where({ address_address: address }).orderBy('signingRequest_id').limit(limit, skip)));
  });

  // ---------------------------------------------------------------------------
  // HSM signing actions
  // ---------------------------------------------------------------------------

  // SignWithHsm: create a signing request, sign with the HSM, verify; returns the request.
  srv.on('SignWithHsm', async (req: Request) => {
    logger.debug('SignWithHsm Action handler called');
    enforceHsmRole(req, 'SignWithHsm');
    const { buildId, address } = req.data;

    const errors = validateTransactionInputs({ buildId }, ['buildId']);
    throwIfValidationErrors(req, 'SignWithHsm', errors);
    if (address && !isValidBech32Address(address)) rejectInvalid(req, 'SignWithHsm', 'Invalid bech32 address format', 'address');
    const hsmSigner = connectedHsm(req, 'SignWithHsm');

    return handleRequest(req, async (db) => {
      const signed = await signBuildWithHsm(req, db, hsmSigner, 'SignWithHsm', { buildId, address, message: 'HSM signing' }, TransactionBuilds);

      await getCardanoIndexer().persistSignatureVerification(db, {
        signingRequestId: signed.signingRequestId,
        signedTxCbor: signed.signedTxCbor,
        verificationResult: signed.verificationResult,
        signerType: 'hsm',
        signerInfo: `HSM key: ${signed.hsmKeyIdentifier}`,
      });
      // HSM audit field
      await db.run(UPDATE.entity(SigningRequests).set({ hsmKeyId: signed.hsmKeyIdentifier }).where({ id: signed.signingRequestId }));

      logger.info({ buildId, signingRequestId: signed.signingRequestId, hsmKey: signed.hsmKeyIdentifier }, 'Transaction signed with HSM');
      return db.run(SELECT.one.from(SigningRequests).where({ id: signed.signingRequestId }));
    });
  });

  // SignAndSubmitWithHsm: create a signing request, sign, verify and submit in one call.
  srv.on('SignAndSubmitWithHsm', async (req: Request) => {
    logger.debug('SignAndSubmitWithHsm Action handler called');
    enforceHsmRole(req, 'SignAndSubmitWithHsm');
    const { buildId, address } = req.data;
    const deferSubmit = req.data.deferSubmit === true;

    const errors = validateTransactionInputs({ buildId }, ['buildId']);
    throwIfValidationErrors(req, 'SignAndSubmitWithHsm', errors);
    if (address && !isValidBech32Address(address)) rejectInvalid(req, 'SignAndSubmitWithHsm', 'Invalid bech32 address format', 'address');
    const hsmSigner = connectedHsm(req, 'SignAndSubmitWithHsm');

    try {
      // Phase 1 (committed): sign, verify and claim as 'submitting' with the signed CBOR, so an
      // interrupted or unresolved submission can be resolved later. A failure rolls the request back.
      const phase1 = async (db: cds.Transaction) => {
        const signed = await signBuildWithHsm(req, db, hsmSigner, 'SignAndSubmitWithHsm', { buildId, address, message: 'HSM signing + submit' }, TransactionBuilds);
        // a build stored before every build had an expiry can still lack one
        const problem = sendProblem(signed.signedTxCbor, getCardanoClient().network);
        if (problem) rejectInvalid(req, 'SignAndSubmitWithHsm', problem, 'buildId');
        await db.run(UPDATE.entity(SigningRequests).set({
          status: 'submitting',
          hsmKeyId: signed.hsmKeyIdentifier,
          signedTxCbor: signed.signedTxCbor,
          signerType: 'hsm',
          signerInfo: `HSM key: ${signed.hsmKeyIdentifier}`,
          signedAt: new Date().toISOString(),
        }).where({ id: signed.signingRequestId }));
        return signed;
      };

      const finalizeParams = (prep: HsmSigned) => ({
        signingRequestId: prep.signingRequestId,
        buildId,
        fullSignedTxCbor: prep.signedTxCbor,
        txHash: prep.build.txBodyHash,
        verificationResult: prep.verificationResult,
        signerType: 'hsm',
        signerInfo: `HSM key: ${prep.hsmKeyIdentifier}`,
      });

      if (deferSubmit) {
        // Phase 1 on the caller's transaction; submit runs after its commit.
        const prep = await phase1(cds.tx(req) as cds.Transaction);
        scheduleDeferredSubmit(req, SigningRequests, finalizeParams(prep));
        logger.info({ signingRequestId: prep.signingRequestId, txHash: prep.build.txBodyHash }, 'HSM-signed and claimed, submit deferred until after the caller commits');
        return {
          id: null,
          build_id: buildId,
          txHash: prep.build.txBodyHash,
          signedTxCbor: prep.signedTxCbor,
          status: 'pending',
          submittedAt: null,
        };
      }

      const prep = await detachedTx('HSM sign + claim signing request', phase1);
      logger.info({ signingRequestId: prep.signingRequestId, witnessCount: prep.verificationResult.witnessCount, hsmKey: prep.hsmKeyIdentifier }, 'HSM signature verified, proceeding with submission');

      // Phases 2+3: submit outside any DB tx, then finalize; hsmKeyId is set again because the
      // generic finalizer does not write it
      const submissionRecord = await submitAndFinalize(
        SigningRequests,
        finalizeParams(prep),
        (db) => db.run(UPDATE.entity(SigningRequests).set({ hsmKeyId: prep.hsmKeyIdentifier }).where({ id: prep.signingRequestId })).then(() => undefined)
      );

      logger.info({ signingRequestId: prep.signingRequestId, txHash: prep.build.txBodyHash }, 'HSM-signed transaction submitted and all records updated');
      return submissionRecord;
    } catch (e: unknown) {
      logger.error({ err: e }, 'SignAndSubmitWithHsm error');
      return mapError(req, e, 'SignAndSubmitWithHsm');
    }
  });

  // ResolveSigningRequest (Admin): settles an unresolved request as an operator read it on the chain.
  // Confirmed writes the submission record a submit writes; failed ends the request.
  srv.on('ResolveSigningRequest', async (req: Request) => {
    const { signingRequestId, outcome, txHash, note } = req.data as { signingRequestId: string; outcome: string; txHash?: string | null; note?: string | null };
    return handleRequest(req, async (db) => {
      // read and ask the chain before the request takes its connection
      const request = await readOutside(db, (d) => d.run(SELECT.one.from(SigningRequests).where({ id: signingRequestId }))) as {
        id: string; status: string; build_id?: string | null; txBodyHash: string; signedTxCbor?: string | null; signerType?: string | null; signerInfo?: string | null;
      } | undefined;
      if (!request) throw new NotFoundError(`Signing request '${signingRequestId}'`);
      if (request.status !== 'unresolved') {
        rejectInvalid(req, 'ResolveSigningRequest', `Signing request status is '${request.status}': only an unresolved request can be resolved`, 'signingRequestId');
      }
      checkResolvedTxHash(req, 'ResolveSigningRequest', txHash, request.txBodyHash);
      const resolved = outcome === 'confirmed' ? 'confirmed' : 'failed';
      await refuseFailedWhileItCanLand('ResolveSigningRequest', resolved, request.signedTxCbor, getCardanoClient());
      const resolution = resolutionNote(resolved, req.user?.id, note);
      const won = await db.run(UPDATE.entity(SigningRequests)
        .set(resolved === 'confirmed' ? { status: 'submitted', errorMessage: null, resolution } : { status: 'failed', resolution })
        .where({ id: signingRequestId, status: 'unresolved' }));
      if (won === 0) throw resolvedConcurrently('ResolveSigningRequest');
      if (resolved === 'confirmed') {
        if (!request.signedTxCbor || !request.build_id) {
          rejectInvalid(req, 'ResolveSigningRequest', 'Signing request has no stored signed transaction or build', 'signingRequestId');
        }
        // the witness metadata the submission record keeps, from the stored bytes
        const verificationResult = getExternalSignerModule().verifyOrThrow(request.signedTxCbor, request.txBodyHash);
        await getCardanoIndexer().indexVerifiedTransactionSubmission(db as never, {
          signingRequestId, buildId: request.build_id, fullSignedTxCbor: request.signedTxCbor, txHash: request.txBodyHash,
          verificationResult, signerType: request.signerType ?? undefined, signerInfo: request.signerInfo ?? undefined,
        });
      }
      logger.warn({ signingRequestId, outcome: resolved, by: req.user?.id }, 'Unresolved signing request resolved by an operator');
      return db.run(SELECT.one.from(SigningRequests).where({ id: signingRequestId }));
    });
  });

  // GetHsmStatus: connection status and key info; null fields when no HSM is configured.
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