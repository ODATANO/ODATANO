import cds from '@sap/cds';
import type { CardanoClient } from './cardano-client';
import type { UTxO } from '../utils/types';
import type { TxBuildRequest, TxBuildMintRequest, TxBuildPlutusSpendRequest, TxBuildPlutusRequest, TxBuildContext, TxBuildResult, LedgerProtocolParameters } from '../utils/types';
import { BuildooorTxBuilder } from './transaction-building/buildooor-tx';
import type { CardanoTxBuilder } from './transaction-building/cardano-tx';
import { LedgerProtocolParameter } from '#cds-models/CardanoODataService';
import { InsufficientFundsError, TransactionValidationError } from '../utils/errors';

const logger = cds.log('CardanoTransactionBuilder');

/** High-level transaction builder delegating to the Buildooor `CardanoTxBuilder`. */
export class CardanoTransactionBuilder {
    private client: CardanoClient;
    private txBuilder: CardanoTxBuilder | undefined;
    private initialized = false;

    /** @param client UTxO source for coin selection */
    constructor(client: CardanoClient) {
        this.client = client;
        logger.debug('CardanoTransactionBuilder instance created');
    }

    /** Unspent outputs of an address from local data (the crawled UTxO set); null = it cannot answer. */
    private addressUtxoSource: ((address: string) => Promise<UTxO[] | null>) | null = null;

    /** Read sender UTxOs from `source` first; the node's address query is the fallback. */
    setAddressUtxoSource(source: (address: string) => Promise<UTxO[] | null>): void {
        this.addressUtxoSource = source;
    }

    /** @param protocolParams optional; fetched from the backend when omitted */
    async init(protocolParams?: LedgerProtocolParameters): Promise<void> {
        if (this.initialized && this.txBuilder) return;
        // Buildooor is the sole transaction builder.
        this.txBuilder = new BuildooorTxBuilder();
        await this.txBuilder.init(this.client, protocolParams);
        this.initialized = true;
        logger.debug(`Initialized with builder: ${this.txBuilder.name}`);
    }

    /** Lazily initialize and return the builder. */
    private async ensureInitialized(): Promise<CardanoTxBuilder> {
        if (!this.initialized || !this.txBuilder) {
            await this.init();
        }
        return this.txBuilder!;
    }

    /** Reset the builder (testing). */
    reset(): void {
        this.txBuilder = undefined;
        this.initialized = false;
        logger.debug(`Builder reset`);
    }

    /** Set the builder directly (testing). */
    setBuilder(builder: CardanoTxBuilder): void {
        this.txBuilder = builder;
        this.initialized = true;
    }

    /** Build a simple ADA transfer transaction. */
    async buildSimpleAdaTransaction(req: TxBuildRequest, protocolParameters: LedgerProtocolParameter): Promise<TxBuildResult> {
        const builder = await this.ensureInitialized();

        const senderUtxos = await this._fetchUtxosForAddress(req.senderAddress);
        const forcedUtxos = await this._resolveForceInputs(req.forceInputs ?? [], senderUtxos);
        const txContext: TxBuildContext = {
            utxos: mergeUtxosUnique(senderUtxos, forcedUtxos),
            protocolParameters: protocolParameters
        };
        logger.debug(`Prepared build context: ${txContext.utxos.length} UTxOs for coin selection (${forcedUtxos.length} forced)`);
        const txBuildResult = await builder.buildUnsignedTransfer(req, txContext);

        logger.debug(`Built simple ADA transaction successfully.`);
        return txBuildResult;
    }

    /** Build a transaction with metadata (simple or multi-asset). */
    async buildTransactionWithMetadata(req: TxBuildRequest, protocolParameters: LedgerProtocolParameter): Promise<TxBuildResult> {
        const builder = await this.ensureInitialized();

        const senderUtxos = await this._fetchUtxosForAddress(req.senderAddress);
        const forcedUtxos = await this._resolveForceInputs(req.forceInputs ?? [], senderUtxos);
        const txContext: TxBuildContext = {
            utxos: mergeUtxosUnique(senderUtxos, forcedUtxos),
            protocolParameters: protocolParameters
        };
        logger.debug(`Prepared build context: ${txContext.utxos.length} UTxOs for coin selection (${forcedUtxos.length} forced)`);
        const txBuildResult = await builder.buildUnsignedTransactionWithMetadata(req, txContext);
        logger.debug(`Built transaction with metadata successfully.`);
        return txBuildResult;
    }

