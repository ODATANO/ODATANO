using {odatano.cardano as db} from '../db/schema';

// Agent grants: scoped, budgeted bearer tokens an Admin issues instead of a full user.
// A token request runs as `agent:<grantId>` with the role `agent-grant`, so every Admin gate refuses it.
// The allow list, wallet binding and daily budget are enforced in srv/utils/agent-grants.ts.
@requires: 'authenticated-user'
service CardanoAgentService @(impl: './cardano-agent-service') {

    @readonly
    @title      : 'Agent Grants'
    @description: 'Issued grants (token hash excluded). Admins see all, a token sees its own row.'
    @restrict   : [
        { grant: 'READ', to: 'Admin' },
        { grant: 'READ', to: 'agent-grant', where: 'ID = $user.grantId' }
    ]
    entity AgentGrants as projection on db.CardanoAgentGrants excluding { tokenHash };

    @title      : 'Grant Status'
    type GrantStatus {
        grantId         : UUID;
        agentLabel      : String(100);
        allowedActions  : many String;
        walletId        : String(50);
        allowedJobKinds : many String;
        maxJobsPerDay   : Integer;
        jobsUsedToday   : Integer;
        budgetWindow    : String(10);
        validUntil      : Timestamp;
        isActive        : Boolean;
    }

    @title      : 'Issued Grant'
    type IssuedGrant {
        grantId         : UUID;
        token           : String; // shown once, never stored
        allowedActions  : many String;
        walletId        : String(50);
        allowedJobKinds : many String;
        maxJobsPerDay   : Integer;
        validUntil      : Timestamp;
    }

    @title      : 'Get Grant Status'
    @description: 'The calling token''s own grant: allow list, wallet, remaining daily budget, expiry. 400 without a token; an operator lists AgentGrants instead.'
    function GetGrantStatus() returns GrantStatus;

    @title      : 'Create Agent Grant'
    @description: 'Issue a scoped bearer token for an agent. Admin only. The token is returned once and stored as SHA-256. allowedActions must be a non-empty subset of the grantable set; walletId is required when SubmitWalletJob or CancelJob is allowed.'
    @requires   : 'Admin'
    action CreateAgentGrant(
        @title: 'Allowed Actions'   allowedActions  : many String,
        @title: 'Wallet Id'         walletId        : String(50),
        @title: 'Allowed Job Kinds' allowedJobKinds : many String,
        @title: 'Max Jobs Per Day'  maxJobsPerDay   : Integer,
        @title: 'Valid Until'       validUntil      : Timestamp,
        @title: 'Agent Label'       agentLabel      : String(100)
    ) returns IssuedGrant;

    @title      : 'Revoke Agent Grant'
    @description: 'Deactivate a grant. Admin only. Its token becomes an unknown token immediately.'
    @requires   : 'Admin'
    action RevokeAgentGrant(
        @title: 'Grant Id' grantId : UUID
    ) returns Boolean;

    @title      : 'Rotated Grant'
    type RotatedGrant {
        grantId : UUID;
        token   : String; // shown once, never stored
    }

    @title      : 'Rotate Agent Grant Token'
    @description: 'Replace the grant token; the old token is unknown from the next request. Budget, wallet, allow list and expiry survive. Admin only. 404 when the grant does not exist or is revoked.'
    @requires   : 'Admin'
    action RotateAgentGrantToken(
        @title: 'Grant Id' grantId : UUID
    ) returns RotatedGrant;

    @title      : 'Updated Grant'
    type UpdatedGrant {
        grantId : UUID;
        updated : many String; // parameter names that were applied
    }

    @title      : 'Update Agent Grant'
    @description: 'Change label, allow list, job kinds, daily budget or expiry of an active grant. An absent parameter stays as it is; an explicit null clears agentLabel, allowedJobKinds, maxJobsPerDay or validUntil. allowedActions cannot be emptied; the wallet binding is immutable (issue a new grant). Admin only. 404 unknown grant, 409 GRANT_REVOKED.'
    @requires   : 'Admin'
    action UpdateAgentGrant(
        @title: 'Grant Id'          grantId         : UUID,
        @title: 'Agent Label'       agentLabel      : String(100),
        @title: 'Allowed Actions'   allowedActions  : many String,
        @title: 'Allowed Job Kinds' allowedJobKinds : many String,
        @title: 'Max Jobs Per Day'  maxJobsPerDay   : Integer,
        @title: 'Valid Until'       validUntil      : Timestamp
    ) returns UpdatedGrant;

    @title      : 'Grant Usage Call'
    type GrantUsageCall {
        service  : String(60);  // CardanoTransactionService, CardanoSignService, ...
        action   : String(100); // BuildSimpleAdaTransaction, SubmitTransaction, ...
        count    : Integer;     // admitted and kept (budget charged and not refunded)
        refunded : Integer;     // admitted, then refunded because the handler refused the input
    }

    @title      : 'Grant Usage'
    type GrantUsage {
        grantId       : UUID;
        since         : Timestamp;
        until         : Timestamp;
        calls         : many GrantUsageCall;
        total         : Integer;
        jobsUsedToday : Integer;
        maxJobsPerDay : Integer;
    }

    @title      : 'Get Grant Usage'
    @description: 'Admitted calls under a grant between since (default until - 30 days) and until (default now), at most 366 days, per UTC day, grouped by service and action. An Admin sees any grant (revoked ones keep their history); a token sees only its own.'
    function GetGrantUsage(
        @title: 'Grant Id' grantId : UUID,
        @title: 'Since'    since   : Timestamp,
        @title: 'Until'    until   : Timestamp
    ) returns GrantUsage;
}
