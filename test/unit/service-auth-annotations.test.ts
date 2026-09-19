/**
 * The auth layout of the two services with ONE anonymous operation each
 * (CardanoIndexerService.getLiveness, CardanoSignService.VerifyDataSignature),
 * checked on the compiled model.
 *
 * CAP evaluates a SERVICE-level `@requires` on every request before it looks
 * at the operation, so an operation-level `@requires: 'any'` can never open a
 * single operation on an otherwise authenticated service: under basic/XSUAA
 * auth an anonymous caller gets the 401 challenge first (seen live on
 * 2.0.0-rc.6: the Docker HEALTHCHECK on getLiveness() answered 401). The
 * requirement therefore sits on each element. Auto-exposed entities (reached
 * through associations) carry none, and need none: CAP answers a direct
 * request on them with 405 (`@cds.autoexposed` without `@cds.autoexpose`) and
 * authorizes a navigation on the right-most non-autoexposed entity of the path.
 * The integration suite cannot catch a regression here — its unauthenticated
 * requests run as cds.User.Privileged — so this test pins the model shape.
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
  // 'any' at the service level: under NODE_ENV=production CAP treats a service
  // WITHOUT a service-level @requires as authenticated-user before it looks at
  // the operation, which would 401 the anonymous operation despite its own 'any'.
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

  it("has no service-level @requires; getLiveness() alone is 'any'", () => {
    expectElementLevelAuth(defs, SVC, ['getLiveness']);
    expect(defs[`${SVC}.getLiveness`]!.kind).toBe('function');
  });

  it('keeps every other element authenticated: entities and getStatus need a user, pause/resume need Admin', () => {
    expect(defs[`${SVC}.SyncState`]!['@requires']).toBe('authenticated-user');
    expect(defs[`${SVC}.ReorgLog`]!['@requires']).toBe('authenticated-user');
    expect(defs[`${SVC}.getStatus`]!['@requires']).toBe('authenticated-user');
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

  it('keeps the signing workflow, the HSM actions and every projection authenticated', () => {
    for (const e of ['SignatureVerifications', 'AddressSigningRequests', 'TransactionBuilds', 'TransactionSubmissions', 'SigningRequests']) {
      expect(defs[`${SVC}.${e}`]!['@requires'], e).toBe('authenticated-user');
    }
    for (const a of ['VerifySignature', 'SubmitVerifiedTransaction', 'CreateSigningRequest', 'GetSigningRequest',
      'GetSigningRequestsByAddress', 'SignWithHsm', 'SignAndSubmitWithHsm', 'GetHsmStatus']) {
      expect(defs[`${SVC}.${a}`]!['@requires'], a).toBe('authenticated-user');
    }
  });
});
