import { Cbor, CborArray, CborMap, CborUInt } from '@harmoniclabs/cbor';
import {
  Address, Hash32, Tx, TxBody, TxOut, TxOutRef, TxRedeemer, TxRedeemerTag, TxWitnessSet, UTxO, Value,
} from '@harmoniclabs/cardano-ledger-ts';
import { installRedeemerTagPatch } from '../../srv/cbor/redeemer-tag-patch';
import { parseTransaction } from '../../srv/cbor';

installRedeemerTagPatch();

const ADDRESS = 'addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp';
const exUnits = () => new CborArray([new CborUInt(1_000), new CborUInt(2_000)]);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

// redeemer in the legacy array form: [tag, index, data, exUnits]
const arrayRedeemer = (tag: number) => new CborArray([new CborUInt(tag), new CborUInt(0), new CborUInt(42), exUnits()]);
// redeemer in the Conway map form: { [tag, index]: [data, exUnits] }
const mapEntry = (tag: number) => ({ k: new CborArray([new CborUInt(tag), new CborUInt(1)]), v: new CborArray([new CborUInt(42), exUnits()]) });

describe('redeemer tag patch', () => {
  it.each([TxRedeemerTag.Voting, TxRedeemerTag.Proposing])('decodes tag %s in the array form, bytes unchanged', (tag) => {
    const bytes = Cbor.encode(arrayRedeemer(tag));
    const redeemer = TxRedeemer.fromCbor(hex(bytes));
    expect(redeemer.tag).toBe(tag);
    expect(redeemer.index).toBe(0);
    expect(hex(redeemer.toCbor())).toBe(hex(bytes));
  });

  it.each([TxRedeemerTag.Voting, TxRedeemerTag.Proposing])('decodes tag %s in the map form', (tag) => {
    const entry = mapEntry(tag);
    const redeemer = TxRedeemer.fromCborMapEntry(entry);
    expect(redeemer.tag).toBe(tag);
    expect(redeemer.index).toBe(1);
    expect(Number((entry.k.array[0] as CborUInt).num)).toBe(tag);
  });

  it('keeps the tag on clone and leaves the original unchanged', () => {
    const redeemer = TxRedeemer.fromCborMapEntry(mapEntry(TxRedeemerTag.Proposing));
    const copy = redeemer.clone();
    expect(copy.tag).toBe(TxRedeemerTag.Proposing);
    expect(redeemer.tag).toBe(TxRedeemerTag.Proposing);
    expect(copy).not.toBe(redeemer);
  });

  it('leaves tags 0 to 3 to the library', () => {
    expect(TxRedeemer.fromCborMapEntry(mapEntry(TxRedeemerTag.Withdraw)).tag).toBe(TxRedeemerTag.Withdraw);
    expect(() => TxRedeemer.fromCborMapEntry(mapEntry(6))).toThrow('invalid redeemer tag');
  });

  it('parseTransaction reads a tx with voting and proposing redeemers', () => {
    const body = new TxBody({
      inputs: [new UTxO({
        utxoRef: new TxOutRef({ id: new Hash32('a'.repeat(64)), index: 0 }),
        resolved: new TxOut({ address: Address.fromString(ADDRESS), value: Value.lovelaces(10_000_000n) }),
      })],
      outputs: [new TxOut({ address: Address.fromString(ADDRESS), value: Value.lovelaces(9_000_000n) })],
      fee: 200_000n,
    });
    const tx = Cbor.parse(new Tx({ body, witnesses: new TxWitnessSet({}) }).toCbor()) as CborArray;
    const redeemers = new CborMap([mapEntry(TxRedeemerTag.Voting), mapEntry(TxRedeemerTag.Proposing)]);
    tx.array[1] = new CborMap([{ k: new CborUInt(5), v: redeemers }]);

    const parsed = parseTransaction(hex(Cbor.encode(tx)));
    expect(parsed.txHash).toBe(body.hash.toString());
    expect(parsed.witnesses.redeemers).toBe(2);
  });
});
