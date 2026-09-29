/**
 * BuildPlutusTransaction on the real Buildooor TxBuilder: several script inputs with their own
 * redeemers, inline and reference scripts mixed, outputs in the given order, change last.
 */
import { BuildooorTxBuilder } from '../../srv/blockchain/transaction-building/buildooor-tx';
import type { TxBuildPlutusRequest, TxBuildContext, UTxO } from '../../srv/utils/types';
import { TransactionValidationError } from '../../srv/utils/errors';

const { Tx } = require('@harmoniclabs/cardano-ledger-ts');

const SENDER = 'addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp';
const OTHER = 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';
// VALID_SPENDING_SCRIPT of buildooor-tx-builder.test.ts and its testnet enterprise address
const SCRIPT = '587601010029800aba2aba1aab9eaab9dab9a48888966002646465300130053754003300700398038012444b30013370e9000001c4c9289bae300a3009375400915980099b874800800e2646644944c02c004c02cc030004c024dd5002459007200e18031803800980300098019baa0068a4d13656400401';
const SCRIPT_ADDRESS = 'addr_test1wps7xts4e28ykdmg0uq86y6x050wsse86q42eytg6ljz5tqmrcwgm';
const PARAMS = { minFeeA: 44, minFeeB: 155381, coinsPerUtxoSize: '4310', maxTxSize: 16384 } as any;

const A = 'a1'.repeat(32);
const B = 'b2'.repeat(32);
const C = 'c3'.repeat(32);
const REF = 'e4'.repeat(32);

const scriptUtxo = (txHash: string, lovelace = '3000000'): UTxO => ({
  txHash, outputIndex: 0, address: SCRIPT_ADDRESS,
  amount: [{ unit: 'lovelace', quantity: lovelace }], inlineDatum: 'd87980',
});
const collateral: UTxO = { txHash: 'cc'.repeat(32), outputIndex: 0, address: SENDER, amount: [{ unit: 'lovelace', quantity: '5000000' }] };
const funding: UTxO = { txHash: 'dd'.repeat(32), outputIndex: 1, address: SENDER, amount: [{ unit: 'lovelace', quantity: '50000000' }] };
const refScriptUtxo: UTxO = {
  txHash: REF, outputIndex: 0, address: SENDER, amount: [{ unit: 'lovelace', quantity: '20000000' }],
  scriptRef: 'ab'.repeat(28), scriptRefCbor: SCRIPT,
};

// Certified units for any spend index, so the build does not depend on the local CEK run
const evaluateTransaction = async () =>
  [0, 1, 2, 3, 4, 5].map(index => ({ validator: { purpose: 'spend', index }, budget: { memory: 200_000, cpu: 100_000_000 } }));

const request = (over: Partial<TxBuildPlutusRequest> = {}): TxBuildPlutusRequest => ({
  network: 'preview',
  senderAddress: SENDER,
  scriptInputs: [
    { txHash: A, outputIndex: 0, validatorScript: SCRIPT, redeemer: { constructor: 0, fields: [] } },
    { txHash: B, outputIndex: 0, validatorScript: SCRIPT, redeemer: { constructor: 1, fields: [] } },
    { txHash: C, outputIndex: 0, referenceScript: { txHash: REF, outputIndex: 0 }, redeemer: { constructor: 2, fields: [] } },
  ],
  outputs: [
    { address: SCRIPT_ADDRESS, lovelaceAmount: '2000000', inlineDatum: { constructor: 7, fields: [] } },
    { address: OTHER, lovelaceAmount: '1500000' },
  ],
  ...over,
});
const context = (over: Partial<TxBuildContext> = {}): TxBuildContext => ({
  utxos: [scriptUtxo(A), scriptUtxo(B), scriptUtxo(C), collateral, funding],
  protocolParameters: PARAMS,
  evaluateTransaction,
  referenceInputUtxos: [refScriptUtxo],
  ...over,
});

