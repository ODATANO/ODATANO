using {odatano.cardano as db} from '../db/schema';

/**
 * Cardano Wallet Worker Service (v2.1)
 *
 * Control + observability surface for the wallet worker / job engine:
 * - job submission (async build → sign → submit → confirm from server-side wallets)
 * - job status polling + cancellation
 * - read-only projections of jobs and registered worker wallets
 * - pause/resume of the local worker instance (admin)
 *
 * Security note: SubmitWalletJob executes value transfers with server-held keys —
 * the service requires authentication throughout; control actions and foreign-job
 * visibility are gated behind the Admin role. Keys are NEVER accepted or exposed
 * through this surface.
 */
@requires: 'authenticated-user'
service CardanoWorkerService @(impl: './cardano-worker-service') {

    @readonly
    @title      : 'Wallet Jobs'
    @description: 'Asynchronous wallet-worker jobs. Non-admin callers see their own jobs only.'
    @restrict   : [
        { grant: 'READ', to: 'Admin' },
        { grant: 'READ', where: 'createdBy = $user' }
    ]
    entity WalletJobs     as projection on db.CardanoWalletJobs;

    @readonly
    @title      : 'Worker Wallets'
    @description: 'Registered server-side worker wallets (addresses and stats only — no key material, no lease internals)'
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

    @title      : 'Submit Wallet Job'
    @description: 'Queue an asynchronous transaction job for a worker wallet. Returns immediately with a jobId; poll GetJobStatus for the outcome. The request JSON is the same payload shape as the corresponding Build* action; senderAddress is always overridden with the wallet address.'
    action SubmitWalletJob(
        @title: 'Wallet Id'          walletId       : String(50),
        @title: 'Job Kind'           kind           : String(12),
        @title: 'Request JSON'       requestJson    : LargeString,
        @title: 'Idempotency Key'    idempotencyKey : String(100),
        @title: 'Priority'           priority       : Integer,
        @title: 'Not Before'         notBefore      : Timestamp
    ) returns JobSubmissionResult;

    @title      : 'Cancel Job'
    @description: 'Cancel a still-pending job. Jobs that started building may already reach the chain and cannot be cancelled.'
    action CancelJob(
        @title: 'Job Id' jobId : UUID
    ) returns Boolean;

    @title      : 'Get Job Status'
    @description: 'Current lifecycle state of a wallet job (non-admins: own jobs only)'
    function GetJobStatus(
        @title: 'Job Id' jobId : UUID
    ) returns JobStatus;

    @title      : 'Get Worker Status'
    @description: 'Live worker summary: running state, wallets, in-flight executions, confirmation backlog, queue depth'
    function GetWorkerStatus() returns WorkerStatus;

    @title      : 'Pause Worker'
    @description: 'Stop the local worker instance (finishes in-flight steps; queued jobs stay pending).'
    @requires   : 'Admin'
    action PauseWorker()  returns Boolean;

    @title      : 'Resume Worker'
    @description: 'Start/restart the local worker instance using the configured wallets.'
    @requires   : 'Admin'
    action ResumeWorker() returns Boolean;
}
