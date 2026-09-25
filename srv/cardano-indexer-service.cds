using {odatano.cardano as db} from '../db/schema';

/**
 * Cardano Indexer Service (v2.0)
 *
 * Control + observability surface for the chain crawler / pre-sync engine:
 * - read-only projections of the sync cursor and reorg audit log
 * - status function + pause/resume actions delegating to the crawler singleton
 *
 * Security note: see CardanoODataService (cardano-service.cds) for the rationale on
 * auth. pause/resume are operational actions — gate behind a dedicated Admin scope.
 * Read-only status and audit data remain available to authenticated users.
 *
 * Deliberately NO service-level @requires: CAP checks a service-level requirement
 * on every request BEFORE the operation's own annotation, so an operation-level
 * `@requires: 'any'` can never open a single function on an otherwise
 * authenticated service (anonymous callers get the 401 challenge first). The
 * requirement therefore sits on each element, and getLiveness() alone is 'any'.
 */
// Service-level 'any' on purpose: CAP authorizes the service BEFORE the operation and
// treats a service without a service-level @requires as authenticated-user under
// NODE_ENV=production, which would 401 the anonymous operation below despite its own
// 'any'. Every element carries its requirement; the service itself refuses nothing.
@requires: 'any'
service CardanoIndexerService @(impl: './cardano-indexer-service') {

    @readonly
    @requires   : 'authenticated-user'
    @title      : 'Sync State'
    @description: 'Singleton crawl cursor — pre-sync progress, tip lag, status, errors'
    entity SyncState as projection on db.CardanoSyncState;

    @readonly
    @requires   : 'authenticated-user'
    @title      : 'Reorg Log'
    @description: 'Audit trail of chain rollbacks handled by the crawler'
    entity ReorgLog  as projection on db.CardanoReorgLog;

    @title      : 'Crawler Status'
    @description: 'Live crawler status summary (numeric fields as strings, CAP-10 aligned)'
    type CrawlerStatus {
        running           : Boolean;
        syncStatus        : String;
        // 'chain-sync' | 'pagination' for the crawler in this process; null when this
        // instance is not the one crawling. Pagination is ~50x slower, and a crawl that
        // degraded to it still advances the cursor — this is how an operator tells.
        source            : String;
        lastSlot          : String;
        lastHeight        : String;
        tipHeight         : String;
        syncProgress      : String;
        consecutiveErrors : Integer;
        // crawler-fed ledger state (crawler.utxoSet): snapshot anchor + validity
        utxoSet           : UtxoSetStatus;
        // one-off certificate/withdrawal backfill over already crawled blocks (this process)
        certificateBackfill : CertificateBackfillStatus;
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
        startedAt    : Timestamp;
        finishedAt   : Timestamp;
        error        : String;
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
    /**
     * Emitted AFTER each block is committed. Subscribe instead of polling:
     *   (await cds.connect.to('CardanoIndexerService')).on('blockIndexed', ({ data }) => …)
     * In-process (plugin mode) this needs no messaging service.
     */
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

    @requires   : 'authenticated-user'
    function getStatus() returns CrawlerStatus;

    @title      : 'Liveness'
    type Liveness {
        status    : String;    // 'alive'
        timestamp : Timestamp;
        uptime    : Integer;   // seconds since process start
        version   : String;    // @odatano/core version
        network   : String;    // configured network
    }

    // Anonymous on purpose: a liveness probe carries no credentials. 200 as long
    // as the process answers — no backend or DB probe, no secrets, no backend
    // names, no API key state. Readiness stays with getStatus and the worker
    // status, which remain authenticated.
    @title      : 'Get Liveness'
    @description: 'Unauthenticated liveness probe: 200 while the process answers. Docker HEALTHCHECK and upstream probes use this instead of the service document.'
    @requires   : 'any'
    function getLiveness() returns Liveness;

    @title      : 'Pause Crawler'
    @description: 'Stop the crawler (closes the chain-sync stream). Resume continues from the cursor.'
    @requires   : 'Admin'
    action   pauseCrawler()  returns Boolean;

    @title      : 'Resume Crawler'
    @description: 'Start/restart the crawler from the persisted cursor using the configured source.'
    @requires   : 'Admin'
    action   resumeCrawler() returns Boolean;

    @title      : 'Import UTxO Set'
    @description: 'One-off import of the UTxO set that anchors crawler.utxoSet. Pause the crawler first. source=ogmios acquires the set at the crawler cursor (crawl must be at the tip); source=file loads a cardano-cli query utxo --whole-utxo dump (.json, or .ndjson from jq -c to_entries[]) taken at anchorSlot/anchorHash. Runs in the background; progress via getStatus().utxoSet.'
    @requires   : 'Admin'
    action   importUtxoSet(source: String, filePath: String, anchorSlot: Integer64, anchorHash: String) returns UtxoSetImportResult;

    @title      : 'Backfill Certificates'
    @description: 'Fill TransactionCertificates and TransactionWithdrawals for blocks the crawl already holds, from a second chain-sync stream (Ogmios). fromSlot defaults to the crawl start, toSlot to the cursor. Writes only those two tables; the crawler may keep running. Runs in the background; progress via getStatus().certificateBackfill.'
    @requires   : 'Admin'
    action   backfillCertificates(fromSlot: Integer64, toSlot: Integer64) returns CertificateBackfillResult;
}
