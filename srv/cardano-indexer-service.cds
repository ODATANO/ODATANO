using { UtxoSetImportSource, AssetRegistrySource } from '../db/types';
using {odatano.cardano as db} from '../db/schema';

// Crawler control and status. The service itself is 'any': CAP checks the service before the
// operation, so anything stricter would 401 the anonymous probes. Each element carries its own requirement.
@requires: 'any'
service CardanoIndexerService @(impl: './cardano-indexer-service') {

    @readonly
    @requires   : 'Read'
    @title      : 'Sync State'
    @description: 'Singleton crawl cursor: pre-sync progress, tip lag, status, errors'
    entity SyncState as projection on db.CardanoSyncState;

    @readonly
    @requires   : 'Read'
    @title      : 'Reorg Log'
    @description: 'Audit trail of chain rollbacks handled by the crawler'
    entity ReorgLog  as projection on db.CardanoReorgLog;

    @title      : 'Crawler Status'
    @description: 'Live crawler status summary (numeric fields as strings, CAP-10 aligned)'
    type CrawlerStatus {
        running           : Boolean;
        syncStatus        : String;
        // chain-sync or pagination for the crawler in this process, null when another instance crawls.
        // Pagination is about 50x slower but still advances the cursor, so only this field shows it.
        source            : String;
        lastSlot          : String;
        lastHeight        : String;
        tipHeight         : String;
        syncProgress      : String;
        consecutiveErrors : Integer;
        lastIndexedAt     : Timestamp; // when the last block was committed
        // true: the crawler holds its lease but committed no block for 10 minutes
        stalled           : Boolean;
        // crawler-fed ledger state (crawler.utxoSet): snapshot anchor + validity
        utxoSet           : UtxoSetStatus;
        // one-off certificate/withdrawal backfill over already crawled blocks (this process)
        certificateBackfill : CertificateBackfillStatus;
        // one-off input/redeemer/datum backfill over already crawled blocks (this process)
        transactionBackfill : TransactionBackfillStatus;
        // one-off payment-credential fill of UTxO-shaped rows (this process)
        credentialBackfill : CredentialBackfillStatus;
        // one-off CIP-68 decimals fill of the asset catalogue (this process)
        decimalsBackfill : DecimalsBackfillStatus;
        // one-off CIP-26 registry fill of the asset catalogue (this process)
        registryBackfill : RegistryBackfillStatus;
        // one-off repair of output datums (this process)
        datumBackfill : DatumBackfillStatus;
        // one-off chain-position fill of metadata rows (this process)
        metadataBackfill : MetadataBackfillStatus;
        // rebuild of epoch rows from the crawled blocks (this process)
        epochBackfill : EpochBackfillStatus;
        // walk that moves inputs from asset copies to their output (this process)
        copyPrune : InputCopyPruneStatus;
        // walk that moves inputs back to asset copies (this process)
        copyRestore : InputCopyRestoreStatus;
        // per-epoch pool/DRep/pot snapshots (crawler.epochSnapshots)
        epochSnapshots    : EpochSnapshotStatus;
    }

    @title      : 'Epoch Snapshot Status'
    @description: 'Latest epoch snapshot and the source this process would use for the next one'
    type EpochSnapshotStatus {
        enabled   : Boolean;   // crawler.epochSnapshots configured
        source    : String;    // ogmios | koios | null (no usable backend)
        lastEpoch : Integer;   // newest snapshotted epoch; null before the first
        lastSource: String;    // source of that snapshot
        lastSlot  : String;    // block it was taken at
        accounts  : Boolean;   // crawler.accountSnapshots configured
        lastAccountEpoch : Integer; // newest epoch with an account snapshot; null before the first
        lastAccountCount : Integer; // accounts in that snapshot
    }

    @title      : 'Certificate Backfill Status'
    @description: 'Progress of the certificate/withdrawal backfill started with backfillCertificates; process-local, none after a restart'
    type CertificateBackfillStatus {
        status       : String;    // none | running | done | failed
        fromSlot     : String;
        toSlot       : String;
        atSlot       : String;    // last slot handled
        blocks       : Integer64;
        certificates : Integer64;
        withdrawals  : Integer64;
        removed      : Integer64; // stored rows removed for transactions whose script phase failed
        startedAt    : Timestamp;
        finishedAt   : Timestamp;
        error        : String;
    }

    @title      : 'Transaction Backfill Status'
    @description: 'Progress of the backfill started with backfillTransactions; process-local, none after a restart'
    type TransactionBackfillStatus {
        status       : String;    // none | running | done | failed
        fromSlot     : String;
        toSlot       : String;
        atSlot       : String;    // last slot handled
        blocks       : Integer64;
        transactions : Integer64;
        inputs       : Integer64; // input rows that got at least one field
        outputs      : Integer64; // output rows that got a datum or reference-script field
        redeemers    : Integer64;
        datums       : Integer64;
        rewritten    : Integer64; // transactions whose stored rows differed in order or extent from the ledger view, now rewritten
        skipped      : Integer64; // transactions whose stored inputs differ from the stream
        startedAt    : Timestamp;
        finishedAt   : Timestamp;
        error        : String;
    }

    @title      : 'Credential Backfill Status'
    @description: 'Progress of the payment-credential fill started with backfillPaymentCredentials; process-local, none after a restart'
    type CredentialBackfillStatus {
        status      : String;    // none | running | done | failed
        table       : String;    // table being walked: TransactionOutputs | TransactionInputs | LedgerUTxOs; null when finished
        outputs     : Integer64; // rows that received a credential
        inputs      : Integer64;
        ledgerUtxos : Integer64;
        startedAt   : Timestamp;
        finishedAt  : Timestamp;
        error       : String;
    }

    @title      : 'Decimals Backfill Status'
    @description: 'Progress of the CIP-68 decimals fill started with backfillAssetDecimals; process-local, none after a restart'
    type DecimalsBackfillStatus {
        status     : String;    // none | running | done | failed
        scanned    : Integer64; // catalogue rows read
        candidates : Integer64; // units with label 333 or 444
        filled     : Integer64; // units that received a decimals value
        startedAt  : Timestamp;
        finishedAt : Timestamp;
        error      : String;
    }

    @title      : 'Registry Backfill Status'
    @description: 'Progress of the CIP-26 registry fill started with backfillAssetRegistry; process-local, none after a restart'
    type RegistryBackfillStatus {
        status     : String;    // none | running | done | failed
        units      : Integer64; // units with a registry entry
        processed  : Integer64; // units handled so far
        filled     : Integer64; // units whose rows received the registry values
        failed     : Integer64; // units the backend did not resolve, or entry files that could not be read
        absent     : Integer64; // source file: registry units without an Assets row
        skipped    : Integer64; // source file: entries that describe no native asset
        startedAt  : Timestamp;
        finishedAt : Timestamp;
        error      : String;
    }

    @title      : 'Datum Backfill Status'
    @description: 'Progress of the output datum repair started with backfillOutputDatums; process-local, none after a restart'
    type DatumBackfillStatus {
        status       : String;    // none | running | done | failed
        scanned      : Integer64; // stored outputs read
        candidates   : Integer64; // outputs with a datum hash and no inline datum
        transactions : Integer64; // transactions read again from the backend
        missing      : Integer64; // candidate transactions the backend did not return
        outputs      : Integer64; // output rows that got a field
        inputs       : Integer64; // input rows that spent such an output and got the field
        ledgerUtxos  : Integer64; // UTxO set rows that got the field
        startedAt    : Timestamp;
        finishedAt   : Timestamp;
        error        : String;
    }

    @title      : 'Epoch Backfill Status'
    @description: 'Progress of the walk started with backfillEpochs; process-local, none after a restart'
    type EpochBackfillStatus {
        status     : String;    // none | running | done | failed
        atEpoch    : Integer;   // epoch the walk has reached
        toEpoch    : Integer;   // epoch of the crawler cursor
        updated    : Integer;   // rows whose totals were written
        created    : Integer;   // rows that did not exist
        startedAt  : Timestamp;
        finishedAt : Timestamp;
        error      : String;
    }

    @title      : 'Input Copy Prune Status'
    @description: 'Progress of the walk started with pruneInputAssetCopies; process-local, none after a restart'
    type InputCopyPruneStatus {
        status     : String;    // none | running | done | failed
        atSlot     : String;    // slot the walk has reached
        toSlot     : String;    // last slot of the walk
        referenced : Integer64; // inputs that read from their output now
        kept       : Integer64; // inputs of the walked slots left without a reference
        deleted    : Integer64; // copy rows deleted
        startedAt  : Timestamp;
        finishedAt : Timestamp;
        error      : String;
    }

    @title      : 'Input Copy Restore Status'
    @description: 'Progress of the walk started with restoreInputAssetCopies; process-local, none after a restart'
    type InputCopyRestoreStatus {
        status     : String;    // none | running | done | failed
        atSlot     : String;    // slot the walk has reached
        toSlot     : String;    // last slot of the walk
        restored   : Integer64; // inputs that read from a copy again
        rows       : Integer64; // copy rows written
        startedAt  : Timestamp;
        finishedAt : Timestamp;
        error      : String;
    }

    @title      : 'Metadata Backfill Status'
    @description: 'Progress of the chain-position fill started with backfillMetadataPositions; process-local, none after a restart'
    type MetadataBackfillStatus {
        status     : String;    // none | running | done | failed
        atSlot     : String;    // slot the walk has reached
        toSlot     : String;    // last slot that holds a stored transaction
        rows       : Integer64; // metadata rows that received their position
        startedAt  : Timestamp;
        finishedAt : Timestamp;
        error      : String;
    }

    @title      : 'Backfill Result'
    type BackfillResult {
        accepted : Boolean;
        message  : String;
    }

    @title      : 'Certificate Backfill Result'
    type CertificateBackfillResult {
        accepted : Boolean;
        fromSlot : String;
        toSlot   : String;
        message  : String;
    }

    @title      : 'UTxO Set Status'
    @description: 'State of the crawler-maintained UTxO set (crawler.utxoSet)'
    type UtxoSetStatus {
        enabled    : Boolean;   // crawler.utxoSet configured
        status     : String;    // none | importing | active | invalid
        anchorSlot : String;    // null until imported
        anchorHash : String;
        importedAt : Timestamp;
        error      : String;    // why invalid
    }

    @title      : 'UTxO Set Import Result'
    type UtxoSetImportResult {
        accepted   : Boolean;
        anchorSlot : String;
        anchorHash : String;
        message    : String;
    }

    @title      : 'Get Crawler Status'
    @description: 'Return the current crawler run state and sync progress'
    /** Emitted after each block is committed. In plugin mode subscribing needs no messaging service. */
    event blockIndexed {
        hash     : String(64);
        slot     : Integer64;
        height   : Integer64;
        txHashes : many String(64);
        tipSlot  : Integer64;
        tipHeight: Integer64;
    }

    /** Emitted AFTER a rollback is committed. Everything above `forkSlot` was removed. */
    event reorg {
        forkSlot         : Integer64;
        forkHeight       : Integer64;
        blocksRolledBack : Integer;
    }

    @requires   : 'Read'
    @odatano.agent: 'read'
    function getStatus() returns CrawlerStatus;

    @title      : 'Liveness'
    type Liveness {
        status    : String;    // 'alive'
        timestamp : Timestamp;
        uptime    : Integer;   // seconds since process start
        version   : String;    // @odatano/core version
        network   : String;    // configured network
    }

    // Anonymous on purpose, since a liveness probe carries no credentials.
    // It probes no backend or DB and reveals no secrets.
    @title      : 'Get Liveness'
    @description: 'Unauthenticated liveness probe: 200 while the process answers. The Docker HEALTHCHECK uses this.'
    @requires   : 'any'
    @odatano.agent: 'read'
    function getLiveness() returns Liveness;

    @title      : 'Readiness'
    type Readiness {
        status    : String;    // 'ready' | 'not_ready'
        timestamp : Timestamp;
        context   : Boolean;   // client, indexer and transaction builder exist
        database  : Boolean;   // the database answers and holds the schema
        hsm       : Boolean;   // null = no HSM configured; the HSM session is connected
    }

    // Anonymous like getLiveness. The body names the missing part and no configuration detail.
    @title      : 'Get Readiness'
    @description: 'Unauthenticated readiness probe: 200 when this instance can serve requests, 503 with the same body while the app context, the database or a configured HSM is missing. Load balancers and upstream gateways use this to decide whether to route requests here.'
    @requires   : 'any'
    @odatano.agent: 'read'
    function getReadiness() returns Readiness;

    @title      : 'Pause Crawler'
    @description: 'Stop the crawler (closes the chain-sync stream). Resume continues from the cursor.'
    @requires   : 'Admin'
    @odatano.agent: 'operator'
    action   pauseCrawler()  returns Boolean;

    @title      : 'Resume Crawler'
    @description: 'Start/restart the crawler from the persisted cursor using the configured source.'
    @requires   : 'Admin'
    @odatano.agent: 'operator'
    action   resumeCrawler() returns Boolean;

    @title      : 'Import UTxO Set'
    @description: 'One-off import of the UTxO set that anchors crawler.utxoSet. Pause the crawler first. source=ogmios acquires the set at the crawler cursor (crawl must be at the tip); source=file loads a cardano-cli query utxo --whole-utxo dump (.json, or .ndjson from jq -c to_entries[]) taken at anchorSlot/anchorHash. source=aggregates rebuilds only the sums (LedgerAddresses, LedgerAddressAssets, LedgerAccounts) from the rows an earlier import left, e.g. after its aggregate phase failed; a cursor past the anchor is set back to it. source=scripts fills the reference-script columns (utxo_referenceScriptHash, utxo_referenceScriptSize, utxo_referenceScriptType) of rows an earlier import left empty: from the same dump (filePath), or without filePath from Ogmios for the unspent rows that hold a hash but no size; the set stays active. Runs in the background; progress via getStatus().utxoSet and the log.'
    @requires   : 'Admin'
    @odatano.agent: 'operator'
    action   importUtxoSet(@assert.range source: UtxoSetImportSource, filePath: String,
                           @assert.range: [0, _] anchorSlot: Integer64, anchorHash: String) returns UtxoSetImportResult;

    @title      : 'Backfill Certificates'
    @description: 'Fill TransactionCertificates and TransactionWithdrawals for blocks the crawl already holds, from a second chain-sync stream (Ogmios), and remove the rows stored for a transaction whose script phase failed. fromSlot defaults to the crawl start, toSlot to the cursor. Writes only those two tables; the crawler may keep running. Runs in the background; progress via getStatus().certificateBackfill.'
    @requires   : 'Admin'
    @odatano.agent: 'operator'
    action   backfillCertificates(@assert.range: [0, _] fromSlot: Integer64, @assert.range: [0, _] toSlot: Integer64) returns CertificateBackfillResult;

    @title      : 'Backfill Transactions'
    @description: 'Complete transactions the crawl already holds from a second chain-sync stream (Ogmios): input outpoints, the spent output datum and reference-script hash, missing input addresses, empty datum and reference-script fields of stored outputs, TransactionRedeemers and TransactionDatums. Fills empty fields only; a transaction whose stored inputs differ from the stream is skipped. fromSlot defaults to the crawl start, toSlot to the cursor; the crawler may keep running. Runs in the background; progress via getStatus().transactionBackfill.'
    @requires   : 'Admin'
    @odatano.agent: 'operator'
    action   backfillTransactions(@assert.range: [0, _] fromSlot: Integer64, @assert.range: [0, _] toSlot: Integer64) returns CertificateBackfillResult;

    @title      : 'Backfill Payment Credentials'
    @description: 'Fill utxo.paymentCredential on TransactionOutputs, TransactionInputs and LedgerUTxOs rows written before the column existed, decoded from the stored address. Walks each table once in key order; rows that carry a credential are left alone, so a second run is a no-op. No backend call; the crawler may keep running. Runs in the background; progress via getStatus().credentialBackfill.'
    @requires   : 'Admin'
    @odatano.agent: 'operator'
    action   backfillPaymentCredentials() returns BackfillResult;

    @title      : 'Backfill Output Datums'
    @description: 'Repair stored outputs that hold a datum hash and no inline datum: their transactions are read again from a backend that serves transactions (Koios, Blockfrost or a remote ODATANO), and the inline datum and the reference-script fields it returns are written to the output, to the inputs that spent it and to its UTxO set row. Only empty fields change. An output whose datum is hash-only stays as it is and is read again on a repeat. With Ogmios as the only backend use backfillTransactions, which fills the same fields from the node. Runs in the background; progress via getStatus().datumBackfill.'
    @requires   : 'Admin'
    @odatano.agent: 'operator'
    action   backfillOutputDatums() returns BackfillResult;

    @title      : 'Backfill Metadata Positions'
    @description: 'Write the chain position (txSeq) of its transaction to every TransactionMetadata row that lacks it, so GetMetadataByLabel returns rows stored before the column existed. Walks the stored transactions by slot window. No backend call; the crawler may keep running; a repeat changes nothing. Runs in the background; progress via getStatus().metadataBackfill.'
    @requires   : 'Admin'
    @odatano.agent: 'operator'
    action   backfillMetadataPositions() returns BackfillResult;

    @title      : 'Backfill Epochs'
    @description: 'Write block count, transaction count, fees and the first and last block time of every epoch the crawl covers in full, from the stored blocks. An epoch that has no row gets one; output and active stake of an existing row stay. No backend. Runs detached; poll getStatus().epochBackfill. May be repeated.'
    @requires   : 'Admin'
    @odatano.agent: 'operator'
    action   backfillEpochs() returns BackfillResult;

    @title      : 'Prune Input Asset Copies'
    @description: 'Move the transaction inputs between fromSlot and toSlot (slot of the spending transaction) from stored asset copies to the output they spent. An input moves only when that output is stored and holds exactly the assets of its copy; its copy is deleted and it reads from the output. Answers stay the same; a long range of inputs reads slower. Disk space is free once the copy table is rewritten. restoreInputAssetCopies undoes it. slotWindow: slots per transaction, default 20000. PostgreSQL and SQLite. Runs detached; poll getStatus().copyPrune.'
    @requires   : 'Admin'
    @odatano.agent: 'operator'
    action   pruneInputAssetCopies(@assert.range: [0, _] fromSlot: Integer64 not null, @assert.range: [0, _] toSlot: Integer64 not null, @assert.range: [1, 1000000] slotWindow: Integer) returns BackfillResult;

    @title      : 'Restore Input Asset Copies'
    @description: 'Move the transaction inputs between fromSlot and toSlot (slot of the spending transaction) back to stored asset copies, written from the outputs they spent. slotWindow: slots per transaction, default 20000. PostgreSQL and SQLite. Runs detached; poll getStatus().copyRestore.'
    @requires   : 'Admin'
    @odatano.agent: 'operator'
    action   restoreInputAssetCopies(@assert.range: [0, _] fromSlot: Integer64 not null, @assert.range: [0, _] toSlot: Integer64 not null, @assert.range: [1, 1000000] slotWindow: Integer) returns BackfillResult;

    @title      : 'Backfill Asset Decimals'
    @description: 'Fill Assets.decimals from the CIP-68 reference datum for every catalogue unit with label 333 or 444: the reference NFT is followed from its mint through the crawled transactions to the output that holds it now, and the decimals of that datum are written to every slice of the unit. No backend call; the crawler may keep running; a repeat refreshes the values. Runs in the background; progress via getStatus().decimalsBackfill.'
    @requires   : 'Admin'
    @odatano.agent: 'operator'
    action   backfillAssetDecimals() returns BackfillResult;

    @title      : 'Backfill Asset Registry'
    @description: 'Fill the CIP-26 registry fields (registryName, registryTicker, registryDecimals, registryDescription, registryUrl, registryLogo) on every slice of every Assets unit the token registry lists, and decimals where it is still empty. source koios (default): each unit is read from the backend (needs Koios), rate limited. source file: path names a folder on the server with the entry files of the registry repository (mappings of cardano-token-registry, registry of metadata-registry-testnet); units without an Assets row are counted, not created; no backend. The crawler may keep running; a repeat refreshes the values. Runs in the background; progress via getStatus().registryBackfill.'
    @requires   : 'Admin'
    @odatano.agent: 'operator'
    action   backfillAssetRegistry(@assert.range source: AssetRegistrySource, path: String) returns BackfillResult;
}
