/**
 * Reward-account registration on the live preview backends, backend by backend: a registered key
 * credential, a registered script credential that never delegated (the withdraw-zero case) and a
 * never registered script credential, through getAccount, the client's registration check and
 * BuildPlutusTransaction with withdrawalsJson. Needs Ogmios at OGMIOS_URL (synced) and
 * BLOCKFROST_API_KEY; a configuration without its prerequisite is skipped.
 */

import cds from '@sap/cds';
// Native require: shares the module graph with the booted CAP server.
const { createTestContext, resetAppContext, shutdownAppContext, getCardanoClient } =
  require('../../srv/server') as typeof import('../../srv/server');
import { TEST_FIXTURES } from './test-fixtures';

vi.setConfig({ testTimeout: 90000, hookTimeout: 90000 });

process.env.SKIP_AUTO_INIT = 'true';
process.env.OGMIOS_URL = process.env.OGMIOS_URL || 'ws://localhost:1337';

type Ctx = { skip: () => void };
type BackendName = 'ogmios' | 'blockfrost' | 'koios';

const REGISTERED_KEY = TEST_FIXTURES.validStakeAddress;
const REGISTERED_SCRIPT = TEST_FIXTURES.scriptStakeAddress;
const UNREGISTERED_SCRIPT = TEST_FIXTURES.unregisteredScriptStakeAddress;
const WITHDRAW_SCRIPT = TEST_FIXTURES.withdrawScriptStakeAddress;
const UNREGISTERED_WITHDRAW_SCRIPT = TEST_FIXTURES.unregisteredWithdrawScriptStakeAddress;
const UNIT_REDEEMER = JSON.stringify({ constructor: 0, fields: [] });

/** A refused getAccount: the client wraps the 404 of every backend into one error. */
const notFound = (outcome: unknown) => (outcome as { statusCode?: number } | null)?.statusCode === 404;

/** Ogmios must be connected and at the tip; a syncing node serves stale ledger state. */
async function ogmiosReady(): Promise<boolean> {
  const url = (process.env.OGMIOS_URL as string).replace(/^ws/, 'http') + '/health';
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return false;
    const h = await res.json() as { connectionStatus?: string; networkSynchronization?: number };
    return h.connectionStatus === 'connected' && (h.networkSynchronization ?? 0) > 0.99;
  } catch {
    return false;
  }
}

async function available(backends: BackendName[]): Promise<boolean> {
  for (const b of backends) {
    if (b === 'ogmios' && !(await ogmiosReady())) return false;
    if (b === 'blockfrost' && !process.env.BLOCKFROST_API_KEY) return false;
  }
  return true;
}

const withdrawZero = (rewardAddress: string, stakingScript: string, scriptParams?: unknown[]) => ({
  senderAddress: TEST_FIXTURES.addressWithFunds,
  outputsJson: JSON.stringify([{ address: TEST_FIXTURES.addressWithFunds, lovelaceAmount: '2000000' }]),
  withdrawalsJson: JSON.stringify([{
    rewardAddress, lovelace: '0', stakingScript, redeemerJson: UNIT_REDEEMER,
    ...(scriptParams ? { scriptParamsJson: JSON.stringify(scriptParams) } : {}),
  }]),
});
const withdrawZeroRegistered = () => withdrawZero(WITHDRAW_SCRIPT, TEST_FIXTURES.unitScript, TEST_FIXTURES.withdrawScriptParams);

