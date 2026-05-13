import cds from '@sap/cds';
import type { CardanoClient } from './cardano-client';
import type { UTxO } from '../utils/types';
import type { TxBuildRequest, TxBuildMintRequest, TxBuildPlutusSpendRequest, TxBuildContext, TxBuildResult, LedgerProtocolParameters } from '../utils/types';
import { TxBuilderRegistry } from './transaction-building/tx-builder-registry';
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
        // create transaction builder from registry
        this.txBuilder = TxBuilderRegistry.createDefault();
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
            allUtxos.push({
                txHash: scriptRef.txHash,
                outputIndex: scriptRef.outputIndex,
                address: scriptOutput.address,
                amount: scriptOutput.amount,
                inlineDatum: scriptOutput.inlineDatum,
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
     * Resolve a list of {txHash, outputIndex} refs to full UTxO records.
     * Prefers matching against already-fetched sender UTxOs to avoid extra backend calls.
     * Throws TransactionValidationError if any ref cannot be resolved (missing or spent).
     * Deduplicates input refs before lookup.
     *
     * @param refs forced-input refs from the request
     * @param senderUtxos sender UTxOs already fetched (for cheap matching)
     * @returns resolved UTxOs, in the same order as deduped refs
     */
    private async _resolveForceInputs(
        refs: Array<{ txHash: string; outputIndex: number }>,
        senderUtxos: UTxO[]
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
        const resolved: UTxO[] = [];
        for (const ref of dedupedRefs) {
            // 1) Cheap path: already in sender UTxOs
            const local = senderUtxos.find(u => u.txHash === ref.txHash && u.outputIndex === ref.outputIndex);
            if (local) {
                resolved.push(local);
                continue;
            }
            // 2) Fallback: fetch the producing transaction and look up the output.
            // If the output does not exist OR the UTxO has already been spent, treat as missing.
            let tx;
            try {
                tx = await this.client.getTransaction(ref.txHash);
            } catch (err: any) {
                throw new TransactionValidationError(
                    `forceInput ${ref.txHash}#${ref.outputIndex} not found on-chain`,
                    err
                );
            }
            const output = tx?.outputs?.find(o => o.outputIndex === ref.outputIndex);
            if (!output) {
                throw new TransactionValidationError(
                    `forceInput ${ref.txHash}#${ref.outputIndex} not found on-chain`
                );
            }
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
     * Resolve CIP-31 reference input refs to full UTxO records.
     * Same resolution logic as _resolveForceInputs but with distinct error messages.
     * Reference inputs are read-only — they are NOT merged into the coin-selection set.
     */
    private async _resolveReferenceInputs(
        refs: Array<{ txHash: string; outputIndex: number }>,
        knownUtxos: UTxO[]
    ): Promise<UTxO[]> {
        if (!refs || refs.length === 0) return [];
        const seen = new Set<string>();
        const dedupedRefs = refs.filter(r => {
            const key = `${r.txHash}#${r.outputIndex}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        const resolved: UTxO[] = [];
        for (const ref of dedupedRefs) {
            const local = knownUtxos.find(u => u.txHash === ref.txHash && u.outputIndex === ref.outputIndex);
            if (local) {
                resolved.push(local);
                continue;
            }
            let tx;
            try {
                tx = await this.client.getTransaction(ref.txHash);
            } catch (err: any) {
                throw new TransactionValidationError(
                    `referenceInput ${ref.txHash}#${ref.outputIndex} not found on-chain`,
                    err
                );
            }
            const output = tx?.outputs?.find(o => o.outputIndex === ref.outputIndex);
            if (!output) {
                throw new TransactionValidationError(
                    `referenceInput ${ref.txHash}#${ref.outputIndex} not found on-chain`
                );
            }
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