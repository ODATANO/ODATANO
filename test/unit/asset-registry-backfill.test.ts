/**
 * CIP-26 registry backfill (srv/blockchain/crawler/asset-registry-backfill.ts) against a tiny
 * in-memory Assets store: the backend lists the registered units, each one is re-indexed from the
 * backend, every slice of the unit receives the registry values, decimals only where still empty.
 */

type Row = Record<string, unknown>;

const assets: Row[] = [];
const matches = (r: Row, where: Row): boolean =>
  Object.entries(where).every(([k, v]) => (v === null ? r[k] == null : r[k] === v));

const fakeTx = {
  run: vi.fn(async (q: Row) => {
    if (q._op !== 'UPDATE') return undefined;
    let n = 0;
    for (const r of assets) if (matches(r, q.where as Row)) { Object.assign(r, q.set); n++; }
    return n;
  }),
};

vi.mock('@sap/cds', () => {
  const cdsMock = {
    log: vi.fn(() => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() })),
    tx: async (fn: (tx: typeof fakeTx) => unknown) => fn(fakeTx),
    ql: {
      UPDATE: { entity: (entity: string) => ({ set: (set: unknown) => ({ where: (where: unknown) => ({ _op: 'UPDATE', entity, set, where }) }) }) },
    },
  };
  return { default: cdsMock, ...cdsMock };
});

vi.mock('#cds-models/odatano/cardano', () => ({ Assets: 'Assets' }));

import { backfillAssetRegistry } from '../../srv/blockchain/crawler/asset-registry-backfill';
import { NotFoundError, ProviderUnavailableError } from '../../srv/utils/errors';
import type { CardanoClient } from '../../srv/blockchain/cardano-client';
import type { CardanoIndexer } from '../../srv/blockchain/cardano-indexer';

const POLICY = 'a'.repeat(56);
const MIN = `${POLICY}4d494e`;
const NIGHT = `${POLICY}4e49474854`;
const BARE = '1970-01-01T00:00:00.000Z';

const registry: Record<string, Row> = {
  [MIN]: { registryName: 'Minswap', registryTicker: 'MIN', registryDecimals: 6, registryDescription: null, registryUrl: null, registryLogo: null, decimals: 6 },
  // decimals come from the CIP-68 datum here, the registry value differs
  [NIGHT]: { registryName: 'Night', registryTicker: 'NIGHT', registryDecimals: 6, registryDescription: 'd', registryUrl: 'u', registryLogo: null, decimals: 8 },
};

function setup(units: string[], failing: Record<string, Error> = {}) {
  const indexer = {
    indexAssetFromBackend: vi.fn(async (_tx: unknown, unit: string) => {
      if (failing[unit]) throw failing[unit];
      const row = { unit, ...registry[unit], validFrom: '2026-11-04T00:00:00.000Z', validTo: '2026-11-05T00:00:00.000Z' };
      assets.push({ ...row });
      return row;
    }),
  };
  const client = {
    getTokenRegistryBackend: () => ({ getTokenRegistryUnits: async () => units }),
  };
  return { indexer, client, run: (onProgress?: (p: unknown) => void) => backfillAssetRegistry({
    client: client as unknown as CardanoClient, indexer: indexer as unknown as CardanoIndexer, unitsPerSecond: 1000, onProgress,
  }) };
}

beforeEach(() => {
  assets.length = 0;
  fakeTx.run.mockClear();
});

describe('backfillAssetRegistry', () => {
  it('writes the registry values to every slice of a registered unit and fills decimals only where empty', async () => {
    assets.push(
      { unit: MIN, validFrom: BARE, validTo: BARE, registryTicker: null, decimals: null },
      { unit: MIN, validFrom: '2026-01-01T00:00:00.000Z', validTo: '2026-01-02T00:00:00.000Z', registryTicker: null, decimals: null },
      { unit: NIGHT, validFrom: BARE, validTo: BARE, registryTicker: null, decimals: 8 },
      { unit: `${POLICY}00`, validFrom: BARE, validTo: BARE, registryTicker: null, decimals: null },
    );
    const { indexer, run } = setup([MIN, NIGHT]);
    const seen: unknown[] = [];

    const result = await run((p) => seen.push(p));

    expect(result).toEqual({ units: 2, processed: 2, filled: 2, failed: 0 });
    expect(seen).toHaveLength(2);
    expect(indexer.indexAssetFromBackend).toHaveBeenCalledTimes(2);
    const min = assets.filter((r) => r.unit === MIN);
    expect(min).toHaveLength(3);
    for (const r of min) expect(r).toMatchObject({ registryName: 'Minswap', registryTicker: 'MIN', registryDecimals: 6, decimals: 6 });
    const nightBare = assets.find((r) => r.unit === NIGHT && r.validFrom === BARE);
    // the bare row keeps its datum decimals, the registry value lands in registryDecimals only
    expect(nightBare).toMatchObject({ registryTicker: 'NIGHT', registryDecimals: 6, decimals: 8 });
    expect(assets.find((r) => r.unit === `${POLICY}00`)).toMatchObject({ registryTicker: null, decimals: null });
  });

  it('counts a unit the backend does not know and carries on', async () => {
    const { run } = setup([MIN, NIGHT], { [MIN]: new NotFoundError('Asset', 'koios') });

    expect(await run()).toEqual({ units: 2, processed: 2, filled: 1, failed: 1 });
  });

  it('stops after 25 consecutive backend failures', async () => {
    const units = Array.from({ length: 30 }, (_, i) => `${POLICY}${i.toString(16).padStart(2, '0')}`);
    const failing = Object.fromEntries(units.map((u) => [u, new ProviderUnavailableError('down', 'koios')]));
    const { indexer, run } = setup(units, failing);

    await expect(run()).rejects.toThrow(/25 units in a row failed/);
    expect(indexer.indexAssetFromBackend).toHaveBeenCalledTimes(25);
  });

  it('refuses without a backend that lists the registry', async () => {
    const client = { getTokenRegistryBackend: () => null } as unknown as CardanoClient;

    await expect(backfillAssetRegistry({ client, indexer: {} as CardanoIndexer })).rejects.toThrow(/needs Koios/);
  });
});