    /** Build a multi-asset transaction. */
    async buildMultiAssetTransaction(req: TxBuildRequest, protocolParameters: LedgerProtocolParameter): Promise<TxBuildResult> {
        if (!req.assets || req.assets.length === 0) {
            throw new Error('[CardanoTransactionBuilder] buildMultiAssetTransaction requires assets to be specified');
        }

        const builder = await this.ensureInitialized();

        const senderUtxos = await this._fetchUtxosForAddress(req.senderAddress);
        const forcedUtxos = await this._resolveForceInputs(req.forceInputs ?? [], senderUtxos);
        const txContext: TxBuildContext = {
            utxos: mergeUtxosUnique(senderUtxos, forcedUtxos),
            protocolParameters: protocolParameters
        };
        logger.debug(`Prepared build context: ${txContext.utxos.length} UTxOs for coin selection (${forcedUtxos.length} forced)`);
        const txBuildResult = await builder.buildUnsignedTransfer(req, txContext);

        logger.debug(`Built multi-asset transaction successfully.`);
        return txBuildResult;
    }

    /** Build a minting transaction. */
    async buildMintTransaction(req: TxBuildRequest, protocolParameters: LedgerProtocolParameter): Promise<TxBuildResult> {
        if (!req.mintActions || req.mintActions.length === 0) {
            throw new Error('[CardanoTransactionBuilder] buildMintTransaction requires mintActions to be specified');
        }
        if (!req.mintingPolicyScript) {
            throw new Error('[CardanoTransactionBuilder] buildMintTransaction requires mintingPolicyScript to be specified');
        }

        const mintReq: TxBuildMintRequest = req as TxBuildMintRequest;

        const builder = await this.ensureInitialized();
        const cardanoClient = this.client;

        const senderUtxos = await this._fetchUtxosForAddress(req.senderAddress);
        const forcedUtxos = await this._resolveForceInputs(req.forceInputs ?? [], senderUtxos);
        // Resolve CIP-31 reference inputs (read-only, not consumed — kept separate from coin-selection set)
        const referenceInputUtxos = await this._resolveReferenceInputs(req.referenceInputs ?? [], senderUtxos);

        const txContext: TxBuildContext = {
            utxos: mergeUtxosUnique(senderUtxos, forcedUtxos),
            protocolParameters: protocolParameters,
            // Pass evaluator if Ogmios is available for dynamic execution unit calculation
            evaluateTransaction: cardanoClient.hasEvaluatingBackend()
                ? (cbor) => cardanoClient.evaluateTransaction(cbor)
                : undefined,
            referenceInputUtxos: referenceInputUtxos.length > 0 ? referenceInputUtxos : undefined
        };
        logger.debug(`Prepared build context: ${txContext.utxos.length} UTxOs for coin selection (${forcedUtxos.length} forced, ${referenceInputUtxos.length} reference inputs)`);

        if (txContext.evaluateTransaction) {
            logger.debug(`Ogmios available - will use dynamic script evaluation`);
        } else {
            logger.debug(`Ogmios not available - using default execution units`);
        }

        const txBuildResult = await builder.buildUnsignedMintTransaction(mintReq, txContext);

        logger.debug(`Built minting transaction successfully.`);
        return txBuildResult;
    }

