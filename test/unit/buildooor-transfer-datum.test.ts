/**
 * Transfers with an inline datum given as CBOR, on the real Buildooor TxBuilder: the bytes
 * reach the transaction unchanged, the fee covers them, and the recipient output meets min-ADA.
 */
import { BuildooorTxBuilder } from '../../srv/blockchain/transaction-building/buildooor-tx';
import { parseTransaction } from '../../srv/cbor';
import type { TxBuildRequest, TxBuildContext, UTxO } from '../../srv/utils/types';
import { TransactionValidationError } from '../../srv/utils/errors';

const { Tx } = require('@harmoniclabs/cardano-ledger-ts');

const SENDER = 'addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp';
const SCRIPT_ADDRESS = 'addr_test1wps7xts4e28ykdmg0uq86y6x050wsse86q42eytg6ljz5tqmrcwgm';
const PARAMS = { minFeeA: 44, minFeeB: 155381, coinsPerUtxoSize: '4310', maxTxSize: 16384 } as any;
const UNIT = 'def68337867cb4f1f95b6b811fedbfcdd7780d10a95cc072077088ea' + '546f6b656e4d';

// Constr 0 [{1: 2}, 42] with a definite map and list; Buildooor would write both indefinite
const DEFINITE_DATUM = 'd87982a10102182a';
// Constr 0 [chunked bytes 01, []]: longer as given than in Buildooor's encoding
const LONGER_DATUM = 'd8799f5f4101ff80ff';

const funding: UTxO = {
  txHash: 'dd'.repeat(32), outputIndex: 1, address: SENDER,
  amount: [{ unit: 'lovelace', quantity: '50000000' }, { unit: UNIT, quantity: '10' }],
};
const context = (): TxBuildContext => ({ utxos: [funding], protocolParameters: PARAMS });
const request = (over: Partial<TxBuildRequest> = {}): TxBuildRequest => ({
  network: 'preview', senderAddress: SENDER, recipientAddress: SCRIPT_ADDRESS, lovelaceAmount: '2000000', ...over,
});

/** Fee floor of the ledger for this size, one vkey witness included. */
const ledgerMinFee = (sizeBytes: number) => 44n * BigInt(sizeBytes + 106) + 155381n;

describe('BuildooorTxBuilder.buildUnsignedTransfer with outputDatumCbor', () => {
  let builder: BuildooorTxBuilder;
  beforeEach(async () => {
    builder = new BuildooorTxBuilder();
    await builder.init({ network: 'preview' } as any, PARAMS);
  });

  it('writes a definite-length datum byte for byte and keeps the body hash consistent', async () => {
    const result = await builder.buildUnsignedTransfer(request({ outputDatumCbor: DEFINITE_DATUM }), context());
    const parsed = parseTransaction(result.unsignedTxCbor);
    expect(parsed.outputs[0].inlineDatumHex).toBe(DEFINITE_DATUM);
    expect(parsed.txHash).toBe(result.txBodyHash);
    expect(BigInt(result.feeLovelace)).toBeGreaterThanOrEqual(ledgerMinFee(result.sizeBytes!));
  });

  it('raises the fee when the given datum is longer than Buildooor would write it', async () => {
    const result = await builder.buildUnsignedTransfer(request({ outputDatumCbor: LONGER_DATUM }), context());
    const parsed = parseTransaction(result.unsignedTxCbor);
    expect(parsed.outputs[0].inlineDatumHex).toBe(LONGER_DATUM);
    expect(BigInt(result.feeLovelace)).toBeGreaterThanOrEqual(ledgerMinFee(result.sizeBytes!));
    // inputs = outputs + fee
    const out = parsed.outputs.reduce((sum, o) => sum + BigInt(o.lovelace), 0n);
    expect(out + BigInt(parsed.fee)).toBe(50000000n);
  });

  it('writes the datum on a multi-asset transfer', async () => {
    const result = await builder.buildUnsignedTransfer(
      request({ outputDatumCbor: DEFINITE_DATUM, assets: [{ unit: UNIT, quantity: '3' }] }), context());
    const parsed = parseTransaction(result.unsignedTxCbor);
    expect(parsed.outputs[0].inlineDatumHex).toBe(DEFINITE_DATUM);
    expect(parsed.outputs[0].assets).toEqual([{ unit: UNIT, quantity: '3' }]);
  });

  it('rejects outputDatum together with outputDatumCbor', async () => {
    await expect(builder.buildUnsignedTransfer(
      request({ outputDatum: { int: 1 }, outputDatumCbor: DEFINITE_DATUM }), context()))
      .rejects.toThrow(TransactionValidationError);
  });

  describe('min-ADA of the recipient output', () => {
    const bigDatum = 'd8799f5840' + 'ab'.repeat(64) + 'ff';
    const small = request({ lovelaceAmount: '1000000', outputDatumCbor: bigDatum, assets: [{ unit: UNIT, quantity: '1' }] });

    it('rejects an amount below min-ADA, naming the amount needed', async () => {
      await expect(builder.buildUnsignedTransfer(small, context()))
        .rejects.toThrow(/recipient output needs at least \d+ lovelace \(has 1000000\)/);
    });

    it('raises the amount to min-ADA with ensureMinAda and reports it', async () => {
      const result = await builder.buildUnsignedTransfer({ ...small, ensureMinAda: true }, context());
      const lovelace = BigInt(result.outputs[0].lovelace);
      expect(lovelace).toBeGreaterThan(1000000n);
      const tx = Tx.fromCbor(result.unsignedTxCbor);
      const txBuilder = (builder as any).txBuilder;
      expect(lovelace).toBeGreaterThanOrEqual(txBuilder.getMinimumOutputLovelaces(tx.body.outputs[0]));
      expect(parseTransaction(result.unsignedTxCbor).outputs[0].inlineDatumHex).toBe(bigDatum);
    });

    it('leaves an amount above min-ADA as given', async () => {
      const result = await builder.buildUnsignedTransfer({ ...small, lovelaceAmount: '5000000', ensureMinAda: true }, context());
      expect(result.outputs[0].lovelace).toBe('5000000');
    });
  });
});
