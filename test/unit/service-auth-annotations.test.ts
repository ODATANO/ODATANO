/**
 * Auth layout of the two services with one anonymous operation each
 * (CardanoIndexerService.getLiveness, CardanoSignService.VerifyDataSignature), pinned on the model.
 *
 * CAP checks a service-level `@requires` before the operation's own, so `@requires: 'any'` on one
 * operation cannot open it on an otherwise authenticated service; the requirement sits on each element.
 * Auto-exposed entities need none: a direct request gets 405, a navigation is authorized on the
 * right-most non-autoexposed entity. The integration suite runs as cds.User.Privileged and cannot catch this.
 */

import cds from '@sap/cds';
import path from 'path';

type Def = Record<string, unknown> & { kind?: string };

async function definitionsOf(file: string): Promise<Record<string, Def>> {
  const csn = await cds.load(path.resolve(__dirname, '../../srv', file));
  return csn.definitions as unknown as Record<string, Def>;
}

/**
 * Every entity / action / function of `svc` except the auto-exposed ones must
 * carry `@requires` or `@restrict`; exactly `anonymous` may be 'any'.
 */
function expectElementLevelAuth(defs: Record<string, Def>, svc: string, anonymous: string[]): void {
  const service = defs[svc]!;
  expect(service.kind).toBe('service');
  // 'any' at the service level: in production CAP treats a service without a service-level
  // @requires as authenticated-user, which would 401 the anonymous operation despite its own 'any'.
  expect(service['@requires']).toBe('any');
  expect(service['@restrict']).toBeUndefined();

  const own = Object.entries(defs).filter(
    ([n, d]) => n.startsWith(`${svc}.`) && ['entity', 'action', 'function'].includes(String(d.kind))
  );
  const autoExposed = own.filter(([, d]) => d['@cds.autoexposed'] === true);
  const explicit = own.filter(([, d]) => d['@cds.autoexposed'] !== true);

  // Auto-exposed: never opened for direct access (that would be a 200 for anyone).
  for (const [name, d] of autoExposed) expect(d['@cds.autoexpose'], `${name} must not be @cds.autoexpose`).toBeUndefined();

  const isAny = ([, d]: [string, Def]) => d['@requires'] === 'any';
  const unguarded = explicit.filter(([, d]) => d['@requires'] === undefined && d['@restrict'] === undefined).map(([n]) => n);
  expect(unguarded).toEqual([]);
  expect(explicit.filter(isAny).map(([n]) => n).sort()).toEqual(anonymous.map((a) => `${svc}.${a}`).sort());
}

describe('CardanoIndexerService auth annotations', () => {
  const SVC = 'CardanoIndexerService';
  let defs: Record<string, Def>;
  beforeAll(async () => { defs = await definitionsOf('cardano-indexer-service.cds'); });

  it("has no service-level @requires; the two probes alone are 'any'", () => {
    expectElementLevelAuth(defs, SVC, ['getLiveness', 'getReadiness']);
    expect(defs[`${SVC}.getLiveness`]!.kind).toBe('function');
    expect(defs[`${SVC}.getReadiness`]!.kind).toBe('function');
  });

  it('keeps every other element behind a role: entities and getStatus need Read, pause/resume need Admin', () => {
    expect(defs[`${SVC}.SyncState`]!['@requires']).toBe('Read');
    expect(defs[`${SVC}.ReorgLog`]!['@requires']).toBe('Read');
    expect(defs[`${SVC}.getStatus`]!['@requires']).toBe('Read');
    expect(defs[`${SVC}.pauseCrawler`]!['@requires']).toBe('Admin');
    expect(defs[`${SVC}.resumeCrawler`]!['@requires']).toBe('Admin');
  });
});

describe('CardanoSignService auth annotations', () => {
  const SVC = 'CardanoSignService';
  let defs: Record<string, Def>;
  beforeAll(async () => { defs = await definitionsOf('cardano-sign-service.cds'); });

  it("has no service-level @requires; VerifyDataSignature (the CIP-30 check behind wallet login) alone is 'any'", () => {
    expectElementLevelAuth(defs, SVC, ['VerifyDataSignature']);
    expect(defs[`${SVC}.VerifyDataSignature`]!.kind).toBe('action');
  });

  it('keeps the signing workflow, the HSM actions and every projection behind Sign', () => {
    for (const e of ['SignatureVerifications', 'AddressSigningRequests', 'TransactionBuilds', 'TransactionSubmissions', 'SigningRequests']) {
      expect(defs[`${SVC}.${e}`]!['@requires'], e).toBe('Sign');
    }
    for (const a of ['VerifySignature', 'SubmitVerifiedTransaction', 'CreateSigningRequest', 'GetSigningRequest',
      'GetSigningRequestsByAddress', 'SignWithHsm', 'SignAndSubmitWithHsm', 'GetHsmStatus']) {
      expect(defs[`${SVC}.${a}`]!['@requires'], a).toBe('Sign');
    }
  });
});

describe('service roles', () => {
  // The role every request to the service needs, checked before any operation's own requirement.
  const SERVICE_ROLE: Array<[file: string, service: string, role: string]> = [
    ['cardano-service.cds', 'CardanoODataService', 'Read'],
    ['cardano-backend-service.cds', 'CardanoBackendService', 'Read'],
    ['cardano-tx-service.cds', 'CardanoTransactionService', 'Transact'],
    ['cardano-worker-service.cds', 'CardanoWorkerService', 'Transact'],
    ['cardano-agent-service.cds', 'CardanoAgentService', 'authenticated-user'],
  ];

  it.each(SERVICE_ROLE)('%s: %s needs %s', async (file, service, role) => {
    const defs = await definitionsOf(file);
    expect(defs[service]!['@requires']).toBe(role);
  });

  it('asks for Transact on the two backend operations that evaluate or send a transaction', async () => {
    const defs = await definitionsOf('cardano-backend-service.cds');
    const transact = Object.entries(defs)
      .filter(([name, d]) => name.startsWith('CardanoBackendService.') && d['@requires'] === 'Transact')
      .map(([name]) => name.split('.')[1]);
    expect(transact.sort()).toEqual(['EvaluateTransaction', 'SubmitTransaction']);
  });

  it('no model element asks for a mere login except the agent service', async () => {
    const loose: string[] = [];
    for (const file of ['cardano-service.cds', 'cardano-backend-service.cds', 'cardano-tx-service.cds', 'cardano-worker-service.cds',
      'cardano-sign-service.cds', 'cardano-indexer-service.cds']) {
      const defs = await definitionsOf(file);
      for (const [name, d] of Object.entries(defs)) if (d['@requires'] === 'authenticated-user') loose.push(name);
    }
    expect(loose).toEqual([]);
  });
});
