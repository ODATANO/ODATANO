import cds, { Request } from '@sap/cds';
import { handleRequest } from './utils/backend-request-handler';
import { rejectInvalid, throwIfValidationErrors, rejectMissing, NotFoundError } from './utils/errors';
import { checkResolvedTxHash, refuseFailedWhileItCanLand, resolutionNote, resolvedConcurrently } from './utils/resolution';
import { validateTransactionInputs, isValidBech32Address, validatePlutusJson } from './utils/validators';
import { getTxHashFromCbor, getLovelace, isCollateralCandidate, applyScriptParameters } from './utils/tx-build-helper';
import { computeCip14Fingerprint, scriptHashToEnterpriseAddress, mapError, decodeShelleyAddress } from './utils/mappers';
import { getCardanoIndexer, getCardanoClient } from './server';
import type { Network } from './blockchain/cardano-client';
import { toSignedTransaction } from './utils/signing-helper';
import { detachedTx, readOutside } from './utils/tx-utils';
import { pageOf } from './utils/paging';
import { submitRecorded } from './blockchain/signing/submission-finalizer';
import { sendProblem } from './blockchain/signing/landing-proof';
import { SubmitTransaction } from '#cds-models/CardanoTransactionService';
import { POLICY_ID_HEX_LENGTH, COLLATERAL_LOVELACE, FEE_BUFFER_LOVELACE } from './utils/const';
import { answerNumbersAsText } from './utils/result-numbers';
import type { JSONValue, TxBuildPlutusRequest, ScriptInput, WithdrawalInput, CertificateInput } from './utils/types';
import { parseUtxoRefArray, parseRequiredSigners, parseScriptInputs, parseOutputList, parsePolicyMintActions, parseWithdrawals, parseCertificates } from './utils/tx-request-parsers';
import {
  prepareMetadataRequest, prepareMintRequest, prepareMultiAssetRequest, preparePlutusSpendRequest, prepareSimpleAdaRequest,
  scriptHashOf, type BuildRequestError, type Prepared, type PreparedBuild,
} from './utils/build-request';

const { SELECT, UPDATE } = cds.ql;

/** Blocks on top of a submitted transaction, its own included, before CheckSubmissionStatus confirms it. */
const SUBMISSION_CONFIRMATION_DEPTH = 3;

const logger = cds.log('CardanoTxService');

/** The network, read only where a script address is derived. */
const networkOf = (): Network => getCardanoClient().network;

/** Answers a request the shared preparation refused: a missing field, or the reason and its field. */
function refuse(req: Request, action: string, refusal: BuildRequestError): never {
  if (refusal.missing && refusal.field) return rejectMissing(req, action, refusal.field);
  return rejectInvalid(req, action, refusal.error, refusal.field);
}

/** The prepared request, or the answer: a refusal, or what a server that is not ready says. */
function prepareOrAnswer<T>(req: Request, action: string, prepare: () => Prepared<T>): PreparedBuild<T> {
  let result: Prepared<T>;
  try {
    result = prepare();
  } catch (err: unknown) {
    return mapError(req, err, action);
  }
  if ('error' in result) return refuse(req, action, result);
  return result;
}


