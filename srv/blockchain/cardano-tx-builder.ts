import cds from '@sap/cds';
import type { CardanoClient } from './cardano-client';
import type { UTxO } from '../utils/types';
import type { TxBuildRequest, TxBuildMintRequest, TxBuildPlutusSpendRequest, TxBuildContext, TxBuildResult, LedgerProtocolParameters } from '../utils/types';
import { BuildooorTxBuilder } from './transaction-building/buildooor-tx';
import type { CardanoTxBuilder } from './transaction-building/cardano-tx';
import { LedgerProtocolParameter } from '#cds-models/CardanoODataService';
import { InsufficientFundsError, TransactionValidationError } from '../utils/errors';

const logger = cds.log('CardanoTransactionBuilder');

/**
 * CardanoTransactionBuilder - High-level transaction builder that utilizes specific CardanoTxBuilder implementations
 * to build various types of Cardano transactions.
 */
export class CardanoTransactionBuilder {
    private client: CardanoClient;
    private txBuilder: CardanoTxBuilder | undefined;
    private initialized = false;

    /**
     * Create a new CardanoTransactionBuilder instance
     * @param client - The CardanoClient instance for UTxO fetching
     */
    constructor(client: CardanoClient) {
        this.client = client;
        logger.debug('CardanoTransactionBuilder instance created');
    }

    /**
     * Initialize the transaction builder
     * @param protocolParams - Optional protocol parameters (if not provided, fetched from backend)
     */
    async init(protocolParams?: LedgerProtocolParameters): Promise<void> {
        if (this.initialized && this.txBuilder) return;
        // Buildooor is the sole transaction builder.
        this.txBuilder = new BuildooorTxBuilder();
        await this.txBuilder.init(this.client, protocolParams);
        this.initialized = true;
        logger.debug(`Initialized with builder: ${this.txBuilder.name}`);
    }

    /**
     * Ensure the builder is initialized and return it (lazy init)
     * @returns {Promise<CardanoTxBuilder>} initialized builder
     * @throws {Error} if builder cannot be initialized
     */
    private async ensureInitialized(): Promise<CardanoTxBuilder> {
        if (!this.initialized || !this.txBuilder) {
            await this.init();
        }
        return this.txBuilder!;
    }

    /**
     * Reset the transaction builder (useful for testing)
     */
    reset(): void {
        this.txBuilder = undefined;
        this.initialized = false;
        logger.debug(`Builder reset`);
    }

    /**
     * Set the transaction builder directly (for testing)
     * @param builder - The builder to set
     */
    setBuilder(builder: CardanoTxBuilder): void {
        this.txBuilder = builder;
        this.initialized = true;
    }

    /**
     * Build a simple ADA transfer transaction
     * @param req transaction build request
     * @param protocolParameters current protocol parameters
     * @returns {Promise<TxBuildResult>} transaction build result
     */
    async buildSimpleAdaTransaction(req: TxBuildRequest, protocolParameters: LedgerProtocolParameter): Promise<TxBuildResult> {
        const builder = await this.ensureInitialized();

        // prepare the transaction build context
        const senderUtxos = await this._fetchUtxosForAddress(req.senderAddress);
        const forcedUtxos = await this._resolveForceInputs(req.forceInputs ?? [], senderUtxos);
        const txContext: TxBuildContext = {
            utxos: mergeUtxosUnique(senderUtxos, forcedUtxos),
            protocolParameters: protocolParameters
        };
        logger.debug(`Prepared build context: ${txContext.utxos.length} UTxOs for coin selection (${forcedUtxos.length} forced)`);
        // Build the unsigned transfer transaction
        const txBuildResult = await builder.buildUnsignedTransfer(req, txContext);

        logger.debug(`Built simple ADA transaction successfully.`);
        // Return the transaction build result
        return txBuildResult;
    }