    /** Build a Plutus spending transaction (consume a UTxO at a script address). */
    async buildPlutusSpendTransaction(req: TxBuildRequest, protocolParameters: LedgerProtocolParameter): Promise<TxBuildResult> {
        if (!req.plutusScriptExecution) {
            throw new Error('[CardanoTransactionBuilder] buildPlutusSpendTransaction requires plutusScriptExecution to be specified');
        }

        const spendReq: TxBuildPlutusSpendRequest = req as TxBuildPlutusSpendRequest;

        const builder = await this.ensureInitialized();
        const cardanoClient = this.client;

        // Fetch sender UTxOs for fee payment
        const senderUtxos = await this._fetchUtxosForAddress(req.senderAddress);

        // The script UTxO sits at the script address; add it so the builder can find it
        const scriptRef = spendReq.plutusScriptExecution.scriptUtxo;
        const allUtxos = [...senderUtxos];

        const alreadyIncluded = senderUtxos.some(
            u => u.txHash === scriptRef.txHash && u.outputIndex === scriptRef.outputIndex
        );

        if (!alreadyIncluded) {
            allUtxos.push(await this._resolveScriptUtxo(scriptRef));
        }

        // Resolve forced inputs (may overlap with sender UTxOs or the script UTxO — dedup below).
        // The builder itself will skip any forced ref that matches scriptRef.
        const forcedUtxos = await this._resolveForceInputs(req.forceInputs ?? [], allUtxos);
        const mergedUtxos = mergeUtxosUnique(allUtxos, forcedUtxos);

        // Resolve CIP-31 reference inputs (read-only, not consumed — kept separate from coin-selection set)
        const referenceInputUtxos = await this._resolveReferenceInputs(req.referenceInputs ?? [], allUtxos);

        const txContext: TxBuildContext = {
            utxos: mergedUtxos,
            protocolParameters: protocolParameters,
            evaluateTransaction: cardanoClient.hasEvaluatingBackend()
                ? (cbor) => cardanoClient.evaluateTransaction(cbor)
                : undefined,
            referenceInputUtxos: referenceInputUtxos.length > 0 ? referenceInputUtxos : undefined
        };
        logger.debug(`Prepared build context: ${txContext.utxos.length} UTxOs for coin selection (${senderUtxos.length} sender + ${allUtxos.length - senderUtxos.length} script + ${forcedUtxos.length} forced + ${referenceInputUtxos.length} ref inputs)`);

        if (txContext.evaluateTransaction) {
            logger.debug(`Ogmios available - will use dynamic script evaluation`);
        } else {
            logger.debug(`Ogmios not available - using default execution units`);
        }

        const txBuildResult = await builder.buildUnsignedPlutusSpendTransaction(spendReq, txContext);

        logger.debug(`Built Plutus spending transaction successfully.`);
        return txBuildResult;
    }

    /**
     * Several script inputs in one transaction: resolve every script UTxO and every reference-script
     * UTxO (one ledger lookup each), plus the sender's UTxOs, forced and reference inputs.
     */
    async buildPlutusTransaction(req: TxBuildPlutusRequest, protocolParameters: LedgerProtocolParameter): Promise<TxBuildResult> {
        const builder = await this.ensureInitialized();
        const cardanoClient = this.client;

        const senderUtxos = await this._fetchUtxosForAddress(req.senderAddress);
        const scriptUtxos = await this._resolveInputRefs(
            req.scriptInputs.map(s => ({ txHash: s.txHash, outputIndex: s.outputIndex })), senderUtxos, 'scriptInput');
        const allUtxos = mergeUtxosUnique(senderUtxos, scriptUtxos);
        const forcedUtxos = await this._resolveForceInputs(req.forceInputs ?? [], allUtxos);

        // Reference-script UTxOs always from the ledger: a known sender UTxO may carry only the script hash
        const refScriptUtxos = await this._resolveInputRefs([
            ...req.scriptInputs.flatMap(s => (s.referenceScript ? [s.referenceScript] : [])),
            ...(req.withdrawals ?? []).flatMap(w => (w.referenceScript ? [w.referenceScript] : [])),
            ...(req.certificates ?? []).flatMap(c => (c.referenceScript ? [c.referenceScript] : [])),
            ...(req.mintActions ?? []).flatMap(m => (m.referenceScript ? [m.referenceScript] : [])),
        ], [], 'referenceScript');
        const callerRefUtxos = await this._resolveReferenceInputs(req.referenceInputs ?? [], allUtxos);
        const referenceInputUtxos = mergeUtxosUnique(callerRefUtxos, refScriptUtxos);

        // A credential this transaction registers is withdrawable in the same transaction
        const registeredHere = new Set((req.certificates ?? []).filter(c => c.type === 'registerStake').map(c => c.stakeAddress.toLowerCase()));
        await this._assertRewardAccountsRegistered(req.withdrawals ?? [], registeredHere);

        const txContext: TxBuildContext = {
            utxos: mergeUtxosUnique(allUtxos, forcedUtxos),
            protocolParameters,
            evaluateTransaction: cardanoClient.hasEvaluatingBackend()
                ? (cbor) => cardanoClient.evaluateTransaction(cbor)
                : undefined,
            referenceInputUtxos: referenceInputUtxos.length > 0 ? referenceInputUtxos : undefined,
        };
        logger.debug(`Prepared multi-script build context: ${senderUtxos.length} sender + ${scriptUtxos.length} script + ${forcedUtxos.length} forced UTxOs, ${referenceInputUtxos.length} reference inputs`);
        return builder.buildUnsignedPlutusTransaction(req, txContext);
    }

