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
 * requirement therefore sits on each element, and getLiveness() alone is 'any' —
 * the same layout as NIGHTGATE's indexer service.
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
    // status, which remain authenticated. Mirrors NIGHTGATE's
    // `/api/v1/indexer/getLiveness()`, so a gateway probes both products the same way.
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
}