describe('BuildooorTxBuilder.buildUnsignedPlutusTransaction', () => {
  let builder: BuildooorTxBuilder;
  beforeEach(async () => {
    builder = new BuildooorTxBuilder();
    await builder.init({ network: 'preview' } as any, PARAMS);
  });

  it('spends three script inputs with their own redeemers, inline and reference script mixed', async () => {
    const result = await builder.buildUnsignedPlutusTransaction(request(), context());
    const tx = Tx.fromCbor(result.unsignedTxCbor);

    const inputs = tx.body.inputs.map((i: any) => i.utxoRef.id.toString());
    for (const h of [A, B, C]) expect(inputs).toContain(h);

    // one redeemer per script input, each carrying the constructor the caller gave that input
    const spends = (tx.witnesses.redeemers ?? []).filter((r: any) => r.tag === 0);
    expect(spends).toHaveLength(3);
    const constrByInput = new Map(spends.map((r: any) => [inputs[r.index], Number(r.data.constr)]));
    expect(constrByInput.get(A)).toBe(0);
    expect(constrByInput.get(B)).toBe(1);
    expect(constrByInput.get(C)).toBe(2);

    // the reference script travels as reference input, exactly once, not as witness
    const refInputs = (tx.body.refInputs ?? []).map((i: any) => i.utxoRef.id.toString());
    expect(refInputs.filter((h: string) => h === REF)).toHaveLength(1);

    // outputs in the given order, change after them
    const outs = tx.body.outputs;
    expect(outs[0].address.toString()).toBe(SCRIPT_ADDRESS);
    expect(outs[0].value.lovelaces).toBe(2000000n);
    expect(outs[1].address.toString()).toBe(OTHER);
    expect(outs[1].value.lovelaces).toBe(1500000n);
    expect(outs[outs.length - 1].address.toString()).toBe(SENDER);

    expect(result.redeemers).toHaveLength(3);
    expect(result.redeemers!.every(r => r.tag === 'Spend' && BigInt(r.mem) > 0n && BigInt(r.steps) > 0n)).toBe(true);
  });

  it('spends an inline validator by reference when a reference input already carries that script', async () => {
    // the ledger rejects a script both referenced and witnessed (ExtraneousScriptWitnessesUTXOW)
    const tx = Tx.fromCbor((await builder.buildUnsignedPlutusTransaction(request(), context())).unsignedTxCbor);
    expect(tx.witnesses.plutusV3Scripts ?? []).toHaveLength(0);
    expect((tx.witnesses.redeemers ?? []).filter((r: any) => r.tag === 0)).toHaveLength(3);
    expect((tx.body.refInputs ?? []).map((i: any) => i.utxoRef.id.toString())).toEqual([REF]);
  });

  it('keeps the validator as witness when no reference input carries it', async () => {
    const req = request();
    req.scriptInputs = req.scriptInputs.slice(0, 2); // the two inline ones
    const tx = Tx.fromCbor((await builder.buildUnsignedPlutusTransaction(req, context({
      utxos: [scriptUtxo(A), scriptUtxo(B), collateral, funding], referenceInputUtxos: [],
    }))).unsignedTxCbor);
    expect(tx.witnesses.plutusV3Scripts ?? []).toHaveLength(1);
  });

  it('resolves __INPUT_IDX__ in one redeemer to the sorted position of another script input', async () => {
    const req = request();
    req.scriptInputs[0].redeemer = { constructor: 0, fields: [{ int: `__INPUT_IDX:${B}#0__` }] };
    const tx = Tx.fromCbor((await builder.buildUnsignedPlutusTransaction(req, context())).unsignedTxCbor);
    const inputs = tx.body.inputs.map((i: any) => i.utxoRef.id.toString());
    const redeemerOfA = (tx.witnesses.redeemers ?? []).find((r: any) => r.tag === 0 && inputs[r.index] === A);
    expect(Number(redeemerOfA.data.fields[0].int)).toBe(inputs.indexOf(B));
  });

  it('writes a reference script on an output in the ledger form [language, bytes]', async () => {
    const req = request({ outputs: [{ address: SENDER, lovelaceAmount: '20000000', referenceScript: SCRIPT }] });
    const tx = Tx.fromCbor((await builder.buildUnsignedPlutusTransaction(req, context())).unsignedTxCbor);
    // script_ref = #6.24(bytes .cbor [3, plutus_v3_script]); the bare compiler bytes are rejected by the node
    const refScriptCbor = Buffer.from(tx.body.outputs[0].refScript.toCbor()).toString('hex');
    expect(refScriptCbor.startsWith('8203')).toBe(true);
  });

  it('takes redeemer and inline datum CBOR byte for byte', async () => {
    const { dataToCbor } = require('@harmoniclabs/plutus-data');
    // Constr 1 [Constr 0 [], 42] in a non-canonical but valid encoding: indefinite-length list
    const redeemerCbor = 'd87a9fd8798018' + '2a' + 'ff';
    const datumCbor = 'd87b9f01ff';
    const req = request();
    req.scriptInputs[0] = { ...req.scriptInputs[0], redeemer: null, redeemerCbor };
    req.outputs = [{ address: SCRIPT_ADDRESS, lovelaceAmount: '2000000', inlineDatumCbor: datumCbor }];
    const { unsignedTxCbor } = await builder.buildUnsignedPlutusTransaction(req, context());
    // the caller's bytes appear verbatim in the transaction
    expect(unsignedTxCbor).toContain(redeemerCbor);
    expect(unsignedTxCbor).toContain(datumCbor);
    const tx = Tx.fromCbor(unsignedTxCbor);
    const inputs = tx.body.inputs.map((i: any) => i.utxoRef.id.toString());
    const redeemerOfA = (tx.witnesses.redeemers ?? []).find((r: any) => r.tag === 0 && inputs[r.index] === A);
    expect(Buffer.from(dataToCbor(redeemerOfA.data)).toString('hex')).toBe(redeemerCbor);
    expect(Buffer.from(dataToCbor(tx.body.outputs[0].datum)).toString('hex')).toBe(datumCbor);
  });

  it('builds with a redeemer twelve levels deep', async () => {
    let deep: any = { int: 7 };
    for (let i = 0; i < 6; i++) deep = { constructor: 0, fields: [deep] };
    const req = request();
    req.scriptInputs[0] = { ...req.scriptInputs[0], redeemer: deep };
    const result = await builder.buildUnsignedPlutusTransaction(req, context());
    expect(result.unsignedTxCbor).toBeDefined();
  });

  it('never spends a UTxO that is a reference input, and refuses one that is forced and referenced', async () => {
    const oracle: UTxO = { txHash: 'f0'.repeat(32), outputIndex: 0, address: SENDER, amount: [{ unit: 'lovelace', quantity: '90000000' }] };
    const req = request({ referenceInputs: [{ txHash: oracle.txHash, outputIndex: 0 }] });
    // the biggest sender UTxO, so coin selection would pick it first without the filter
    const ctx = context({ utxos: [scriptUtxo(A), scriptUtxo(B), scriptUtxo(C), collateral, funding, oracle], referenceInputUtxos: [refScriptUtxo, oracle] });
    const tx = Tx.fromCbor((await builder.buildUnsignedPlutusTransaction(req, ctx)).unsignedTxCbor);
    expect(tx.body.inputs.map((i: any) => i.utxoRef.id.toString())).not.toContain(oracle.txHash);
    expect((tx.body.collateralInputs ?? []).map((i: any) => i.utxoRef.id.toString())).not.toContain(oracle.txHash);
    expect((tx.body.refInputs ?? []).map((i: any) => i.utxoRef.id.toString())).toContain(oracle.txHash);

    const err = await builder.buildUnsignedPlutusTransaction({ ...req, forceInputs: [{ txHash: oracle.txHash, outputIndex: 0 }] }, ctx).catch(e => e);
    expect(err).toBeInstanceOf(TransactionValidationError);
    expect(err.message).toMatch(/cannot be spent and referenced/);
  });

  it('never selects a sender UTxO with a reference script as funding, unless it is forced', async () => {
    // the only UTxO that could fund the outputs carries a reference script
    const deployed: UTxO = { txHash: 'd2'.repeat(32), outputIndex: 0, address: SENDER, amount: [{ unit: 'lovelace', quantity: '90000000' }], scriptRef: 'ab'.repeat(28) };
    const ctx = context({ utxos: [deployed, scriptUtxo(A), scriptUtxo(B), scriptUtxo(C), collateral] });
    // more than the script inputs hold, so the build needs funding from the sender
    const outputs = [{ address: OTHER, lovelaceAmount: '40000000' }];
    const err = await builder.buildUnsignedPlutusTransaction(request({ outputs }), ctx).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    const forced = Tx.fromCbor((await builder.buildUnsignedPlutusTransaction(request({ outputs, forceInputs: [{ txHash: deployed.txHash, outputIndex: 0 }] }), ctx)).unsignedTxCbor);
    expect(forced.body.inputs.map((i: any) => i.utxoRef.id.toString())).toContain(deployed.txHash);
  });

  it('does not take a UTxO carrying a reference script as collateral', async () => {
    // an ADA-only UTxO with a reference script, smaller than the plain one, so it would be picked first
    const deployed: UTxO = { txHash: 'd1'.repeat(32), outputIndex: 0, address: SENDER, amount: [{ unit: 'lovelace', quantity: '6000000' }], scriptRef: 'ab'.repeat(28) };
    const plain: UTxO = { txHash: 'c9'.repeat(32), outputIndex: 0, address: SENDER, amount: [{ unit: 'lovelace', quantity: '9000000' }] };
    const tx = Tx.fromCbor((await builder.buildUnsignedPlutusTransaction(request(), context({
      utxos: [scriptUtxo(A), scriptUtxo(B), scriptUtxo(C), deployed, plain, funding],
    }))).unsignedTxCbor);
    const collaterals = (tx.body.collateralInputs ?? []).map((i: any) => i.utxoRef.id.toString());
    expect(collaterals).toEqual([plain.txHash]);
  });

  it('locks an output with a datum hash when asked', async () => {
    const hash = '923918e403bf43c34b4ef6b48eb2ee04babed17320d8d1b9ff9ad086e86f44ec';
    const req = request({ outputs: [{ address: SCRIPT_ADDRESS, lovelaceAmount: '2000000', datumHash: hash }] });
    const tx = Tx.fromCbor((await builder.buildUnsignedPlutusTransaction(req, context())).unsignedTxCbor);
    expect(tx.body.outputs[0].datum.toString()).toBe(hash);
  });

  it('rejects an output below min-ADA naming the output', async () => {
    const req = request({ outputs: [{ address: OTHER, lovelaceAmount: '1000000', assets: [{ unit: `${'f6'.repeat(28)}746f6b`, quantity: '5' }] }] });
    const err = await builder.buildUnsignedPlutusTransaction(req, context()).catch(e => e);
    expect(err).toBeInstanceOf(TransactionValidationError);
    expect(err.message).toMatch(/^outputs\[0\] needs at least \d+ lovelace \(has 1000000\)/);
  });

  it('rejects a reference script whose bytes are not available', async () => {
    const hashOnly = { ...refScriptUtxo, scriptRefCbor: undefined };
    const err = await builder.buildUnsignedPlutusTransaction(request(), context({ referenceInputUtxos: [hashOnly] })).catch(e => e);
    expect(err).toBeInstanceOf(TransactionValidationError);
    expect(err.message).toMatch(/scriptInputs\[2\]\.referenceScript .* carries no reference script, or its bytes are not available/);
  });

  it('rejects a missing collateral with a hint to SetCollateral', async () => {
    const tokenOnly: UTxO = { ...funding, amount: [{ unit: 'lovelace', quantity: '50000000' }, { unit: `${'f6'.repeat(28)}746f6b`, quantity: '1' }] };
    const err = await builder.buildUnsignedPlutusTransaction(request(), context({
      utxos: [scriptUtxo(A), scriptUtxo(B), scriptUtxo(C), tokenOnly],
    })).catch(e => e);
    expect(err).toBeInstanceOf(TransactionValidationError);
    expect(err.message).toMatch(/SetCollateral/);
  });

  it('rejects a script input that is not among the resolved UTxOs', async () => {
    const err = await builder.buildUnsignedPlutusTransaction(request(), context({ utxos: [scriptUtxo(A), scriptUtxo(B), collateral, funding] })).catch(e => e);
    expect(err).toBeInstanceOf(TransactionValidationError);
    expect(err.message).toMatch(/scriptInputs\[2\] .* not found on-chain or already spent/);
  });
});
