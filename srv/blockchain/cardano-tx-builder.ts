import cds from '@sap/cds';
import type { CardanoClient } from './cardano-client';
import type { UTxO } from '../utils/types';
import type { TxBuildRequest, TxBuildMintRequest, TxBuildPlutusSpendRequest, TxBuildContext, TxBuildResult, LedgerProtocolParameters } from '../utils/types';
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
            evaluateTransaction: cardanoClient.hasOgmiosBackend()
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
            logger.debug(`Script UTxO ${scriptRef.txHash}#${scriptRef.outputIndex} not in sender UTxOs - fetching from backend`);
            const tx = await cardanoClient.getTransaction(scriptRef.txHash);
            const scriptOutput = tx.outputs?.find(o => o.outputIndex === scriptRef.outputIndex);
            if (!scriptOutput) {
                throw new TransactionValidationError(`Script UTxO output ${scriptRef.txHash}#${scriptRef.outputIndex} not found in transaction`);
            }
            // spending an already-consumed script UTxO is the most common replay mistake —
            // catch it here with a clear 400 instead of a node-side rejection at submit
            await this._assertUnspent(scriptRef, scriptOutput.address, 'scriptUtxo', new Map());
            allUtxos.push({
                txHash: scriptRef.txHash,
                outputIndex: scriptRef.outputIndex,
                address: scriptOutput.address,
                amount: scriptOutput.amount,
                inlineDatum: scriptOutput.inlineDatum,
                datumHash: scriptOutput.dataHash ?? undefined,
                scriptRef: scriptOutput.referenceScriptHash ?? undefined,
            });
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
            evaluateTransaction: cardanoClient.hasOgmiosBackend()
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
     * Resolve {txHash, outputIndex} refs to full UTxO records: known UTxOs first, otherwise the
     * producing transaction plus an unspent check. Throws TransactionValidationError (labelled
     * by `kind`) for a missing or spent ref. Refs are deduplicated; order is preserved.
     */
    private async _resolveInputRefs(
        refs: Array<{ txHash: string; outputIndex: number }>,
        knownUtxos: UTxO[],
        kind: 'forceInput' | 'referenceInput'
    ): Promise<UTxO[]> {
        if (!refs || refs.length === 0) return [];
        // Dedup by "txHash#index" key
        const seen = new Set<string>();
        const dedupedRefs = refs.filter(r => {
            const key = `${r.txHash}#${r.outputIndex}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        const liveUtxoCache = new Map<string, UTxO[]>();
        const resolved: UTxO[] = [];
        for (const ref of dedupedRefs) {
            // 1) Cheap path: already known
            const local = knownUtxos.find(u => u.txHash === ref.txHash && u.outputIndex === ref.outputIndex);
            if (local) {
                resolved.push(local);
                continue;
            }
            // 2) Fallback: fetch the producing transaction and look up the output.
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
        const utxos = await this.client.getAddressUtxos(address);
        logger.debug(`Found ${utxos.length} UTxOs for address ${address.substring(0, 20)}...`);
        if (utxos.length === 0) {
            throw new InsufficientFundsError(
                'lovelace',
                BigInt(0),
                BigInt(0),
                undefined,
                `address ${address} has no UTxOs — verify this is the correct sender address and that it has been funded`
            );
        }
        return utxos;
    }
}

/** Merge two UTxO lists, skipping refs already present in the first. */
function mergeUtxosUnique(base: UTxO[], extra: UTxO[]): UTxO[] {
    if (extra.length === 0) return base;
    const seen = new Set(base.map(u => `${u.txHash}#${u.outputIndex}`));
    const result = [...base];
    for (const u of extra) {
        const key = `${u.txHash}#${u.outputIndex}`;
        if (!seen.has(key)) {
            seen.add(key);
            result.push(u);
        }
    }
    return result;
}