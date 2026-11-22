using { WalletJobKind } from '../db/types';
using {odatano.cardano as db} from '../db/schema';

// Async wallet jobs signed with server-held keys, which are never accepted or returned here.
// Control actions and foreign jobs need Admin. A job needs the wallet's requiresRole and, on an
// HSM wallet, hsm.requiresRole. An agent token gets a 403 on every event of this service.
@requires: 'Transact'
@odatano.agent: 'closed'
service CardanoWorkerService @(impl: './cardano-worker-service') {

    @readonly
    @title      : 'Wallet Jobs'
    @description: 'Asynchronous wallet-worker jobs. Non-admin callers see their own jobs only.'
    @restrict   : [
        { grant: 'READ', to: 'Admin' },
        { grant: 'READ', where: 'createdBy = $user' }
    ]
    // dedupKey is the internal backing column of the idempotency constraint.
    entity WalletJobs     as projection on db.CardanoWalletJobs excluding { dedupKey };

    @readonly
    @title      : 'Worker Wallets'
    @description: 'Registered server-side worker wallets (addresses and stats only; no key material, no lease internals)'
    entity WorkerWallets  as projection on db.CardanoWorkerWallets excluding { leaseOwner, leaseUntil };

    @title      : 'Wallet Job Submission Result'
    type JobSubmissionResult {
        jobId        : UUID;
        status       : String(12);
        deduplicated : Boolean;
    }

    @title      : 'Wallet Job Status'
    type JobStatus {
        jobId        : UUID;
        walletId     : String(50);
        kind         : String(12);
        status       : String(12);
        attempt      : Integer;
        txHash       : String(64);
        fee          : String;
        errorCode    : String(50);
        errorMessage : String(500);
        submittedAt  : Timestamp;
        confirmedAt  : Timestamp;
        finishedAt   : Timestamp;
    }

    @title      : 'Worker Status'
    type WorkerStatus {
        running              : Boolean;
        wallets              : many String;
        executing            : many String;
        awaitingConfirmation : Integer;
        pendingJobs          : Integer;
    }

    /** Terminal job outcome. Subscribe in process, or wait over HTTP with GetJobStatus(waitMs). */
    event jobConfirmed {
        jobId    : UUID;
        walletId : String(50);
        kind     : String(12);
        txHash   : String(64);
    }

    event jobFailed {
        jobId        : UUID;
        walletId     : String(50);
        kind         : String(12);
        txHash       : String(64);   // null when the job never reached the chain
        errorCode    : String(50);
        errorMessage : String(500);
    }

    @title      : 'Submit Wallet Job'
    @description: 'Queue an asynchronous transaction job for a worker wallet. Returns immediately with a jobId; poll GetJobStatus for the outcome. The request JSON is the same payload shape as the corresponding Build* action; senderAddress is always overridden with the wallet address. A retry with the same idempotencyKey and request returns the job that holds the key; another request under that key is a 409.'
    @odatano.agent: 'operator'
    action SubmitWalletJob(
        @title: 'Wallet Id'          walletId       : String(50),
        @title: 'Job Kind'           @assert.range  kind : WalletJobKind,
        @title: 'Request JSON'       requestJson    : LargeString,
        @title: 'Idempotency Key'    idempotencyKey : String(100),
        @title: 'Priority'           @assert.range: [0, 10000] priority : Integer,
        @title: 'Not Before'         notBefore      : Timestamp
    ) returns JobSubmissionResult;

    @title      : 'Cancel Job'
    @description: 'Cancel a still-pending job. Jobs that started building may already reach the chain and cannot be cancelled.'
    @odatano.agent: 'operator'
    action CancelJob(
        @title: 'Job Id' jobId : UUID
    ) returns Boolean;

    @title      : 'Get Job Status'
    @description: 'Current lifecycle state of a wallet job (non-admins: own jobs only). With waitMs the call answers as soon as the job is confirmed, failed or cancelled, or after that time with the state it has then. Keep waitMs below the timeout of the proxies in front of the service.'
    @odatano.agent: 'operator'
    function GetJobStatus(
        @title: 'Job Id' jobId : UUID,
        @title: 'Wait (ms)' @assert.range: [0, 30000] waitMs : Integer
    ) returns JobStatus;

    @title      : 'Get Worker Status'
    @description: 'Live worker summary: running state, wallets, in-flight executions, confirmation backlog, queue depth'
    @odatano.agent: 'operator'
    function GetWorkerStatus() returns WorkerStatus;

    @title      : 'Pause Worker'
    @description: 'Stop the local worker instance (finishes in-flight steps; queued jobs stay pending).'
    @requires   : 'Admin'
    @odatano.agent: 'operator'
    action PauseWorker()  returns Boolean;

    @title      : 'Resume Worker'
    @description: 'Start/restart the local worker instance using the configured wallets.'
    @requires   : 'Admin'
    @odatano.agent: 'operator'
    action ResumeWorker() returns Boolean;
}
