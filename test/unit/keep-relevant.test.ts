// DIST path on purpose: keepRelevant is not re-exported from the package root
// (only as a TxBuilder method); the standalone function lives in dist.
import { keepRelevant } from '@harmoniclabs/buildooor/dist/TxBuilder/keepRelevant';
import { Address, UTxO, Value, TxOut, TxOutRef, Hash28 } from '@harmoniclabs/cardano-ledger-ts';
import type { ITxBuildInput } from '@harmoniclabs/buildooor';

const TEST_ADDRESS = 'addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp';
const POLICY_ID = 'def68337867cb4f1f95b6b811fedbfcdd7780d10a95cc072077088ea';
const ASSET_NAME = '546f6b656e4d';
const ASSET_UNIT = POLICY_ID + ASSET_NAME;

/**
 * Upstream keepRelevant (fixed in buildooor 0.2.9, our PR) — regression tests
 * against the defects of the 0.2.6 implementation: lovelace matching the asset
 * filter (whole-set selection), tx-id-only dedup (sibling outputs collapse),
 * and number-based lovelace comparison (breaks above 2^53). Kept to catch any
 * upstream regression of the coin selection we depend on.
 */
describe('keepRelevant (buildooor coin selection)', () => {
  const input = (txHash: string, index: number, lovelace: bigint, assetQty?: bigint): ITxBuildInput => {
    let value = Value.lovelaces(lovelace);
    if (assetQty !== undefined) {
      value = Value.add(value, Value.singleAsset(
        new Hash28(POLICY_ID),
        Buffer.from(ASSET_NAME, 'hex'),
        assetQty
      ));
    }
    return {
      utxo: new UTxO({
        utxoRef: new TxOutRef({ id: txHash, index }),
        resolved: new TxOut({ address: Address.fromString(TEST_ADDRESS), value })
      })
    };
  };

  const refStrs = (selected: ITxBuildInput[]) =>
    selected.map(i => `${i.utxo.utxoRef.id.toString()}#${i.utxo.utxoRef.index}`).sort();

  it('selects smallest-first lovelace inputs until the request (plus minimum) is covered — not the whole set', () => {
    const pool = [
      input('aa'.repeat(32), 0, 100_000_000n),
      input('bb'.repeat(32), 0, 3_000_000n),
      input('cc'.repeat(32), 0, 200_000_000n),
    ];
    // 2 ADA requested + 5 ADA default minimum = 7 ADA → the 100 ADA input suffices;
    // the buggy version returned all three (every input "matches" lovelace).
    const selected = keepRelevant(Value.lovelaces(2_000_000n), pool);
    expect(refStrs(selected)).toEqual([`${'bb'.repeat(32)}#0`, `${'aa'.repeat(32)}#0`].sort());
  });

  it('selects the input holding a requested asset and skips unrelated asset inputs', () => {
    const pool = [
      input('aa'.repeat(32), 0, 2_000_000n, 5n),   // holds the requested asset
      input('bb'.repeat(32), 0, 50_000_000n),       // plain ADA
    ];
    const requested = Value.add(Value.lovelaces(1_000_000n), Value.singleAsset(
      new Hash28(POLICY_ID),
      Buffer.from(ASSET_NAME, 'hex'),
      1n
    ));
    const selected = keepRelevant(requested, pool);
    const refs = refStrs(selected);
    expect(refs).toContain(`${'aa'.repeat(32)}#0`);
    // ADA input added because the asset input's 2 ADA does not cover 1 + 5 ADA minimum
    expect(refs).toContain(`${'bb'.repeat(32)}#0`);
  });

  it('does not collapse sibling outputs of the same transaction (dedup by id#index)', () => {
    const txHash = 'ab'.repeat(32);
    const pool = [
      input(txHash, 0, 2_000_000n, 5n), // asset-selected
      input(txHash, 1, 50_000_000n),    // sibling output — must stay available for lovelace
    ];
    const requested = Value.add(Value.lovelaces(1_000_000n), Value.singleAsset(
      new Hash28(POLICY_ID),
      Buffer.from(ASSET_NAME, 'hex'),
      1n
    ));
    // The buggy id-only dedup dropped #1 (same tx id as the asset-selected #0),
    // leaving the lovelace requirement uncovered.
    const selected = keepRelevant(requested, pool);
    expect(refStrs(selected)).toEqual([`${txHash}#0`, `${txHash}#1`]);
  });

  it('never selects the same UTxO twice', () => {
    const pool = [
      input('aa'.repeat(32), 0, 6_000_000n, 5n), // covers asset AND all lovelace needs
      input('bb'.repeat(32), 0, 50_000_000n),
    ];
    const requested = Value.add(Value.lovelaces(1_000_000n), Value.singleAsset(
      new Hash28(POLICY_ID),
      Buffer.from(ASSET_NAME, 'hex'),
      1n
    ));
    const selected = keepRelevant(requested, pool);
    const refs = refStrs(selected);
    expect(new Set(refs).size).toBe(refs.length);
    expect(refs).toEqual([`${'aa'.repeat(32)}#0`]);
  });

  it('sorts lovelace amounts above 2^53 correctly (bigint comparison)', () => {
    const huge = 10_000_000_000_000_000_000n; // > Number.MAX_SAFE_INTEGER
    const pool = [
      input('aa'.repeat(32), 0, huge),
      input('bb'.repeat(32), 0, 7_000_000n),
    ];
    const selected = keepRelevant(Value.lovelaces(2_000_000n), pool);
    expect(refStrs(selected)).toEqual([`${'bb'.repeat(32)}#0`]);
  });

  it('accepts a Mesh-style unit record as the requested output set', () => {
    const pool = [
      input('aa'.repeat(32), 0, 2_000_000n, 5n),
      input('bb'.repeat(32), 0, 50_000_000n),
    ];
    // upstream's normalizeRequestedOutputSet accepts the record shape at runtime,
    // but the published signature only declares Value | ValueUnits
    const selected = keepRelevant({ lovelace: 1_000_000, [ASSET_UNIT]: 1 } as never, pool);
    expect(refStrs(selected)).toContain(`${'aa'.repeat(32)}#0`);
  });

  it('returns cloned inputs (mutating the selection does not touch the pool entries)', () => {
    const pool = [input('aa'.repeat(32), 0, 100_000_000n)];
    const selected = keepRelevant(Value.lovelaces(2_000_000n), pool);
    expect(selected.length).toBe(1);
    expect(selected[0]).not.toBe(pool[0]);
  });
});
