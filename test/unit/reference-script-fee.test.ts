/**
 * Conway reference-script fee as the builder library charges it: scripts on spent inputs and on
 * reference inputs, priced in tiers. The expected values are the ledger's.
 */
import { TxBuilder } from '@harmoniclabs/buildooor';
import {
  Address, Hash32, Script, Tx, TxBody, TxOut, TxOutRef, TxWitnessSet, UTxO, Value, defaultProtocolParameters,
} from '@harmoniclabs/cardano-ledger-ts';
import { sizePlaceholderScript } from '../../srv/utils/reference-script';

const ADDRESS = 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';
const PLUTUS_V3 = '585401010029800aba2aba1aab9eaab9dab9a4888896600264653001300600198031803800cc0180092225980099b8748000c01cdd500144c9289bae30093008375400516401830060013003375400d149a26cac8009';
// lovelace per byte in the first tier
const PRICE = 15n;
// The library counts up to 16 bytes more per script than the ledger. No tier here doubles the price.
const SLACK_PER_SCRIPT = 16n * PRICE * 2n;

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

describe('reference-script fee of the builder', () => {
  const builder = new TxBuilder(defaultProtocolParameters);
  const script = Script.fromCbor(Buffer.from(PLUTUS_V3, 'hex'));
  // fee the scripts add on top of the same transaction without them
  const scriptFee = (inputs: Array<Script | undefined>, refInputs: Array<Script | undefined> = []): bigint => {
    const refs = (scripts: Array<Script | undefined>, from: number, carry: boolean) =>
      scripts.map((s, i) => utxo(from + i, carry ? s : undefined));
    const build = (carry: boolean) => tx(refs(inputs, 0, carry), refInputs.length > 0 ? refs(refInputs, 100, carry) : undefined);
    return builder.calcMinFee(build(true)) - builder.calcMinFee(build(false));
  };
  const between = (fee: bigint, ledger: bigint, scripts: bigint) => {
    expect(fee).toBeGreaterThanOrEqual(ledger);
    expect(fee).toBeLessThanOrEqual(ledger + scripts * SLACK_PER_SCRIPT);
  };

  it('charges a script on a spent input (86 bytes)', () => {
    between(scriptFee([script]), 86n * PRICE, 1n);
  });

  it('charges the same script on two UTxOs twice', () => {
    between(scriptFee([script], [script]), 172n * PRICE, 2n);
  });

  it('charges a UTxO that is spent and referenced once', () => {
    const both = utxo(0, script);
    const bare = utxo(0);
    const fee = builder.calcMinFee(tx([both], [both])) - builder.calcMinFee(tx([bare], [bare]));
    between(fee, 86n * PRICE, 1n);
  });

  // ledger values at 15 lovelace per byte, tiers of 25 600 bytes, factor 1.2
  it.each([
    [10_000, 20_000, 463_200n],
    [24_000, 24_000, 787_200n],
    [50_000, 50_000, 1_999_104n],
  ])('prices %i + %i bytes across input and reference input in tiers', (onInput, onReference, ledger) => {
    between(scriptFee([sizePlaceholderScript(onInput)], [sizePlaceholderScript(onReference)]), ledger, 2n);
  });
});
