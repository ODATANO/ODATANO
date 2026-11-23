/**
 * The build row records where a real build sent its change: the request's changeAddress, else the
 * sender. The HSM signs only when that address and every stored change output is its own.
 */
import { BuildooorTxBuilder } from '../../srv/blockchain/transaction-building/buildooor-tx';
import { parseTransaction } from '../../srv/cbor';
import { mapBuildOutputs, mapBuildResult } from '../../srv/utils/mappers';
import type { TxBuildContext, TxBuildRequest, UTxO } from '../../srv/utils/types';

const SENDER = 'addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp';
const RECIPIENT = 'addr_test1wps7xts4e28ykdmg0uq86y6x050wsse86q42eytg6ljz5tqmrcwgm';
const FOREIGN = 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';
const PARAMS = { minFeeA: 44, minFeeB: 155381, coinsPerUtxoSize: '4310', maxTxSize: 16384 } as never;

const funding: UTxO = { txHash: 'dd'.repeat(32), outputIndex: 1, address: SENDER, amount: [{ unit: 'lovelace', quantity: '50000000' }] };
const context = (): TxBuildContext => ({ utxos: [funding], protocolParameters: PARAMS });
const request = (over: Partial<TxBuildRequest> = {}): TxBuildRequest => ({
  network: 'preview', senderAddress: SENDER, recipientAddress: RECIPIENT, lovelaceAmount: '2000000', ...over,
});

describe('build row change address', () => {
  let builder: BuildooorTxBuilder;
  beforeEach(async () => {
    builder = new BuildooorTxBuilder();
    await builder.init({ network: 'preview' } as never, PARAMS);
  });

  it('stores the request change address, and the body sends the change there', async () => {
    const req = request({ changeAddress: FOREIGN });
    const result = await builder.buildUnsignedTransfer(req, context());
    const row = mapBuildResult(result, 3_600_000);
    expect(row.changeAddress).toBe(FOREIGN);

    const outputs = mapBuildOutputs(row.id!, result.outputs, req.changeAddress);
    const change = outputs.filter((o) => o.isChange);
    expect(change.map((o) => o.address)).toEqual([FOREIGN]);
    const body = parseTransaction(result.unsignedTxCbor).outputs;
    for (const o of outputs) expect(body[o.outputIndex!].address).toBe(o.address);
  });

  it('stores the sender when the request names no change address', async () => {
    const result = await builder.buildUnsignedTransfer(request(), context());
    expect(mapBuildResult(result, 3_600_000).changeAddress).toBe(SENDER);
  });
});