    /**
     * Build a transaction with Metadata (for both simple and multi-asset transactions)
     * @param req transaction build request
     * @param protocolParameters current protocol parameters
     * @returns {Promise<TxBuildResult>} transaction build result
     */
    async buildTransactionWithMetadata(req: TxBuildRequest, protocolParameters: LedgerProtocolParameter): Promise<TxBuildResult> {
        const builder = await this.ensureInitialized();

        // Prepare the transaction build context
        const senderUtxos = await this._fetchUtxosForAddress(req.senderAddress);
        const forcedUtxos = await this._resolveForceInputs(req.forceInputs ?? [], senderUtxos);
        const txContext: TxBuildContext = {
            utxos: mergeUtxosUnique(senderUtxos, forcedUtxos),
            protocolParameters: protocolParameters
        };
        logger.debug(`Prepared build context: ${txContext.utxos.length} UTxOs for coin selection (${forcedUtxos.length} forced)`);
        // Build the unsigned transaction with metadata
        const txBuildResult = await builder.buildUnsignedTransactionWithMetadata(req, txContext);
        logger.debug(`Built transaction with metadata successfully.`);
        // Return the transaction build result
        return txBuildResult;
    }

    /** 
     * Build a multi-asset transaction
     * @param req transaction build request
     * @param protocolParameters current protocol parameters
     * @returns {Promise<TxBuildResult>} transaction build result
     */
    async buildMultiAssetTransaction(req: TxBuildRequest, protocolParameters: LedgerProtocolParameter): Promise<TxBuildResult> {
        if (!req.assets || req.assets.length === 0) {
            throw new Error('[CardanoTransactionBuilder] buildMultiAssetTransaction requires assets to be specified');
        }

        const builder = await this.ensureInitialized();

        // Prepare the transaction build context
        const senderUtxos = await this._fetchUtxosForAddress(req.senderAddress);
        const forcedUtxos = await this._resolveForceInputs(req.forceInputs ?? [], senderUtxos);
        const txContext: TxBuildContext = {
            utxos: mergeUtxosUnique(senderUtxos, forcedUtxos),
            protocolParameters: protocolParameters
        };
        logger.debug(`Prepared build context: ${txContext.utxos.length} UTxOs for coin selection (${forcedUtxos.length} forced)`);
        // Build the unsigned transfer transaction (unified with simple ADA transfer)
        const txBuildResult = await builder.buildUnsignedTransfer(req, txContext);

        logger.debug(`Built multi-asset transaction successfully.`);
        return txBuildResult;
    }

    /**
     * Build a minting transaction
     * @param req transaction build request
     * @param protocolParameters current protocol parameters
     * @returns {Promise<TxBuildResult>} transaction build result
     */
    async buildMintTransaction(req: TxBuildRequest, protocolParameters: LedgerProtocolParameter): Promise<TxBuildResult> {
        // Validate mint-specific required fields
        if (!req.mintActions || req.mintActions.length === 0) {
            throw new Error('[CardanoTransactionBuilder] buildMintTransaction requires mintActions to be specified');
        }
        if (!req.mintingPolicyScript) {
            throw new Error('[CardanoTransactionBuilder] buildMintTransaction requires mintingPolicyScript to be specified');
        }

        // Type is now narrowed to TxBuildMintRequest
        const mintReq: TxBuildMintRequest = req as TxBuildMintRequest;

        const builder = await this.ensureInitialized();
        const cardanoClient = this.client;

        // Prepare the transaction build context
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

        // Build the unsigned minting transaction
        const txBuildResult = await builder.buildUnsignedMintTransaction(mintReq, txContext);

        logger.debug(`Built minting transaction successfully.`);
        // Return the transaction build result
        return txBuildResult;
    }

