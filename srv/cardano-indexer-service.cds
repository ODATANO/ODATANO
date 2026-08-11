using {odatano.cardano as db} from '../db/schema';

/**
 * Cardano Indexer Service (v2.0)
 *
 * Control + observability surface for the chain crawler / pre-sync engine:
 * - read-only projections of the sync cursor and reorg audit log
 * - status function + pause/resume actions delegating to the crawler singleton
 *
 * Security note: see CardanoODataService (cardano-service.cds) for the rationale on
 * service-level auth. pause/resume are operational actions — gate behind a dedicated
 * Admin scope. Read-only status and audit data remain available to authenticated users.
 */
@requires: 'authenticated-user'
service CardanoIndexerService @(impl: './cardano-indexer-service') {

    @readonly
    @title      : 'Sync State'
    @description: 'Singleton crawl cursor — pre-sync progress, tip lag, status, errors'
    entity SyncState as projection on db.CardanoSyncState;

    @readonly
    @title      : 'Reorg Log'
    @description: 'Audit trail of chain rollbacks handled by the crawler'
    entity ReorgLog  as projection on db.CardanoReorgLog;

    @title      : 'Crawler Status'
    @description: 'Live crawler status summary (numeric fields as strings, CAP-10 aligned)'
    type CrawlerStatus {
        running           : Boolean;
        syncStatus        : String;
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

    function getStatus() returns CrawlerStatus;

    @title      : 'Pause Crawler'
    @description: 'Stop the crawler (closes the chain-sync stream). Resume continues from the cursor.'
    @requires   : 'Admin'
    action   pauseCrawler()  returns Boolean;

    @title      : 'Resume Crawler'
    @description: 'Start/restart the crawler from the persisted cursor using the configured source.'
    @requires   : 'Admin'
    action   resumeCrawler() returns Boolean;
}
