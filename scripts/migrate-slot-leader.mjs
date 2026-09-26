#!/usr/bin/env node
// Rewrite Blocks.slotLeader values written before it became the bech32 pool id: an Ogmios
// issuer key (64 hex chars) becomes bech32('pool', blake2b-224(key)); a Koios VRF key
// (vrf_vk1…) is matched on blake2b-256 against the pools' registered VRF key hashes, taken
// from an Ogmios `queryLedgerState/stakePools` response. Prints SQL; the database is not touched.
//
//   psql -Atc "SELECT DISTINCT slotLeader FROM odatano_cardano_Blocks WHERE slotLeader NOT LIKE 'pool1%'" \
//     | node scripts/migrate-slot-leader.mjs [--stake-pools stake-pools.json] [--extra-map extra.txt] > slot-leader.sql
//
// The SQL fills a mapping table and runs one UPDATE (PostgreSQL and SQLite). Values that cannot
// be mapped (a VRF key of a pool no longer registered, unknown formats) are listed on stderr
// and left unchanged; `--extra-map` supplies them as "<old value> <pool id>" lines.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { bech32 } from 'bech32';
import { blake2b_224, blake2b_256 } from '@harmoniclabs/crypto';

const toHex = (bytes) => Buffer.from(bytes).toString('hex');
const lines = (text) => text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

/** VRF key hash (hex) -> pool id, from an Ogmios stakePools response (whole JSON-RPC reply or its result). */
export function vrfMapFromStakePools(response) {
    const pools = response?.result ?? response ?? {};
    const map = new Map();
    for (const [id, pool] of Object.entries(pools)) {
        const vrf = pool?.vrfVerificationKeyHash;
        if (typeof vrf === 'string') map.set(vrf.toLowerCase(), pool.id ?? id);
    }
    return map;
}

/** "<old value> <pool id>" lines to a Map; lines starting with # are skipped. */
export function parseExtraMap(text) {
    const map = new Map();
    for (const line of lines(text)) {
        if (line.startsWith('#')) continue;
        const [from, to] = line.split(/\s+/);
        if (!to?.startsWith('pool1')) throw new Error(`extra map: no pool id for ${from}`);
        map.set(from, to);
    }
    return map;
}

/** Bech32 pool id for an old slotLeader value, or null when it cannot be derived. */
export function slotLeaderToPoolId(value, vrfMap = new Map()) {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    if (/^[0-9a-f]{64}$/i.test(v)) {
        return bech32.encode('pool', bech32.toWords(blake2b_224(Uint8Array.from(Buffer.from(v, 'hex')))));
    }
    if (v.startsWith('vrf_vk1')) {
        const { words } = bech32.decode(v, 120);
        const vrfHash = toHex(blake2b_256(Uint8Array.from(bech32.fromWords(words))));
        return vrfMap.get(vrfHash) ?? null;
    }
    return null;
}

const sqlString = (s) => `'${s.replace(/'/g, "''")}'`;

/** SQL that rewrites every mapped value in one UPDATE; empty string when nothing maps. */
export function migrationSql(mapping) {
    if (mapping.size === 0) return '';
    const rows = [...mapping].map(([from, to]) => `  (${sqlString(from)}, ${sqlString(to)})`);
    return [
        'BEGIN;',
        'CREATE TEMPORARY TABLE slot_leader_map (old_value VARCHAR(200) PRIMARY KEY, new_value VARCHAR(120) NOT NULL);',
        `INSERT INTO slot_leader_map (old_value, new_value) VALUES\n${rows.join(',\n')};`,
        'UPDATE odatano_cardano_Blocks',
        '  SET slotLeader = (SELECT m.new_value FROM slot_leader_map m WHERE m.old_value = odatano_cardano_Blocks.slotLeader)',
        '  WHERE slotLeader IN (SELECT old_value FROM slot_leader_map);',
        'DROP TABLE slot_leader_map;',
        'COMMIT;',
        '',
    ].join('\n');
}

function argValue(name) {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

function main() {
    const stakePoolsFile = argValue('--stake-pools');
    const extraMapFile = argValue('--extra-map');
    const vrfMap = stakePoolsFile ? vrfMapFromStakePools(JSON.parse(fs.readFileSync(stakePoolsFile, 'utf8'))) : new Map();
    const extraMap = extraMapFile ? parseExtraMap(fs.readFileSync(extraMapFile, 'utf8')) : new Map();

    const values = [...new Set(lines(fs.readFileSync(0, 'utf8')))];
    const mapping = new Map();
    const unmapped = [];
    for (const v of values) {
        if (v.startsWith('pool1')) continue;
        const poolId = extraMap.get(v) ?? slotLeaderToPoolId(v, vrfMap);
        if (poolId) mapping.set(v, poolId);
        else unmapped.push(v);
    }

    process.stdout.write(migrationSql(mapping));
    console.error(`slotLeader values: ${values.length} read, ${mapping.size} mapped, ${unmapped.length} left unchanged`);
    for (const v of unmapped) console.error(`  unmapped: ${v}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