    /**
     * Build a Plutus spending transaction (consume UTxO at script address)
     * @param req transaction build request
     * @param protocolParameters current protocol parameters
     * @returns {Promise<TxBuildResult>} transaction build result
     */
    async buildPlutusSpendTransaction(req: TxBuildRequest, protocolParameters: LedgerProtocolParameter): Promise<TxBuildResult> {
        if (!req.plutusScriptExecution) {
            throw new Error('[CardanoTransactionBuilder] buildPlutusSpendTransaction requires plutusScriptExecution to be specified');
        }

        const spendReq: TxBuildPlutusSpendRequest = req as TxBuildPlutusSpendRequest;

        const builder = await this.ensureInitialized();
        const cardanoClient = this.client;

        // Fetch sender UTxOs for fee payment
        const senderUtxos = await this._fetchUtxosForAddress(req.senderAddress);

        // Fetch the script UTxO separately (it's at the script address, not sender address)
        // We include it in the UTxO set so the builder can find it
        const scriptRef = spendReq.plutusScriptExecution.scriptUtxo;
        const allUtxos = [...senderUtxos];

        // Check if the script UTxO is already in sender UTxOs (unlikely but possible)
        const alreadyIncluded = senderUtxos.some(
            u => u.txHash === scriptRef.txHash && u.outputIndex === scriptRef.outputIndex
        );

        if (!alreadyIncluded) {
            // Fetch script UTxO via transaction lookup - the backend needs to provide it
            // For now, we create a minimal UTxO entry from what we know
            // The actual UTxO data will be resolved by the backend during tx building
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
     * Verify that a transaction output resolved via getTransaction is still unspent,
     * by checking the live UTxO set of its address. getTransaction only proves the
     * output EXISTED — a spent output would otherwise surface as a cryptic node-side
     * rejection at submit instead of a clear 400 here.
     *
     * Lookup failures are logged and tolerated (the check is best-effort; refusing to
     * build on a flaky backend would be a new failure mode).
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

    /**
     * Resolve forced-input refs (consumed) to full UTxO records.
     * Thin wrapper over _resolveInputRefs — see it for behaviour.
     */
    private _resolveForceInputs(
        refs: Array<{ txHash: string; outputIndex: number }>,
        senderUtxos: UTxO[]
    ): Promise<UTxO[]> {
        return this._resolveInputRefs(refs, senderUtxos, 'forceInput');
    }

    /**
     * Resolve CIP-31 reference input refs (read-only, NOT merged into the
     * coin-selection set) to full UTxO records.
     */
    private _resolveReferenceInputs(
        refs: Array<{ txHash: string; outputIndex: number }>,
        knownUtxos: UTxO[]
    ): Promise<UTxO[]> {
        return this._resolveInputRefs(refs, knownUtxos, 'referenceInput');
    }

    /**
     * Resolve a list of {txHash, outputIndex} refs to full UTxO records.
     * Prefers matching against already-known UTxOs to avoid extra backend calls;
     * otherwise fetches the producing transaction and verifies the output is
     * unspent. Throws TransactionValidationError (labelled by `kind`) if any ref
     * cannot be resolved (missing or spent). Deduplicates refs before lookup.
     *
     * @param refs input refs from the request
     * @param knownUtxos UTxOs already fetched (cheap-match pool)
     * @param kind label used in error messages / the spent-check
     * @returns resolved UTxOs, in the same order as the deduped refs
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

    /**
     * Fetch UTxOs for a given address
     * @param address bech32 address
     * @returns {Promise<UTxO[]>} list of UTxOs
     */
    private async _fetchUtxosForAddress(address: string): Promise<UTxO[]> {
        logger.debug(`Fetching UTxOs for address: ${address}`);
        const utxos = await this.client.getAddressUtxos(address);
        logger.debug(`Found ${utxos.length} UTxOs for address ${address.substring(0, 20)}...`);
        if (utxos.length === 0) {
            throw new InsufficientFundsError(
                'lovelace',
                BigInt(0),
                BigInt(0),
                new Error(`Address ${address} has no UTxOs. Verify this is the correct sender address and that it has been funded.`)
            );
        }
        return utxos;
    }
}

/**
 * Merge two UTxO lists, skipping refs already present in the first.
 * Used to add forced UTxOs to a context without duplicating existing entries.
 */
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