describe('reward-account registration (integration: live preview backends)', () => {
  const test = cds.test(__dirname + '/../../');
  const expect = test.expect;

  /** Boots the app context for `backends`; false when a prerequisite is missing. */
  async function boot(backends: BackendName[]): Promise<boolean> {
    if (!(await available(backends))) return false;
    resetAppContext(await createTestContext(backends));
    return true;
  }

  describe.each<BackendName>(['ogmios', 'blockfrost', 'koios'])('%s alone', (backend) => {
    let ready = false;
    // Ogmios up to 7.0.0 lists only credentials delegated to a pool or a DRep; a build with the
    // upstream fix answers every registered credential
    let nodeListsUndelegated = true;
    beforeAll(async () => {
      ready = await boot([backend]);
      if (ready && backend === 'ogmios') {
        nodeListsUndelegated = !notFound(await getCardanoClient().getAccount(REGISTERED_SCRIPT).catch((err: unknown) => err));
      }
    });
    afterAll(async () => { if (ready) await shutdownAppContext(); });

    it('getAccount: a registered key credential is active', async (ctx: Ctx) => {
      if (!ready) return ctx.skip();
      expect((await getCardanoClient().getAccount(REGISTERED_KEY)).active).to.equal(true);
    });

    it('getAccount: a registered script credential that never delegated', async (ctx: Ctx) => {
      if (!ready) return ctx.skip();
      const outcome = await getCardanoClient().getAccount(REGISTERED_SCRIPT).catch((err: unknown) => err);
      if (!nodeListsUndelegated) {
        expect(notFound(outcome), String(outcome)).to.equal(true);
      } else {
        expect((outcome as { active: boolean }).active, String(outcome)).to.equal(true);
      }
    });

    it('getAccount: a never registered script credential is not found or inactive', async (ctx: Ctx) => {
      if (!ready) return ctx.skip();
      const account = await getCardanoClient().getAccount(UNREGISTERED_SCRIPT).catch((err: unknown) => err);
      if (notFound(account)) return;
      expect((account as { active: boolean }).active, String(account)).to.equal(false);
    });

    it('isRewardAccountRegistered: key true, undelegated script true or unknown, unregistered script false or unknown', async (ctx: Ctx) => {
      if (!ready) return ctx.skip();
      const client = getCardanoClient();
      expect(await client.isRewardAccountRegistered(REGISTERED_KEY)).to.equal(true);
      // a node that drops undelegated credentials cannot tell, alone
      expect(await client.isRewardAccountRegistered(REGISTERED_SCRIPT)).to.equal(nodeListsUndelegated ? true : null);
      expect(await client.isRewardAccountRegistered(UNREGISTERED_SCRIPT)).to.equal(backend === 'ogmios' ? null : false);
    });

    it('BuildPlutusTransaction: withdraw-zero from the registered script builds', async (ctx: Ctx) => {
      if (!ready) return ctx.skip();
      const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildPlutusTransaction',
        withdrawZeroRegistered());
      expect(status, JSON.stringify(data)).to.equal(200);
      expect(data.unsignedTxCbor).to.match(/^84/);
    });
  });

  describe('ogmios, blockfrost and koios together', () => {
    let ready = false;
    beforeAll(async () => { ready = await boot(['ogmios', 'blockfrost', 'koios']); });
    afterAll(async () => { if (ready) await shutdownAppContext(); });

    it('the node has no summary for the undelegated script, a provider confirms the registration', async (ctx: Ctx) => {
      if (!ready) return ctx.skip();
      expect(await getCardanoClient().isRewardAccountRegistered(REGISTERED_SCRIPT)).to.equal(true);
      expect(await getCardanoClient().isRewardAccountRegistered(UNREGISTERED_SCRIPT)).to.equal(false);
    });

    it('GetAccountByStakeAddress answers the undelegated script credential', async (ctx: Ctx) => {
      if (!ready) return ctx.skip();
      const { status, data } = await test.post('/odata/v4/cardano-odata/GetAccountByStakeAddress', { stakeAddress: REGISTERED_SCRIPT });
      expect(status).to.equal(200);
      expect(data.active).to.equal(true);
    });

    it('withdraw-zero from the registered script builds', async (ctx: Ctx) => {
      if (!ready) return ctx.skip();
      const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildPlutusTransaction',
        withdrawZeroRegistered());
      expect(status, JSON.stringify(data)).to.equal(200);
      expect(data.unsignedTxCbor).to.match(/^84/);
    });

    it('a withdrawal from a never registered script is refused with the account named', async (ctx: Ctx) => {
      if (!ready) return ctx.skip();
      const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildPlutusTransaction',
        withdrawZero(UNREGISTERED_SCRIPT, TEST_FIXTURES.validSpendingScript)).catch((err: { response: { status: number; data: unknown } }) => err.response);
      expect(status).to.equal(400);
      expect(data.error.message).to.include(`withdrawals[0] reward account ${UNREGISTERED_SCRIPT} is not registered on chain`);
    });

    it('a registration certificate in the same transaction skips the check', async (ctx: Ctx) => {
      if (!ready) return ctx.skip();
      const { status, data } = await test.post('/odata/v4/cardano-transaction/BuildPlutusTransaction', {
        ...withdrawZero(UNREGISTERED_WITHDRAW_SCRIPT, TEST_FIXTURES.unitScript, TEST_FIXTURES.unregisteredWithdrawScriptParams),
        certificatesJson: JSON.stringify([{ type: 'registerStake', stakeAddress: UNREGISTERED_WITHDRAW_SCRIPT }]),
      });
      expect(status, JSON.stringify(data)).to.equal(200);
      expect(data.unsignedTxCbor).to.match(/^84/);
    });
  });
});