    /**
     * The ledger rejects a withdrawal from an unregistered reward account (also a zero one), so the
     * build fails here with the account named. A provider failure is passed on as it is.
     */
    private async _assertRewardAccountsRegistered(
        withdrawals: ReadonlyArray<{ rewardAddress: string }>, registeredHere: ReadonlySet<string> = new Set()
    ): Promise<void> {
        for (const [i, w] of withdrawals.entries()) {
            if (registeredHere.has(w.rewardAddress.toLowerCase())) continue;
            if (!(await this.client.isRewardAccountRegistered(w.rewardAddress))) {
                throw new TransactionValidationError(
                    `withdrawals[${i}] reward account ${w.rewardAddress} is not registered on chain; register the stake credential first`
                );
            }
        }
    }

    /**
     * Resolve the script UTxO of a Plutus spend from the node's ledger, otherwise from its producing
     * transaction. Spending an already-consumed script UTxO is the most common replay mistake —
     * both paths reject it with a clear 400 instead of a node-side rejection at submit.
     */
    private async _resolveScriptUtxo(scriptRef: { txHash: string; outputIndex: number }): Promise<UTxO> {
        const by = this.client.pendingSpends?.spentBy(scriptRef.txHash, scriptRef.outputIndex);
        if (by) throw new TransactionValidationError(`scriptUtxo ${outRefKey(scriptRef)} is spent by transaction ${by}, submitted and not yet on chain`);
        const ledger = await this._lookupUnspent([scriptRef]);
        if (ledger) {
            const live = ledger.get(outRefKey(scriptRef));
            if (!live) {
                throw new TransactionValidationError(`scriptUtxo ${outRefKey(scriptRef)} not found on-chain or already spent`);
            }
            return live;
        }
        logger.debug(`Script UTxO ${outRefKey(scriptRef)} not in sender UTxOs - fetching its transaction`);
        const tx = await this.client.getTransaction(scriptRef.txHash);
        const scriptOutput = tx.outputs?.find(o => o.outputIndex === scriptRef.outputIndex);
        if (!scriptOutput) {
            throw new TransactionValidationError(`Script UTxO output ${outRefKey(scriptRef)} not found in transaction`);
        }
        await this._assertUnspent(scriptRef, scriptOutput.address, 'scriptUtxo', new Map());
        return {
            txHash: scriptRef.txHash,
            outputIndex: scriptRef.outputIndex,
            address: scriptOutput.address,
            amount: scriptOutput.amount,
            inlineDatum: scriptOutput.inlineDatum,
            datumHash: scriptOutput.dataHash ?? undefined,
            scriptRef: scriptOutput.referenceScriptHash ?? undefined,
        };
    }

