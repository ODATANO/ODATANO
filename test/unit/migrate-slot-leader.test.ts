import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { slotLeaderToPoolId, vrfMapFromStakePools, parseExtraMap, migrationSql } from '../../scripts/migrate-slot-leader.mjs';

const SCRIPT = path.resolve(__dirname, '../../scripts/migrate-slot-leader.mjs');

// preview block cea2ec57…: issuer key -> pool, confirmed by Koios /block_info
const ISSUER_KEY = 'bf55661898d4b7c66caf7106c4e45caacd8f51265cf0dc61dabf6dd12fb5d952';
const ISSUER_POOL = 'pool1p0mrcmu9qn0x6nk4eunj0p8qy3tryv370a96u9su2l6jwkytnru';
// preprod: VRF key of a block -> pool with that registered VRF key hash, confirmed by Koios
const VRF_KEY = 'vrf_vk18xtl3n0yawku3xflkrnnez98qk8vpzdxxywvr7fs8z9ez98u8jvs99znjq';
const VRF_POOL = 'pool13la5erny3srx9u4fz9tujtl2490350f89r4w4qjhk0vdjmuv78v';
const STAKE_POOLS = {
  jsonrpc: '2.0',
  result: { [VRF_POOL]: { id: VRF_POOL, vrfVerificationKeyHash: '41f661fcc0ee3e16b3c4105f993c169c89846bb77200bfb81ac15cac1eb38c6a' } },
};

describe('scripts/migrate-slot-leader.mjs', () => {
  it('derives the pool id from an issuer key', () => {
    expect(slotLeaderToPoolId(ISSUER_KEY)).toBe(ISSUER_POOL);
  });

  it('maps a VRF key through the registered VRF key hashes', () => {
    expect(slotLeaderToPoolId(VRF_KEY, vrfMapFromStakePools(STAKE_POOLS))).toBe(VRF_POOL);
    expect(slotLeaderToPoolId(VRF_KEY)).toBeNull();
  });

  it('leaves unknown formats unmapped', () => {
    expect(slotLeaderToPoolId('leader')).toBeNull();
    expect(slotLeaderToPoolId('')).toBeNull();
  });

  it('parses extra mappings and rejects a line without a pool id', () => {
    expect(parseExtraMap(`# comment\n${VRF_KEY} ${VRF_POOL}\n`)).toEqual(new Map([[VRF_KEY, VRF_POOL]]));
    expect(() => parseExtraMap(`${VRF_KEY} nope`)).toThrow(/no pool id/);
  });

  it('produces SQL that rewrites only the mapped values', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE odatano_cardano_Blocks (hash TEXT PRIMARY KEY, slotLeader TEXT)');
    db.exec(`INSERT INTO odatano_cardano_Blocks VALUES ('b1', '${ISSUER_KEY}'), ('b2', '${ISSUER_KEY}'), ('b3', '${VRF_POOL}'), ('b4', 'unknown')`);

    db.exec(migrationSql(new Map([[ISSUER_KEY, ISSUER_POOL]])));

    const rows = db.prepare('SELECT hash, slotLeader FROM odatano_cardano_Blocks ORDER BY hash').all();
    expect(rows).toEqual([
      { hash: 'b1', slotLeader: ISSUER_POOL },
      { hash: 'b2', slotLeader: ISSUER_POOL },
      { hash: 'b3', slotLeader: VRF_POOL },
      { hash: 'b4', slotLeader: 'unknown' },
    ]);
    expect(migrationSql(new Map())).toBe('');
  });

  it('CLI: reads values from stdin, prints SQL and reports unmapped values', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { input: `${ISSUER_KEY}\n${VRF_POOL}\nweird\n`, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`('${ISSUER_KEY}', '${ISSUER_POOL}')`);
    expect(r.stderr).toContain('3 read, 1 mapped, 1 left unchanged');
    expect(r.stderr).toContain('unmapped: weird');
  });
});
