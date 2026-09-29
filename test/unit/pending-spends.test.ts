/**
 * PendingSpends — transactions this process submitted, applied to the ledger view of an address
 * until a crawled block shows them or they expire.
 */
vi.mock('@sap/cds', () => {
  const cdsMock = { log: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) };
  return { default: cdsMock, ...cdsMock };
});

import { Tx, TxBody, TxOut, UTxO as LedgerUtxo, TxOutRef, Address, Value, Hash32, TxWitnessSet } from '@harmoniclabs/buildooor';
import { PendingSpends, PENDING_TX_TTL_MS } from '../../srv/blockchain/pending-spends';
import type { UTxO } from '../../srv/utils/types';

const SENDER = 'addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp';
const OTHER = 'addr_test1wps7xts4e28ykdmg0uq86y6x050wsse86q42eytg6ljz5tqmrcwgm';
const A = 'a'.repeat(64), B = 'b'.repeat(64);

function signedTx(inputs: Array<[string, number]>, outputs: Array<[string, bigint]>): { cbor: string; hash: string } {
  const tx = new Tx({
    body: new TxBody({
      inputs: inputs.map(([h, i]) => new LedgerUtxo({
        utxoRef: new TxOutRef({ id: new Hash32(h), index: i }),
        resolved: new TxOut({ address: Address.fromString(SENDER), value: Value.lovelaces(1n) }),
      })) as [LedgerUtxo, ...LedgerUtxo[]],
      outputs: outputs.map(([addr, lovelace]) => new TxOut({ address: Address.fromString(addr), value: Value.lovelaces(lovelace) })),
      fee: 200_000n,
    }),
    witnesses: new TxWitnessSet({}),
  });
  return { cbor: Buffer.from(tx.toCbor()).toString('hex'), hash: tx.body.hash.toString() };
}

const utxo = (txHash: string, outputIndex: number, lovelace = '10000000'): UTxO =>
  ({ txHash, outputIndex, address: SENDER, amount: [{ unit: 'lovelace', quantity: lovelace }] });

describe('PendingSpends', () => {
  let now = 1_000_000;
  const clock = () => now;

  it('removes the inputs of a submitted transaction and offers its change to the sender', () => {
    const pending = new PendingSpends(clock);
    const t1 = signedTx([[A, 0]], [[OTHER, 2_000_000n], [SENDER, 7_800_000n]]);
    pending.record(t1.cbor);

    const view = pending.apply(SENDER, [utxo(A, 0), utxo(B, 1)]);
    expect(view.map(u => `${u.txHash.slice(0, 1)}#${u.outputIndex}`)).toEqual(['b#1', `${t1.hash.slice(0, 1)}#1`]);
    expect(view[1]).toMatchObject({ txHash: t1.hash, outputIndex: 1, address: SENDER, amount: [{ unit: 'lovelace', quantity: '7800000' }] });
    expect(pending.spentBy(A, 0)).toBe(t1.hash);
    expect(pending.spentBy(B, 1)).toBeUndefined();
  });

  it('chains: a second pending transaction spends the change of the first', () => {
    const pending = new PendingSpends(clock);
    const t1 = signedTx([[A, 0]], [[SENDER, 7_800_000n]]);
    pending.record(t1.cbor);
    const t2 = signedTx([[t1.hash, 0]], [[OTHER, 1_000_000n], [SENDER, 6_600_000n]]);
    pending.record(t2.cbor);

    const view = pending.apply(SENDER, [utxo(A, 0)]);
    expect(view.map(u => [u.txHash, u.outputIndex])).toEqual([[t2.hash, 1]]);
  });

  it('forgets a transaction once the crawled view lists its outputs, and after the TTL', () => {
    const pending = new PendingSpends(clock);
    const t1 = signedTx([[A, 0]], [[SENDER, 7_800_000n]]);
    pending.record(t1.cbor);
    // crawled: A#0 gone, t1#0 present
    expect(pending.apply(SENDER, [utxo(t1.hash, 0, '7800000')])).toHaveLength(1);
    expect(pending.size).toBe(0);

    pending.record(t1.cbor);
    now += PENDING_TX_TTL_MS;
    expect(pending.spentBy(A, 0)).toBeUndefined();
    expect(pending.apply(SENDER, [utxo(A, 0)])).toEqual([utxo(A, 0)]);
  });

  it('ignores CBOR it cannot parse', () => {
    const pending = new PendingSpends(clock);
    pending.record('00');
    expect(pending.size).toBe(0);
  });
});