    /**
     * Unspent outputs for `refs` from the node's ledger, keyed "txHash#index"; null when no
     * ledger-state backend is usable or the query fails (callers fall back to getTransaction).
     */
    private async _lookupUnspent(
        refs: Array<{ txHash: string; outputIndex: number }>
    ): Promise<Map<string, UTxO> | null> {
        if (refs.length === 0) return new Map();
        try {
            const utxos = await this.client.getUnspentOutputs(refs);
            return utxos ? new Map(utxos.map(u => [outRefKey(u), u])) : null;
        } catch (err: unknown) {
            logger.warn(`Ledger lookup of ${refs.length} output reference(s) failed, falling back to the producing transactions: ${err instanceof Error ? err.message : String(err)}`);
            return null;
        }
    }

    /**
     * Verify that an output resolved via getTransaction is still unspent against the live UTxO
     * set of its address (getTransaction only proves it existed). Lookup failures are tolerated.
     */
    private async _assertUnspent(
        ref: { txHash: string; outputIndex: number },
        address: string,
        kind: string,
        liveUtxoCache: Map<string, UTxO[]>
    ): Promise<void> {
        let live: UTxO[];
        try {
            const cached = liveUtxoCache.get(address);
            if (cached) {
                live = cached;
            } else {
                live = await this.client.getAddressUtxos(address);
                liveUtxoCache.set(address, live);
            }
        } catch (err: unknown) {
            logger.warn(`Could not verify ${kind} ${ref.txHash}#${ref.outputIndex} is unspent: ${err instanceof Error ? err.message : String(err)}`);
            return;
        }
        const isLive = live.some(u => u.txHash === ref.txHash && u.outputIndex === ref.outputIndex);
        if (!isLive) {
            throw new TransactionValidationError(
                `${kind} ${ref.txHash}#${ref.outputIndex} is already spent`
            );
        }
    }

    /** Resolve forced-input refs (consumed) to full UTxO records. */
    private _resolveForceInputs(
        refs: Array<{ txHash: string; outputIndex: number }>,
        senderUtxos: UTxO[]
    ): Promise<UTxO[]> {
        return this._resolveInputRefs(refs, senderUtxos, 'forceInput');
    }

    /** Resolve CIP-31 reference-input refs (read-only, not merged into the coin-selection set). */
    private _resolveReferenceInputs(
        refs: Array<{ txHash: string; outputIndex: number }>,
        knownUtxos: UTxO[]
    ): Promise<UTxO[]> {
        return this._resolveInputRefs(refs, knownUtxos, 'referenceInput');
    }

