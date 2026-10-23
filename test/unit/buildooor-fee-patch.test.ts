/**
 * Conway reference-script fee on top of Buildooor: tiered price, scripts on spent inputs counted,
 * and the patched calcMinFee charging exactly that on a transaction.
 */
import { TxBuilder } from '@harmoniclabs/buildooor';
import {
  Address, Hash32, Script, Tx, TxBody, TxOut, TxOutRef, TxWitnessSet, UTxO, Value, defaultProtocolParameters,
} from '@harmoniclabs/cardano-ledger-ts';
import { tierRefScriptFee, refScriptBytesOf, installReferenceScriptFeePatch, REF_SCRIPT_TIER_BYTES } from '../../srv/blockchain/transaction-building/buildooor-fee-patch';
import { sizePlaceholderScript } from '../../srv/utils/reference-script';

const ADDRESS = 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';
const PLUTUS_V3 = '585401010029800aba2aba1aab9eaab9dab9a4888896600264653001300600198031803800cc0180092225980099b8748000c01cdd500144c9289bae30093008375400516401830060013003375400d149a26cac8009';
const PRICE = { num: 15n, den: 1n };

const utxo = (idx: number, refScript?: Script): UTxO => new UTxO({
  utxoRef: new TxOutRef({ id: new Hash32('a'.repeat(64)), index: idx }),
  resolved: new TxOut({ address: Address.fromString(ADDRESS), value: Value.lovelaces(10_000_000n), refScript }),
});
const tx = (inputs: UTxO[], refInputs?: UTxO[]): Tx => new Tx({
  body: new TxBody({
    inputs: inputs as [UTxO, ...UTxO[]],
    outputs: [new TxOut({ address: Address.fromString(ADDRESS), value: Value.lovelaces(9_000_000n) })],
    fee: 200_000n,
    refInputs,
  }),
  witnesses: new TxWitnessSet({}),
});

describe('tierRefScriptFee', () => {
  // ledger values at 15 lovelace/byte, tiers of 25 600 bytes, factor 1.2
  it.each([
    [0n, 0n], [10_000n, 150_000n], [25_600n, 384_000n], [30_000n, 463_200n], [48_000n, 787_200n],
    [100_000n, 1_999_104n], [200_000n, 6_077_659n],
  ])('prices %i bytes at %i lovelace', (bytes, fee) => {
    expect(tierRefScriptFee(bytes, PRICE)).toBe(fee);
  });

  it('keeps the price rational: 2 bytes at 7.5 lovelace each are 15, one byte floors to 7', () => {
    expect(tierRefScriptFee(2n, { num: 15n, den: 2n })).toBe(15n);
    expect(tierRefScriptFee(1n, { num: 15n, den: 2n })).toBe(7n);
    expect(REF_SCRIPT_TIER_BYTES).toBe(25_600n);
  });
});

describe('refScriptBytesOf', () => {
  const script = Script.fromCbor(Buffer.from(PLUTUS_V3, 'hex'));

  it('counts scripts on inputs and reference inputs alike, without deduplication', () => {
    expect(refScriptBytesOf(tx([utxo(0)]))).toBe(0n);
    expect(refScriptBytesOf(tx([utxo(0, script)]))).toBe(86n);
    expect(refScriptBytesOf(tx([utxo(0, script), utxo(1)], [utxo(2, script), utxo(3, script)]))).toBe(258n);
  });
});

describe('patched TxBuilder.calcMinFee', () => {
  installReferenceScriptFeePatch();
  const builder = new TxBuilder(defaultProtocolParameters);

  it('charges the ledger reference-script fee for a script on a spent input', () => {
    const base = builder.calcMinFee(tx([utxo(0)]));
    const withScript = builder.calcMinFee(tx([utxo(0, Script.fromCbor(Buffer.from(PLUTUS_V3, 'hex')))]));
    expect(withScript - base).toBe(86n * 15n);
  });

  it('prices several scripts in tiers (30 000 bytes across input and reference input)', () => {
    // same inputs and reference inputs on both sides, so only the script bytes differ
    const base = builder.calcMinFee(tx([utxo(0)], [utxo(1)]));
    const tiered = builder.calcMinFee(tx([utxo(0, sizePlaceholderScript(16_000))], [utxo(1, sizePlaceholderScript(14_000))]));
    expect(tiered - base).toBe(463_200n);
  });

  it('honours the minimum and installs only once', () => {
    const before = TxBuilder.prototype.calcMinFee;
    installReferenceScriptFeePatch();
    expect(TxBuilder.prototype.calcMinFee).toBe(before);
    expect(builder.calcMinFee(tx([utxo(0)]), 5_000_000n)).toBe(5_000_000n);
  });
});