/** CardanoTransactionService handlers: transaction building, submission and script helpers. */
module.exports = (srv: cds.Service) => {
  answerNumbersAsText(srv);
  logger.debug('Module loaded - registering handlers');

  const {
    TransactionBuilds,
    TransactionBuildRedeemers,
    TransactionSubmissions,
    AddressTransactionBuilds
  } = require('#cds-models/CardanoTransactionService');

  // BuildSimpleAdaTransaction: ADA (optionally with assets / datum) to one recipient or a script.
  srv.on('BuildSimpleAdaTransaction', async (req: Request) => {
    const action = 'BuildSimpleAdaTransaction';
    const { request, scriptHash, scriptAddress } = prepareOrAnswer(req, action, () => prepareSimpleAdaRequest(req.data, networkOf));

    return handleRequest(req, async (db) => {
      logger.debug({ senderAddress: request.senderAddress, recipientAddress: request.recipientAddress, lockOnScript: !!scriptAddress }, 'Building simple ADA transaction');
      const buildResult = await getCardanoIndexer().indexSimpleBuildResult(db, request);

      // the derived script address and hash go on the build record
      if (scriptHash && scriptAddress && buildResult.id) {
        buildResult.scriptHash = scriptHash;
        buildResult.scriptAddress = scriptAddress;
        await db.run(UPDATE.entity(TransactionBuilds).set({ scriptHash, scriptAddress }).where({ id: buildResult.id }));
      }
      return buildResult;
    });
  });

  // BuildTransactionWithMetadata: ADA transfer with auxiliary metadata.
  srv.on('BuildTransactionWithMetadata', async (req: Request) => {
    const prepared = prepareMetadataRequest(req.data);
    if ('error' in prepared) return refuse(req, 'BuildTransactionWithMetadata', prepared);

    return handleRequest(req, async (db) => {
      logger.debug({ senderAddress: prepared.request.senderAddress, recipientAddress: prepared.request.recipientAddress }, 'Building transaction with metadata');
      return getCardanoIndexer().indexMetadataBuildResult(db, prepared.request);
    });
  });

  // BuildMultiAssetTransaction: ADA plus native assets to one recipient.
  srv.on('BuildMultiAssetTransaction', async (req: Request) => {
    const prepared = prepareMultiAssetRequest(req.data);
    if ('error' in prepared) return refuse(req, 'BuildMultiAssetTransaction', prepared);

    return handleRequest(req, async (db) => {
      logger.debug({ senderAddress: prepared.request.senderAddress, assets: prepared.request.assets?.length ?? 0 }, 'Building multi-asset transaction');
      const result = await getCardanoIndexer().indexMultiAssetBuildResult(db, prepared.request);
      logger.debug({ id: result.id, fee: result.fee, size: result.size }, 'Multi-asset transaction build result');
      return result;
    });
  });

  // BuildMintTransaction: mint/burn under one or more Plutus policies.
  srv.on('BuildMintTransaction', async (req: Request) => {
    const { request, scriptAddress } = prepareOrAnswer(req, 'BuildMintTransaction', () => prepareMintRequest(req.data, networkOf));
    const mintActions = request.mintActions ?? [];

    return handleRequest(req, async (db) => {
      logger.debug({ senderAddress: request.senderAddress, mintActions: mintActions.length }, 'Building minting transaction');
      const buildResult = await getCardanoIndexer().indexMintBuildResult(db, request);

      // CIP-14 fingerprint of the first minted asset, and the script address of lockOnScript
      if (buildResult.scriptHash) {
        const updates: Record<string, string> = {};
        if (mintActions.length > 0) {
          // the policy id comes from the unit: a per-action policy may differ from the top-level script
          const firstUnit = mintActions[0].assetUnit;
          buildResult.fingerprint = computeCip14Fingerprint(firstUnit.slice(0, POLICY_ID_HEX_LENGTH), firstUnit.slice(POLICY_ID_HEX_LENGTH));
          updates.fingerprint = buildResult.fingerprint;
        }
        if (scriptAddress) {
          buildResult.scriptAddress = scriptHashToEnterpriseAddress(buildResult.scriptHash, networkOf());
          updates.scriptAddress = buildResult.scriptAddress;
        }
        if (buildResult.id && Object.keys(updates).length > 0) {
          await db.run(UPDATE.entity(TransactionBuilds).set(updates).where({ id: buildResult.id }));
        }
      }
      return buildResult;
    });
  });

  // BuildPlutusSpendTransaction: consume a UTxO at a script address, optionally minting too.
  srv.on('BuildPlutusSpendTransaction', async (req: Request) => {
    const { request, scriptAddress } = prepareOrAnswer(req, 'BuildPlutusSpendTransaction', () => preparePlutusSpendRequest(req.data, networkOf));

    return handleRequest(req, async (db) => {
      logger.debug({ senderAddress: request.senderAddress, scriptUtxo: request.plutusScriptExecution.scriptUtxo }, 'Building Plutus spending transaction');
      const buildResult = await getCardanoIndexer().indexPlutusSpendBuildResult(db, request);

      // lockOnScript: the derived script address goes on the build record
      if (scriptAddress && buildResult.scriptHash && buildResult.id) {
        buildResult.scriptAddress = scriptHashToEnterpriseAddress(buildResult.scriptHash, networkOf());
        await db.run(UPDATE.entity(TransactionBuilds).set({ scriptAddress: buildResult.scriptAddress }).where({ id: buildResult.id }));
      }
      return buildResult;
    });
  });

  // BuildPlutusTransaction: several script UTxOs in one transaction, each with its own redeemer.
  srv.on('BuildPlutusTransaction', async (req: Request) => {
    const { senderAddress, changeAddress, scriptInputsJson, outputsJson, referenceInputsJson, forceInputsJson, protectInputsJson, withdrawalsJson, certificatesJson, requiredSignersJson, mintActionsJson, validityStartMs, validityEndMs } = req.data;
    const action = 'BuildPlutusTransaction';

    const errors = validateTransactionInputs({ senderAddress, validityStartMs, validityEndMs }, ['senderAddress']);
    throwIfValidationErrors(req, action, errors);
    if (changeAddress && !isValidBech32Address(changeAddress)) {
      return rejectInvalid(req, action, 'Invalid changeAddress format', 'changeAddress');
    }

    const scriptInputsResult = parseScriptInputs(scriptInputsJson);
    if (scriptInputsResult.error) return rejectInvalid(req, action, scriptInputsResult.error, 'scriptInputsJson');
    if (!outputsJson) return rejectMissing(req, action, 'outputsJson');
    const outputsResult = parseOutputList(outputsJson, 'outputsJson');
    if (outputsResult.error) return rejectInvalid(req, action, outputsResult.error, 'outputsJson');
    if (!outputsResult.parsed) return rejectInvalid(req, action, 'outputsJson must list at least one output', 'outputsJson');
    const refInputsResult = parseUtxoRefArray(referenceInputsJson, 'referenceInputsJson');
    if (refInputsResult.error) return rejectInvalid(req, action, refInputsResult.error, 'referenceInputsJson');
    const forceInputsResult = parseUtxoRefArray(forceInputsJson, 'forceInputsJson');
    if (forceInputsResult.error) return rejectInvalid(req, action, forceInputsResult.error, 'forceInputsJson');
    const protectInputsResult = parseUtxoRefArray(protectInputsJson, 'protectInputsJson');
    if (protectInputsResult.error) return rejectInvalid(req, action, protectInputsResult.error, 'protectInputsJson');
    const withdrawalsResult = parseWithdrawals(withdrawalsJson);
    if (withdrawalsResult.error) return rejectInvalid(req, action, withdrawalsResult.error, 'withdrawalsJson');
    const certificatesResult = parseCertificates(certificatesJson);
    if (certificatesResult.error) return rejectInvalid(req, action, certificatesResult.error, 'certificatesJson');
    const signersResult = parseRequiredSigners(requiredSignersJson);
    if (signersResult.error) return rejectInvalid(req, action, signersResult.error, 'requiredSignersJson');
    const mintResult = parsePolicyMintActions(mintActionsJson);
    if (mintResult.error) return rejectInvalid(req, action, mintResult.error, 'mintActionsJson');

    // Script params are applied here, so the builder sees the final validators
    const scriptInputs: ScriptInput[] = [];
    for (const [i, si] of scriptInputsResult.parsed!.entries()) {
      let validatorScript = si.validatorScript;
      if (validatorScript && si.scriptParams) {
        try {
          validatorScript = applyScriptParameters(validatorScript, si.scriptParams);
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          return rejectInvalid(req, action, `scriptInputs[${i}]: failed to apply script parameters: ${errMsg}`, 'scriptInputsJson');
        }
      }
      scriptInputs.push({
        txHash: si.txHash,
        outputIndex: si.outputIndex,
        ...(validatorScript ? { validatorScript } : { referenceScript: si.referenceScript }),
        redeemer: si.redeemer,
        ...(si.redeemerCbor ? { redeemerCbor: si.redeemerCbor } : {}),
        ...(si.datum !== undefined ? { datum: si.datum } : {}),
        ...(si.datumCbor ? { datumCbor: si.datumCbor } : {}),
      });
    }

    // Same for the staking scripts of withdrawals and certificates
    const stakingWitness = (w: { stakingScript?: string; scriptParams?: JSONValue[]; referenceScript?: { txHash: string; outputIndex: number }; redeemer?: JSONValue; redeemerCbor?: string }, at: string, field: string) => {
      let stakingScript = w.stakingScript;
      if (stakingScript && w.scriptParams) {
        try {
          stakingScript = applyScriptParameters(stakingScript, w.scriptParams);
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          return { error: rejectInvalid(req, action, `${at}: failed to apply script parameters: ${errMsg}`, field) };
        }
      }
      return {
        parsed: {
          ...(stakingScript ? { stakingScript } : {}),
          ...(w.referenceScript ? { referenceScript: w.referenceScript } : {}),
          ...(w.redeemer !== undefined ? { redeemer: w.redeemer } : {}),
          ...(w.redeemerCbor ? { redeemerCbor: w.redeemerCbor } : {}),
        },
      };
    };
    const withdrawals: WithdrawalInput[] = [];
    for (const [i, w] of (withdrawalsResult.parsed ?? []).entries()) {
      const witness = stakingWitness(w, `withdrawals[${i}]`, 'withdrawalsJson');
      if ('error' in witness) return witness.error;
      withdrawals.push({ rewardAddress: w.rewardAddress, lovelace: w.lovelace, ...witness.parsed });
    }
    const certificates: CertificateInput[] = [];
    for (const [i, c] of (certificatesResult.parsed ?? []).entries()) {
      const witness = stakingWitness(c, `certificates[${i}]`, 'certificatesJson');
      if ('error' in witness) return witness.error;
      certificates.push({ type: c.type, stakeAddress: c.stakeAddress, ...(c.deposit ? { deposit: c.deposit } : {}), ...witness.parsed });
    }

    const buildReq: TxBuildPlutusRequest = {
      network: getCardanoClient().network,
      senderAddress,
      ...(changeAddress ? { changeAddress } : {}),
      scriptInputs,
      outputs: outputsResult.parsed,
      referenceInputs: refInputsResult.parsed,
      forceInputs: forceInputsResult.parsed,
      protectInputs: protectInputsResult.parsed,
      ...(withdrawals.length > 0 ? { withdrawals } : {}),
      ...(certificates.length > 0 ? { certificates } : {}),
      requiredSigners: signersResult.parsed,
      mintActions: mintResult.parsed,
      validityStartMs,
      validityEndMs,
    };
    return handleRequest(req, async (db) => {
      logger.debug({ senderAddress, scriptInputs: scriptInputs.length, outputs: buildReq.outputs.length }, 'Building multi-script Plutus transaction');
      const build = await getCardanoIndexer().indexPlutusBuildResult(db, buildReq);
      // the answer carries the execution units of every redeemer, as stored with the build
      const redeemers = await db.run(
        SELECT.from(TransactionBuildRedeemers).columns('tag', 'redeemerIndex', 'mem', 'steps').where({ build_id: build.id }).orderBy('tag', 'redeemerIndex')
      );
      return { ...build, redeemers };
    });
  });

  // GetBuildDetails: an existing transaction build by id.
  srv.on('GetBuildDetails', async (req: Request) => {
    const { buildId } = req.data;

    const errors = validateTransactionInputs({ buildId }, ['buildId']);
    throwIfValidationErrors(req, 'GetBuildDetails', errors);

    return handleRequest(req, async (db) => {
      const existing = await db.run(SELECT.one.from(TransactionBuilds).where({ id: buildId }));
      if (!existing) throw new NotFoundError(`Build '${buildId}'`);
      return existing;
    });
  });

  // SetCollateral: collateral is available when the builders would find it: an ADA-only UTxO of
  // >= 5 ADA without a reference script, plus another UTxO to fund with; otherwise a self-send creates one.
  srv.on('SetCollateral', async (req: Request) => {
    const { address } = req.data;

    if (!address) return rejectMissing(req, 'SetCollateral', 'address');
    if (!isValidBech32Address(address)) {
      return rejectInvalid(req, 'SetCollateral', 'Invalid Bech32 address format', 'address');
    }

    return handleRequest(req, async (db) => {
      // Inside handleRequest use rejectInvalid (typed BackendError 400), not req.reject,
      // so mapError preserves the status.
      const ledger = await getCardanoIndexer().resolveAddressUtxos(db, address);
      const utxos = getCardanoClient().pendingSpends?.apply(address, ledger) ?? ledger;

      if (utxos.length === 0) {
        return rejectInvalid(req, 'SetCollateral', 'No UTxOs found at address', 'address');
      }

      const qualifyingUtxos = utxos.filter(u => isCollateralCandidate(u) && getLovelace(u) >= COLLATERAL_LOVELACE);

      if (qualifyingUtxos.length >= 1 && utxos.length >= 2) {
        return {
          id: cds.utils.uuid(),
          network: getCardanoClient().network,
          senderAddress: address,
          collateralAvailable: true,
        };
      }

      const totalLovelace = utxos.reduce((sum, u) => sum + getLovelace(u), 0n);

      if (totalLovelace < COLLATERAL_LOVELACE + FEE_BUFFER_LOVELACE) {
        return rejectInvalid(
          req,
          'SetCollateral',
          `Insufficient funds: need at least ${Number(COLLATERAL_LOVELACE + FEE_BUFFER_LOVELACE) / 1_000_000} ADA, have ${Number(totalLovelace) / 1_000_000} ADA`,
          'address',
        );
      }

      logger.debug({ address, existingQualifying: qualifyingUtxos.length }, 'Building collateral setup transaction');
      const result = await getCardanoIndexer().indexSimpleBuildResult(db, {
        network: getCardanoClient().network,
        senderAddress: address,
        recipientAddress: address,
        lovelaceAmount: COLLATERAL_LOVELACE.toString(),
        changeAddress: address,
      });
      return { ...result, collateralAvailable: false };
    });
  });

  // SubmitTransaction: submit the signed CBOR of a previous build.
  srv.on(SubmitTransaction, async (req) => {
    logger.debug('SubmitTransaction Action handler called');
    const { buildId, signedTxCbor: signedInput } = req.data;
    if (!buildId) return rejectMissing(req, 'SubmitTransaction', 'buildId');
    if (!signedInput) return rejectMissing(req, 'SubmitTransaction', 'signedTxCbor');

    const errors = validateTransactionInputs({ buildId, signedTxCbor: signedInput }, ['buildId', 'signedTxCbor']);
    throwIfValidationErrors(req, 'SubmitTransaction', errors);

    try {
      const build = await detachedTx('load build for submit', (db) =>
        db.run(SELECT.one.from(TransactionBuilds).columns('unsignedTxCbor', 'txBodyHash').where({ id: buildId }))
      ) as { unsignedTxCbor: string; txBodyHash: string } | undefined;
      if (!build) throw new NotFoundError(`Build '${buildId}'`);

      // A CIP-30 wallet returns only the witness set; cardano-cli a full signed tx.
      const signedTxCbor = toSignedTransaction(build.unsignedTxCbor, signedInput);

      // The signed CBOR must belong to this build (audit-trail integrity)
      const signedTxHash = getTxHashFromCbor(signedTxCbor);
      if (signedTxHash !== build.txBodyHash) {
        rejectInvalid(req, 'SubmitTransaction', `signedTxCbor hash '${signedTxHash}' does not match build txBodyHash '${build.txBodyHash}'`, 'signedTxCbor');
      }
      // the body hash leaves isValid out, and a build stored by an earlier version may have no expiry
      const problem = sendProblem(signedTxCbor, getCardanoClient().network);
      if (problem) rejectInvalid(req, 'SubmitTransaction', problem, 'signedTxCbor');

      return await submitRecorded({ signedTxCbor, txHash: build.txBodyHash, buildId });
    } catch (e: unknown) {
      return mapError(req, e, 'SubmitTransaction');
    }
  });

  // SubmitSignedTransaction: submit externally built signed CBOR (no prior build).
  srv.on('SubmitSignedTransaction', async (req: Request) => {
    logger.debug('SubmitSignedTransaction Action handler called');
    const { signedTxCbor, network } = req.data;

    const errors = validateTransactionInputs({ signedTxCbor }, ['signedTxCbor']);
    throwIfValidationErrors(req, 'SubmitSignedTransaction', errors);

    try {
      // A caller targeting the wrong deployment gets a clear 400
      const configuredNetwork = getCardanoClient().network;
      if (network && network !== configuredNetwork) {
        rejectInvalid(req, 'SubmitSignedTransaction', `network '${network}' does not match this deployment's network '${configuredNetwork}'`, 'network');
      }
      // without an expiry within the cap an unanswered submit could stay undecided; isValid false only spends collateral
      const expiry = sendProblem(signedTxCbor, configuredNetwork);
      if (expiry) rejectInvalid(req, 'SubmitSignedTransaction', expiry, 'signedTxCbor');
      return await submitRecorded({ signedTxCbor, txHash: getTxHashFromCbor(signedTxCbor), buildId: null });
    } catch (e: unknown) {
      return mapError(req, e, 'SubmitSignedTransaction');
    }
  });

  // CheckSubmissionStatus: bound action; the @from: [#submitted] state gate is enforced by CAP.
  srv.on('CheckSubmissionStatus', async (req: Request) => {
    logger.debug('CheckSubmissionStatus Action handler called');
    const { id: submissionId } = req.params[0] as { id: string };

    return handleRequest(req, async (db) => {
      // read outside the request transaction: the confirmation lookup below may ask a backend
      const submission = await readOutside(db, (d) => d.run(SELECT.one.from(TransactionSubmissions).where({ id: submissionId })));
      if (!submission) throw new NotFoundError(`Submission '${submissionId}'`);

      // a block this deep is not rolled back in practice; a status set here is never reverted
      const { confirmations } = await getCardanoIndexer().resolveTransactionConfirmations(db, submission.txHash);
      if (confirmations >= SUBMISSION_CONFIRMATION_DEPTH) {
        await db.run(UPDATE.entity(TransactionSubmissions).set({ status: 'confirmed' }).where({ id: submissionId }));
        submission.status = 'confirmed';
        logger.info({ submissionId, txHash: submission.txHash, confirmations }, 'Transaction confirmed on chain');
      }

      return submission;
    });
  });

  // ResolveSubmission (Admin): settles an unresolved submission as an operator read it on the chain.
  // Confirmed makes it submitted, so CheckSubmissionStatus counts its depth; failed ends it.
  srv.on('ResolveSubmission', async (req: Request) => {
    const { submissionId, outcome, txHash, note } = req.data as { submissionId: string; outcome: string; txHash?: string | null; note?: string | null };
    return handleRequest(req, async (db) => {
      // read and ask the chain before the request takes its connection
      const submission = await readOutside(db, (d) => d.run(SELECT.one.from(TransactionSubmissions).where({ id: submissionId })));
      if (!submission) throw new NotFoundError(`Submission '${submissionId}'`);
      if (submission.status !== 'unresolved') {
        rejectInvalid(req, 'ResolveSubmission', `Submission status is '${submission.status}': only an unresolved submission can be resolved`, 'submissionId');
      }
      checkResolvedTxHash(req, 'ResolveSubmission', txHash, submission.txHash);
      const resolved = outcome === 'confirmed' ? 'confirmed' : 'failed';
      await refuseFailedWhileItCanLand('ResolveSubmission', resolved, submission.signedTxCbor, getCardanoClient());
      const won = await db.run(UPDATE.entity(TransactionSubmissions)
        .set({ status: resolved === 'confirmed' ? 'submitted' : 'failed', resolution: resolutionNote(resolved, req.user?.id, note) })
        .where({ id: submissionId, status: 'unresolved' }));
      if (won === 0) throw resolvedConcurrently('ResolveSubmission');
      logger.warn({ submissionId, outcome: resolved, by: req.user?.id }, 'Unresolved submission resolved by an operator');
      return db.run(SELECT.one.from(TransactionSubmissions).where({ id: submissionId }));
    });
  });

  // GetTransactionBuildsByAddress: address ↔ build associations.
  srv.on('GetTransactionBuildsByAddress', async (req: Request) => {
    logger.debug('GetTransactionBuildsByAddress Action handler called');
    const { address } = req.data;
    if (!address) return rejectMissing(req, 'GetTransactionBuildsByAddress', 'address');
    if (!isValidBech32Address(address)) return rejectInvalid(req, 'GetTransactionBuildsByAddress', 'Invalid bech32 address format', 'address');
    const { limit, skip } = pageOf(req.data, 1000);
    return handleRequest(req, (db) =>
      db.run(SELECT.from(AddressTransactionBuilds).where({ address_address: address }).orderBy('txBuild_id').limit(limit, skip)));
  });

  // DeriveScriptAddress: enterprise address + hash of a validator, optionally parameterized.
  srv.on('DeriveScriptAddress', async (req: Request) => {
    const { validatorScript, scriptParamsJson, network } = req.data;

    if (!validatorScript) return rejectMissing(req, 'DeriveScriptAddress', 'validatorScript');
    if (typeof validatorScript !== 'string' || !/^[0-9a-fA-F]+$/.test(validatorScript) || validatorScript.length % 2 !== 0) {
      return rejectInvalid(req, 'DeriveScriptAddress', 'validatorScript must be an even-length hex string', 'validatorScript');
    }

    let scriptParams: JSONValue[] | undefined;
    if (scriptParamsJson) {
      const jsonResult = validatePlutusJson(scriptParamsJson, 'scriptParamsJson');
      if (!jsonResult.valid) return rejectInvalid(req, 'DeriveScriptAddress', jsonResult.error!, 'scriptParamsJson');
      if (!Array.isArray(jsonResult.parsed)) {
        return rejectInvalid(req, 'DeriveScriptAddress', 'scriptParamsJson must be a JSON array', 'scriptParamsJson');
      }
      scriptParams = jsonResult.parsed as JSONValue[];
    }

    return handleRequest(req, async () => {
      // Resolved outside the CBOR try/catch so an uninitialized client stays a 503, not a 400.
      const targetNetwork: Network = network ?? getCardanoClient().network;

      try {
        const finalScript = scriptParams && scriptParams.length > 0
          ? applyScriptParameters(validatorScript, scriptParams)
          : validatorScript;
        const scriptHash = scriptHashOf(finalScript);
        const scriptAddress = scriptHashToEnterpriseAddress(scriptHash, targetNetwork);
        return { scriptAddress, scriptHash };
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return rejectInvalid(req, 'DeriveScriptAddress', `Failed to derive script address: ${errMsg}`, 'validatorScript');
      }
    });
  });

  // ExtractPaymentKeyHash: 28-byte payment credential of a bech32 address; pure local decoding.
  srv.on('ExtractPaymentKeyHash', async (req: Request) => {
    const { address } = req.data;

    if (!address) return rejectMissing(req, 'ExtractPaymentKeyHash', 'address');
    if (!isValidBech32Address(address)) {
      return rejectInvalid(req, 'ExtractPaymentKeyHash', 'Invalid bech32 address format', 'address');
    }

    const decoded = decodeShelleyAddress(address);
    if (!decoded.paymentCredential) {
      return rejectInvalid(req, 'ExtractPaymentKeyHash', 'Address carries no payment credential', 'address');
    }
    if (decoded.isScript) {
      return rejectInvalid(req, 'ExtractPaymentKeyHash', 'Address has a script payment credential, not a key hash', 'address');
    }
    return { paymentKeyHash: decoded.paymentCredential };
  });

};