    /**
     * Resolve {txHash, outputIndex} refs to full UTxO records: known UTxOs first, then the node's
     * ledger, otherwise the producing transaction plus an unspent check. Throws
     * TransactionValidationError (labelled by `kind`) for a missing or spent ref. Refs are
     * deduplicated; order is preserved.
     */
    private async _resolveInputRefs(
        refs: Array<{ txHash: string; outputIndex: number }>,
        knownUtxos: UTxO[],
        kind: 'forceInput' | 'referenceInput' | 'scriptInput' | 'referenceScript'
    ): Promise<UTxO[]> {
        if (!refs || refs.length === 0) return [];
        for (const r of refs) {
            const by = this.client.pendingSpends?.spentBy(r.txHash, r.outputIndex);
            if (by) throw new TransactionValidationError(`${kind} ${r.txHash}#${r.outputIndex} is spent by transaction ${by}, submitted and not yet on chain`);
        }
        // Dedup by "txHash#index" key
        const seen = new Set<string>();
        const dedupedRefs = refs.filter(r => {
            const key = `${r.txHash}#${r.outputIndex}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        const isKnown = (r: { txHash: string; outputIndex: number }) =>
            knownUtxos.some(u => u.txHash === r.txHash && u.outputIndex === r.outputIndex);
        const ledger = await this._lookupUnspent(dedupedRefs.filter(r => !isKnown(r)));
        const liveUtxoCache = new Map<string, UTxO[]>();
        const resolved: UTxO[] = [];
        for (const ref of dedupedRefs) {
            // 1) Cheap path: already known
            const local = knownUtxos.find(u => u.txHash === ref.txHash && u.outputIndex === ref.outputIndex);
            if (local) {
                resolved.push(local);
                continue;
            }
            // 2) The node's ledger answers existence and spendability in one lookup
            if (ledger) {
                const live = ledger.get(outRefKey(ref));
                if (!live) {
                    throw new TransactionValidationError(`${kind} ${outRefKey(ref)} not found on-chain or already spent`);
                }
                resolved.push(live);
                continue;
            }
            // 3) Fallback: fetch the producing transaction and look up the output.
            let tx;
            try {
                tx = await this.client.getTransaction(ref.txHash);
            } catch (err: unknown) {
                throw new TransactionValidationError(
                    `${kind} ${ref.txHash}#${ref.outputIndex} not found on-chain`,
                    err
                );
            }
            const output = tx?.outputs?.find(o => o.outputIndex === ref.outputIndex);
            if (!output) {
                throw new TransactionValidationError(
                    `${kind} ${ref.txHash}#${ref.outputIndex} not found on-chain`
                );
            }
            // getTransaction proves existence, not spendability
            await this._assertUnspent(ref, output.address, kind, liveUtxoCache);
            resolved.push({
                txHash: ref.txHash,
                outputIndex: ref.outputIndex,
                address: output.address,
                amount: output.amount,
                inlineDatum: output.inlineDatum,
                datumHash: output.dataHash ?? undefined,
                scriptRef: output.referenceScriptHash ?? undefined,
            });
        }
        return resolved;
    }

    /** Fetch the UTxOs of an address; throws InsufficientFundsError when it has none. */
    private async _fetchUtxosForAddress(address: string): Promise<UTxO[]> {
        logger.debug(`Fetching UTxOs for address: ${address}`);
        // The crawled set answers with an index lookup; the node's address query scans its whole
        // UTxO set. An empty answer from the set is re-checked there (funded in the last block).
        const local = await this.addressUtxoSource?.(address).catch((err: unknown) => {
            logger.warn(`Local UTxO lookup for ${address} failed, asking the node: ${err instanceof Error ? err.message : String(err)}`);
            return null;
        });
        const ledger = local && local.length > 0 ? local : await this.client.getAddressUtxos(address);
        // the ledger view still lists what our own submitted transactions spend while they wait in the mempool
        const all = this.client.pendingSpends?.apply(address, ledger) ?? ledger;
        // A UTxO carrying a reference script is deployed on purpose, not change to spend; only a
        // forced input consumes it (the fee of a spent reference script is also not counted by the builder).
        const utxos = all.filter(u => !u.scriptRef && !u.scriptRefCbor);
        if (utxos.length < all.length) logger.debug(`${all.length - utxos.length} UTxO(s) with a reference script left out of coin selection`);
        logger.debug(`Found ${utxos.length} UTxOs for address ${address.substring(0, 20)}...`);
        if (utxos.length === 0) {
            throw new InsufficientFundsError(
                'lovelace',
                BigInt(0),
                BigInt(0),
                undefined,
                all.length > 0
                    ? `address ${address} holds only UTxOs with a reference script — they are not spent as funding; pass one in forceInputsJson to consume it`
                    : `address ${address} has no UTxOs — verify this is the correct sender address and that it has been funded`
            );
        }
        return utxos;
    }
}

/** "txHash#outputIndex" key of an output reference. */
function outRefKey(ref: { txHash: string; outputIndex: number }): string {
    return `${ref.txHash}#${ref.outputIndex}`;
}

/** Merge two UTxO lists, skipping refs already present in the first. */
function mergeUtxosUnique(base: UTxO[], extra: UTxO[]): UTxO[] {
    if (extra.length === 0) return base;
    const seen = new Set(base.map(outRefKey));
    const result = [...base];
    for (const u of extra) {
        const key = outRefKey(u);
        if (!seen.has(key)) {
            seen.add(key);
            result.push(u);
        }
    }
    return result;
}