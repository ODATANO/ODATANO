using { UtxoSetImportSource } from '../db/types';
using {odatano.cardano as db} from '../db/schema';

// Crawler control and status. The service itself is 'any': CAP checks the service before the
// operation, so anything stricter would 401 the anonymous getLiveness. Each element carries its own requirement.
@requires: 'any'
service CardanoIndexerService @(impl: './cardano-indexer-service') {

    @readonly
    @requires   : 'authenticated-user'
    @title      : 'Sync State'
    @description: 'Singleton crawl cursor: pre-sync progress, tip lag, status, errors'
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

    // Anonymous on purpose, since a liveness probe carries no credentials.
    // It probes no backend or DB and reveals no secrets. Readiness stays with the authenticated getStatus.
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
    @description: 'One-off import of the UTxO set that anchors crawler.utxoSet. Pause the crawler first. source=ogmios acquires the set at the crawler cursor (crawl must be at the tip); source=file loads a cardano-cli query utxo --whole-utxo dump (.json, or .ndjson from jq -c to_entries[]) taken at anchorSlot/anchorHash. source=aggregates rebuilds only the sums (LedgerAddresses, LedgerAddressAssets, LedgerAccounts) from the rows an earlier import left, e.g. after its aggregate phase failed; a cursor past the anchor is set back to it. source=scripts fills the reference-script columns (utxo_referenceScriptHash, utxo_referenceScriptSize, utxo_referenceScriptType) of rows an earlier import left empty: from the same dump (filePath), or without filePath from Ogmios for the unspent rows that hold a hash but no size; the set stays active. Runs in the background; progress via getStatus().utxoSet and the log.'
    @requires   : 'Admin'
    action   importUtxoSet(@assert.range source: UtxoSetImportSource, filePath: String,
                           @assert.range: [0, _] anchorSlot: Integer64, anchorHash: String) returns UtxoSetImportResult;

    @title      : 'Backfill Certificates'
    @description: 'Fill TransactionCertificates and TransactionWithdrawals for blocks the crawl already holds, from a second chain-sync stream (Ogmios). fromSlot defaults to the crawl start, toSlot to the cursor. Writes only those two tables; the crawler may keep running. Runs in the background; progress via getStatus().certificateBackfill.'
    @requires   : 'Admin'
    action   backfillCertificates(@assert.range: [0, _] fromSlot: Integer64, @assert.range: [0, _] toSlot: Integer64) returns CertificateBackfillResult;

    @title      : 'Backfill Transactions'
    @description: 'Complete transactions the crawl already holds from a second chain-sync stream (Ogmios): input outpoints, the spent output datum and reference-script hash, missing input addresses, TransactionRedeemers and TransactionDatums. Fills empty fields only; a transaction whose stored inputs differ from the stream is skipped. fromSlot defaults to the crawl start, toSlot to the cursor; the crawler may keep running. Runs in the background; progress via getStatus().transactionBackfill.'
    @requires   : 'Admin'
    action   backfillTransactions(@assert.range: [0, _] fromSlot: Integer64, @assert.range: [0, _] toSlot: Integer64) returns CertificateBackfillResult;

    @title      : 'Backfill Payment Credentials'
    @description: 'Fill utxo.paymentCredential on TransactionOutputs, TransactionInputs and LedgerUTxOs rows written before the column existed, decoded from the stored address. Walks each table once in key order; rows that carry a credential are left alone, so a second run is a no-op. No backend call; the crawler may keep running. Runs in the background; progress via getStatus().credentialBackfill.'
    @requires   : 'Admin'
    action   backfillPaymentCredentials() returns BackfillResult;

    @title      : 'Backfill Asset Decimals'
    @description: 'Fill Assets.decimals from the CIP-68 reference datum for every catalogue unit with label 333 or 444: the reference NFT is followed from its mint through the crawled transactions to the output that holds it now, and the decimals of that datum are written to every slice of the unit. No backend call; the crawler may keep running; a repeat refreshes the values. Runs in the background; progress via getStatus().decimalsBackfill.'
    @requires   : 'Admin'
    action   backfillAssetDecimals() returns BackfillResult;
}
