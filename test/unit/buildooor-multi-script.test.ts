/**
 * BuildPlutusTransaction on the real Buildooor TxBuilder: several script inputs with their own
 * redeemers, inline and reference scripts mixed, outputs in the given order, change last.
 */
import { BuildooorTxBuilder } from '../../srv/blockchain/transaction-building/buildooor-tx';
import type { TxBuildPlutusRequest, TxBuildContext, UTxO } from '../../srv/utils/types';
import { TransactionValidationError } from '../../srv/utils/errors';

const { Tx, Address, Script, StakeAddress, StakeValidatorHash, StakeKeyHash, TxRedeemerTag, CertificateType } = require('@harmoniclabs/cardano-ledger-ts');

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

  it('keeps an inline datum with a definite map byte for byte, and the fee covers it', async () => {
    const { parseTransaction } = require('../../srv/cbor');
    // Constr 0 [{1: 2}, chunked bytes 01]: Buildooor writes the map indefinite and the bytes unchunked
    const datumCbor = 'd87982a101025f4101ff';
    const req = request();
    req.outputs = [{ address: SCRIPT_ADDRESS, lovelaceAmount: '2000000', inlineDatumCbor: datumCbor }];
    const result = await builder.buildUnsignedPlutusTransaction(req, context());
    const parsed = parseTransaction(result.unsignedTxCbor);
    expect(parsed.outputs[0].inlineDatumHex).toBe(datumCbor);
    expect(parsed.txHash).toBe(result.txBodyHash);
    // stamped redeemers and scriptDataHash survive the datum write
    expect(parsed.scriptDataHash).not.toBeNull();
    expect(result.redeemers).toHaveLength(3);
    expect(BigInt(result.feeLovelace)).toBeGreaterThanOrEqual(44n * BigInt(result.sizeBytes! + 106) + 155381n);
  });

  describe('witness datums of datum-hash UTxOs', () => {
    const { scriptDataHashOf } = require('../../srv/blockchain/transaction-building/caller-datums');
    const { blake2b_256 } = require('@harmoniclabs/crypto');
    const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
    // Constr 0 [{1: 2}, 42] with a definite map and list; Buildooor writes it as d8799fbf0102ff182aff
    const lockedDatum = 'd87982a10102182a';
    const hashLocked = (datum: string): UTxO => ({
      txHash: A, outputIndex: 0, address: SCRIPT_ADDRESS, amount: [{ unit: 'lovelace', quantity: '3000000' }],
      datumHash: hex(blake2b_256(Buffer.from(datum, 'hex'))),
    });
    const spendA = (over: Record<string, unknown>) => {
      const req = request();
      req.scriptInputs[0] = { ...req.scriptInputs[0], ...over };
      return req;
    };
    const ctx = () => context({ utxos: [hashLocked(lockedDatum), scriptUtxo(B), scriptUtxo(C), collateral, funding] });
    const languageViews = (tx: any) => (builder as any)._languageViews(tx);

    it('computes the same scriptDataHash as Buildooor for an unchanged transaction', async () => {
      const { unsignedTxCbor } = await builder.buildUnsignedPlutusTransaction(request(), context());
      const tx = Tx.fromCbor(unsignedTxCbor);
      expect(hex(scriptDataHashOf(Buffer.from(unsignedTxCbor, 'hex'), languageViews(tx)))).toBe(tx.body.scriptDataHash.toString());
    });

    it('puts datumCbor into the witness set byte for byte and hashes the script data over it', async () => {
      const result = await builder.buildUnsignedPlutusTransaction(spendA({ datumCbor: lockedDatum }), ctx());
      expect(result.unsignedTxCbor).toContain(lockedDatum);
      expect(result.unsignedTxCbor).not.toContain('d8799fbf0102ff182aff');
      const tx = Tx.fromCbor(result.unsignedTxCbor);
      expect(hex(scriptDataHashOf(Buffer.from(result.unsignedTxCbor, 'hex'), languageViews(tx)))).toBe(tx.body.scriptDataHash.toString());
      expect(tx.hash.toString()).toBe(result.txBodyHash);
      expect(result.redeemers).toHaveLength(3);
    });

    it('rejects datumCbor that does not hash to the UTxO datum hash', async () => {
      const err = await builder.buildUnsignedPlutusTransaction(spendA({ datumCbor: 'd87980' }), ctx()).catch(e => e);
      expect(err).toBeInstanceOf(TransactionValidationError);
      expect(err.message).toMatch(/^scriptInputs\[0\]\.datumCbor hashes to [0-9a-f]{64}, but .* is locked with datum hash/);
    });

    it('rejects a JSON datum whose encoding differs from the locked bytes, pointing to datumCbor', async () => {
      const datum = { constructor: 0, fields: [{ map: [{ k: { int: 1 }, v: { int: 2 } }] }, { int: 42 }] };
      const err = await builder.buildUnsignedPlutusTransaction(spendA({ datum }), ctx()).catch(e => e);
      expect(err).toBeInstanceOf(TransactionValidationError);
      expect(err.message).toMatch(/datumJson hashes to .*; pass datumCbor/);
    });
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

  describe('forced inputs of other addresses', () => {
    const TOKEN = `${'f6'.repeat(28)}746f6b`;
    const otherKeyHash = Address.fromString(OTHER).paymentCreds.hash.toString();
    // the lender's UTxO: ADA plus a token, at a key address that is not the sender
    const lent: UTxO = { txHash: 'ee'.repeat(32), outputIndex: 0, address: OTHER, amount: [{ unit: 'lovelace', quantity: '10000000' }, { unit: TOKEN, quantity: '100' }] };
    const forceLent = { forceInputs: [{ txHash: lent.txHash, outputIndex: 0 }] };
    const ctx = () => context({ utxos: [scriptUtxo(A), scriptUtxo(B), scriptUtxo(C), collateral, funding, lent] });
    // outputs that spend everything the lender brings: part to the script, the rest back to the lender
    const outputs = [
      { address: SCRIPT_ADDRESS, lovelaceAmount: '3000000', assets: [{ unit: TOKEN, quantity: '60' }], inlineDatum: { constructor: 7, fields: [] } },
      { address: OTHER, lovelaceAmount: '7000000', assets: [{ unit: TOKEN, quantity: '40' }] },
    ];

    it('spends it when the owner co-signs and the outputs spend what it brings; change stays the sender\'s', async () => {
      const tx = Tx.fromCbor((await builder.buildUnsignedPlutusTransaction(
        request({ ...forceLent, outputs, requiredSigners: [otherKeyHash] }), ctx())).unsignedTxCbor);
      expect(tx.body.inputs.map((i: any) => i.utxoRef.id.toString())).toContain(lent.txHash);
      expect((tx.body.collateralInputs ?? []).map((i: any) => i.utxoRef.id.toString())).not.toContain(lent.txHash);
      expect((tx.body.requiredSigners ?? []).map((h: any) => h.toString())).toContain(otherKeyHash);
      const outs = tx.body.outputs;
      expect(outs[1].address.toString()).toBe(OTHER);
      expect(outs[outs.length - 1].address.toString()).toBe(SENDER);
      // the token went where the outputs put it, none of it into the change
      expect(outs[outs.length - 1].value.toUnits().map((u: any) => u.unit)).toEqual(['lovelace']);
    });

    it('refuses it without the owner\'s key hash among the required signers', async () => {
      const err = await builder.buildUnsignedPlutusTransaction(request({ ...forceLent, outputs }), ctx()).catch(e => e);
      expect(err).toBeInstanceOf(TransactionValidationError);
      expect(err.message).toContain(`payment key hash ${otherKeyHash} must be in requiredSigners`);
    });

    it('refuses it when the outputs spend less than it brings', async () => {
      const err = await builder.buildUnsignedPlutusTransaction(
        request({ ...forceLent, requiredSigners: [otherKeyHash] }), ctx()).catch(e => e);
      expect(err).toBeInstanceOf(TransactionValidationError);
      expect(err.message).toMatch(/bring 10000000 lovelace but the outputs spend only 3500000/);
    });

    it('refuses a forced UTxO at a script address', async () => {
      const locked = scriptUtxo('9a'.repeat(32));
      const err = await builder.buildUnsignedPlutusTransaction(
        request({ forceInputs: [{ txHash: locked.txHash, outputIndex: 0 }] }),
        context({ utxos: [scriptUtxo(A), scriptUtxo(B), scriptUtxo(C), collateral, funding, locked] })).catch(e => e);
      expect(err).toBeInstanceOf(TransactionValidationError);
      expect(err.message).toMatch(/at the script address .* spend script UTxOs via scriptInputs/);
    });
  });

  describe('protected inputs', () => {
    const spare: UTxO = { txHash: 'a7'.repeat(32), outputIndex: 0, address: SENDER, amount: [{ unit: 'lovelace', quantity: '30000000' }] };
    const protectFunding = { protectInputs: [{ txHash: funding.txHash, outputIndex: funding.outputIndex }] };

    it('never spends a protected UTxO', async () => {
      // the biggest sender UTxO, so coin selection would pick it first
      const tx = Tx.fromCbor((await builder.buildUnsignedPlutusTransaction(request(protectFunding), context({
        utxos: [scriptUtxo(A), scriptUtxo(B), scriptUtxo(C), collateral, funding, spare],
      }))).unsignedTxCbor);
      const inputs = tx.body.inputs.map((i: any) => i.utxoRef.id.toString());
      expect(inputs).not.toContain(funding.txHash);
      expect(inputs).toContain(spare.txHash);
    });

    it('refuses a UTxO that is forced and protected, or protected and a script input', async () => {
      const both = await builder.buildUnsignedPlutusTransaction(
        request({ ...protectFunding, forceInputs: protectFunding.protectInputs }), context()).catch(e => e);
      expect(both).toBeInstanceOf(TransactionValidationError);
      expect(both.message).toMatch(/is also in protectInputs/);
      const script = await builder.buildUnsignedPlutusTransaction(
        request({ protectInputs: [{ txHash: A, outputIndex: 0 }] }), context()).catch(e => e);
      expect(script).toBeInstanceOf(TransactionValidationError);
      expect(script.message).toMatch(/is also a script input/);
    });
  });

  describe('withdrawals', () => {
    const scriptHash = Script.fromCbor(SCRIPT).hash;
    const scriptStake = new StakeAddress({ network: 'testnet', credentials: new StakeValidatorHash(scriptHash), type: 'script' }).toString();
    const keyStake = new StakeAddress({ network: 'testnet', credentials: new StakeKeyHash('1b'.repeat(28)), type: 'stakeKey' }).toString();
    // certified units for the withdrawal redeemer as well
    const evaluate = async () => [
      ...(await evaluateTransaction()),
      { validator: { purpose: 'withdraw', index: 0 }, budget: { memory: 200_000, cpu: 100_000_000 } },
    ];

    it('withdraws zero under the staking script, by reference when a reference input carries it', async () => {
      const req = request({ withdrawals: [{ rewardAddress: scriptStake, lovelace: '0', stakingScript: SCRIPT, redeemer: { constructor: 0, fields: [] } }] });
      const result = await builder.buildUnsignedPlutusTransaction(req, context({ evaluateTransaction: evaluate }));
      const tx = Tx.fromCbor(result.unsignedTxCbor);
      const entries = tx.body.withdrawals!.map;
      expect(entries).toHaveLength(1);
      expect(entries[0].rewardAccount.toString()).toBe(scriptStake);
      expect(entries[0].amount).toBe(0n);
      const withdraws = (tx.witnesses.redeemers ?? []).filter((r: any) => r.tag === TxRedeemerTag.Withdraw);
      expect(withdraws).toHaveLength(1);
      expect(withdraws[0].index).toBe(0);
      // the script is referenced, not witnessed a second time
      expect(tx.witnesses.plutusV3Scripts ?? []).toHaveLength(0);
      expect(result.redeemers!.filter(r => r.tag === 'Withdraw')).toHaveLength(1);
    });

    it('withdraws from a key reward account without a script and counts the amount as funding', async () => {
      const req = request({ withdrawals: [{ rewardAddress: keyStake, lovelace: '5000000' }] });
      const tx = Tx.fromCbor((await builder.buildUnsignedPlutusTransaction(req, context())).unsignedTxCbor);
      const entries = tx.body.withdrawals!.map;
      expect(entries).toHaveLength(1);
      expect(entries[0].rewardAccount.toString()).toBe(keyStake);
      expect(entries[0].amount).toBe(5000000n);
      expect((tx.witnesses.redeemers ?? []).filter((r: any) => r.tag === TxRedeemerTag.Withdraw)).toHaveLength(0);
    });

    it('rejects a staking reference script whose bytes are not available', async () => {
      const req = request({ withdrawals: [{ rewardAddress: scriptStake, lovelace: '0', referenceScript: { txHash: REF, outputIndex: 0 }, redeemer: { int: 0 } }] });
      req.scriptInputs = req.scriptInputs.slice(0, 2);
      const hashOnly = { ...refScriptUtxo, scriptRefCbor: undefined };
      const err = await builder.buildUnsignedPlutusTransaction(req, context({
        utxos: [scriptUtxo(A), scriptUtxo(B), collateral, funding], referenceInputUtxos: [hashOnly],
      })).catch(e => e);
      expect(err).toBeInstanceOf(TransactionValidationError);
      expect(err.message).toMatch(/withdrawals\[0\]\.referenceScript .* carries no reference script/);
    });

    describe('certificates', () => {
      const evaluateWithCert = async () => [
        ...(await evaluate()),
        { validator: { purpose: 'publish', index: 0 }, budget: { memory: 200_000, cpu: 100_000_000 } },
      ];
      const certs = (tx: any) => (tx.body.certs ?? []) as any[];
      const certRedeemers = (tx: any) => (tx.witnesses.redeemers ?? []).filter((r: any) => r.tag === TxRedeemerTag.Cert);

      it('registers a script credential without a witness (legacy form) and withdraws from it in the same transaction', async () => {
        const req = request({
          certificates: [{ type: 'registerStake', stakeAddress: scriptStake }],
          withdrawals: [{ rewardAddress: scriptStake, lovelace: '0', stakingScript: SCRIPT, redeemer: { constructor: 0, fields: [] } }],
        });
        const tx = Tx.fromCbor((await builder.buildUnsignedPlutusTransaction(req, context({ evaluateTransaction: evaluate }))).unsignedTxCbor);
        expect(certs(tx)).toHaveLength(1);
        expect(certs(tx)[0].certType).toBe(CertificateType.StakeRegistration);
        expect(certs(tx)[0].stakeCredential.hash.toString()).toBe(scriptHash.toString());
        expect(certRedeemers(tx)).toHaveLength(0);
        expect(tx.body.withdrawals!.map).toHaveLength(1);
      });

      it('registers with the staking script in the deposit form, the script runs under the Cert purpose', async () => {
        const req = request({ certificates: [{ type: 'registerStake', stakeAddress: scriptStake, stakingScript: SCRIPT, redeemer: { int: 1 } }] });
        const result = await builder.buildUnsignedPlutusTransaction(req, context({ evaluateTransaction: evaluateWithCert }));
        const tx = Tx.fromCbor(result.unsignedTxCbor);
        expect(certs(tx)[0].certType).toBe(CertificateType.RegistrationDeposit);
        expect(certs(tx)[0].deposit).toBe(2000000n);
        expect(certRedeemers(tx)).toHaveLength(1);
        expect(certRedeemers(tx)[0].index).toBe(0);
        expect(result.redeemers!.filter(r => r.tag === 'Cert')).toHaveLength(1);
      });

      it('deregisters a key credential without a script and a script credential with an explicit deposit', async () => {
        const req = request({ certificates: [
          { type: 'deregisterStake', stakeAddress: keyStake },
          { type: 'deregisterStake', stakeAddress: scriptStake, deposit: '2000000', stakingScript: SCRIPT, redeemer: { int: 2 } },
        ] });
        const tx = Tx.fromCbor((await builder.buildUnsignedPlutusTransaction(req, context({ evaluateTransaction: async () => [
          ...(await evaluate()), { validator: { purpose: 'publish', index: 1 }, budget: { memory: 200_000, cpu: 100_000_000 } },
        ] }))).unsignedTxCbor);
        expect(certs(tx).map((c: any) => c.certType)).toEqual([CertificateType.StakeDeRegistration, CertificateType.UnRegistrationDeposit]);
        expect(certRedeemers(tx).map((r: any) => r.index)).toEqual([1]);
      });

      it.each([
        ['a script whose hash is not the credential', { type: 'registerStake', stakeAddress: keyStake, stakingScript: SCRIPT, redeemer: { int: 0 } }, /is a key credential; it takes no staking script/],
        ['a script credential deregistered without its script', { type: 'deregisterStake', stakeAddress: scriptStake }, /its staking script and redeemer are needed/],
      ])('refuses %s', async (_name, certificate, message) => {
        const err = await builder.buildUnsignedPlutusTransaction(request({ certificates: [certificate as any] }), context()).catch(e => e);
        expect(err).toBeInstanceOf(TransactionValidationError);
        expect(err.message).toMatch(message);
      });

      it('refuses a staking script that is not the credential of the stake address', async () => {
        const otherStake = new StakeAddress({ network: 'testnet', credentials: new StakeValidatorHash('2c'.repeat(28)), type: 'script' }).toString();
        const err = await builder.buildUnsignedPlutusTransaction(
          request({ certificates: [{ type: 'registerStake', stakeAddress: otherStake, stakingScript: SCRIPT, redeemer: { int: 0 } }] }), context()).catch(e => e);
        expect(err).toBeInstanceOf(TransactionValidationError);
        expect(err.message).toMatch(/is not the credential of/);
      });
    });
  });

  describe('reference-input and withdrawal placeholders, mints by reference', () => {
    const P = '01'.repeat(32);
    const paramsUtxo: UTxO = { txHash: P, outputIndex: 0, address: OTHER, amount: [{ unit: 'lovelace', quantity: '2000000' }], inlineDatum: 'd87980' };
    const scriptHash = Script.fromCbor(SCRIPT).hash.toString();
    const scriptStake = new StakeAddress({ network: 'testnet', credentials: new StakeValidatorHash(scriptHash), type: 'script' }).toString();
    const keyStakeOf = (hash: string) => new StakeAddress({ network: 'testnet', credentials: new StakeKeyHash(hash), type: 'stakeKey' }).toString();
    const budget = { memory: 200_000, cpu: 100_000_000 };
    const evaluate = async () => [
      ...(await evaluateTransaction()),
      { validator: { purpose: 'withdraw', index: 0 }, budget },
      { validator: { purpose: 'mint', index: 0 }, budget },
    ];
    const redeemerOfA = (tx: any) => {
      const inputs = tx.body.inputs.map((i: any) => i.utxoRef.id.toString());
      return (tx.witnesses.redeemers ?? []).find((r: any) => r.tag === 0 && inputs[r.index] === A);
    };
    const withParams = (over: Partial<TxBuildPlutusRequest> = {}) => request({ referenceInputs: [{ txHash: P, outputIndex: 0 }], ...over });
    const paramsContext = () => context({ referenceInputUtxos: [refScriptUtxo, paramsUtxo], evaluateTransaction: evaluate });

    it('resolves __REF_IDX__ against the sorted reference inputs, reference-script UTxOs included', async () => {
      const req = withParams();
      req.scriptInputs[0].redeemer = { constructor: 0, fields: [{ int: `__REF_IDX:${P}#0__` }, { int: `__REF_IDX:${REF.toUpperCase()}#0__` }] };
      const tx = Tx.fromCbor((await builder.buildUnsignedPlutusTransaction(req, paramsContext())).unsignedTxCbor);
      const sortedRefs = (tx.body.refInputs ?? []).map((i: any) => i.utxoRef.id.toString()).sort();
      expect(sortedRefs).toEqual([P, REF]);
      expect(redeemerOfA(tx).data.fields.map((f: any) => Number(f.int))).toEqual([0, 1]);
    });

    it('rejects __REF_IDX__ on a UTxO that is not a reference input', async () => {
      const req = withParams();
      req.scriptInputs[0].redeemer = { constructor: 0, fields: [{ int: `__REF_IDX:${A}#0__` }] };
      const err = await builder.buildUnsignedPlutusTransaction(req, paramsContext()).catch(e => e);
      expect(err).toBeInstanceOf(TransactionValidationError);
      expect(err.message).toMatch(/is not a reference input of the transaction/);
    });

    it('resolves __WDRL_IDX__ with script credentials before key credentials', async () => {
      const keyHash = 'ff'.repeat(28);
      const req = request({ withdrawals: [
        { rewardAddress: keyStakeOf(keyHash), lovelace: '0' },
        { rewardAddress: scriptStake, lovelace: '0', stakingScript: SCRIPT, redeemer: { int: 0 } },
      ] });
      req.scriptInputs[0].redeemer = { constructor: 0, fields: [{ int: `__WDRL_IDX:${scriptHash}__` }, { int: `__WDRL_IDX:${keyHash}__` }] };
      const tx = Tx.fromCbor((await builder.buildUnsignedPlutusTransaction(req, context({ evaluateTransaction: evaluate }))).unsignedTxCbor);
      expect(redeemerOfA(tx).data.fields.map((f: any) => Number(f.int))).toEqual([0, 1]);
    });

    it('rejects __WDRL_IDX__ on a credential without a withdrawal', async () => {
      const req = request();
      req.scriptInputs[0].redeemer = { constructor: 0, fields: [{ int: `__WDRL_IDX:${scriptHash}__` }] };
      const err = await builder.buildUnsignedPlutusTransaction(req, context()).catch(e => e);
      expect(err).toBeInstanceOf(TransactionValidationError);
      expect(err.message).toMatch(/has no withdrawal in the transaction/);
    });

    it('refuses a key withdrawal that sorts before a scripted one by hash', async () => {
      const req = request({ withdrawals: [
        { rewardAddress: keyStakeOf('00'.repeat(28)), lovelace: '0' },
        { rewardAddress: scriptStake, lovelace: '0', stakingScript: SCRIPT, redeemer: { int: 0 } },
      ] });
      const err = await builder.buildUnsignedPlutusTransaction(req, context({ evaluateTransaction: evaluate })).catch(e => e);
      expect(err).toBeInstanceOf(TransactionValidationError);
      expect(err.message).toMatch(/cannot be indexed correctly/);
    });

    it('mints under a policy given as reference script, redeemer with __REF_IDX__', async () => {
      const req = withParams({ mintActions: [{
        assetUnit: `${scriptHash}abcd`, quantity: 5n,
        referenceScript: { txHash: REF, outputIndex: 0 }, redeemerJson: { int: `__REF_IDX:${REF}#0__` },
      }] });
      req.outputs[1].assets = [{ unit: `${scriptHash}abcd`, quantity: '5' }];
      const tx = Tx.fromCbor((await builder.buildUnsignedPlutusTransaction(req, paramsContext())).unsignedTxCbor);
      expect(tx.body.mint!.map.find((e: any) => e.policy.toString() === scriptHash)).toBeDefined();
      expect(tx.witnesses.plutusV3Scripts ?? []).toHaveLength(0);
      const mintRedeemers = (tx.witnesses.redeemers ?? []).filter((r: any) => r.tag === TxRedeemerTag.Mint);
      expect(mintRedeemers).toHaveLength(1);
      expect(Number(mintRedeemers[0].data.int)).toBe(1);
      expect((tx.body.refInputs ?? []).map((i: any) => i.utxoRef.id.toString()).filter((h: string) => h === REF)).toHaveLength(1);
    });

    it('rejects a mint whose asset is not under the policy of its reference script', async () => {
      const req = request({ mintActions: [{ assetUnit: `${'ab'.repeat(28)}abcd`, quantity: 5n, referenceScript: { txHash: REF, outputIndex: 0 } }] });
      const err = await builder.buildUnsignedPlutusTransaction(req, context()).catch(e => e);
      expect(err).toBeInstanceOf(TransactionValidationError);
      expect(err.message).toMatch(/mintActions\[0\]\.assetUnit .* is not under the policy/);
    });
  });
  describe('without script inputs', () => {
    const scriptHash = Script.fromCbor(SCRIPT).hash.toString();
    const scriptStake = new StakeAddress({ network: 'testnet', credentials: new StakeValidatorHash(scriptHash), type: 'script' }).toString();
    const keyStake = new StakeAddress({ network: 'testnet', credentials: new StakeKeyHash('1b'.repeat(28)), type: 'stakeKey' }).toString();
    const budget = { memory: 200_000, cpu: 100_000_000 };
    const evaluate = async () => [
      { validator: { purpose: 'mint', index: 0 }, budget },
      { validator: { purpose: 'withdraw', index: 0 }, budget },
    ];
    const keyOnly = () => context({ utxos: [collateral, funding], evaluateTransaction: evaluate });
    const collateralIns = (tx: any) => (tx.body.collateralInputs ?? []).map((i: any) => i.utxoRef.id.toString());

    it('mints by reference script and locks the NFT with an inline datum, spending only key UTxOs', async () => {
      const nft = `${scriptHash}abcd`;
      const req = request({
        scriptInputs: [],
        mintActions: [{ assetUnit: nft, quantity: 1n, referenceScript: { txHash: REF, outputIndex: 0 }, redeemerJson: { constructor: 0, fields: [] } }],
        outputs: [{ address: SCRIPT_ADDRESS, lovelaceAmount: '10000000', assets: [{ unit: nft, quantity: '1' }], inlineDatum: { constructor: 0, fields: [] } }],
      });
      const result = await builder.buildUnsignedPlutusTransaction(req, keyOnly());
      const tx = Tx.fromCbor(result.unsignedTxCbor);

      expect(tx.body.inputs.every((i: any) => [collateral.txHash, funding.txHash].includes(i.utxoRef.id.toString()))).toBe(true);
      const redeemers = tx.witnesses.redeemers ?? [];
      expect(redeemers.map((r: any) => r.tag)).toEqual([TxRedeemerTag.Mint]);
      expect(tx.witnesses.plutusV3Scripts ?? []).toHaveLength(0);
      expect(collateralIns(tx)).toEqual([collateral.txHash]);
      expect(tx.body.outputs[0].address.toString()).toBe(SCRIPT_ADDRESS);
      expect(result.scriptHash).toBe(scriptHash);
    });

    it('withdraws zero under a staking script alone', async () => {
      const req = request({ scriptInputs: [], withdrawals: [{ rewardAddress: scriptStake, lovelace: '0', stakingScript: SCRIPT, redeemer: { constructor: 0, fields: [] } }] });
      const tx = Tx.fromCbor((await builder.buildUnsignedPlutusTransaction(req, keyOnly())).unsignedTxCbor);

      expect((tx.witnesses.redeemers ?? []).map((r: any) => r.tag)).toEqual([TxRedeemerTag.Withdraw]);
      expect(collateralIns(tx)).toEqual([collateral.txHash]);
    });

    it('leaves collateral out when no script runs', async () => {
      const req = request({ scriptInputs: [], withdrawals: [{ rewardAddress: keyStake, lovelace: '0' }] });
      const result = await builder.buildUnsignedPlutusTransaction(req, keyOnly());
      const tx = Tx.fromCbor(result.unsignedTxCbor);

      expect(tx.witnesses.redeemers ?? []).toHaveLength(0);
      expect(collateralIns(tx)).toEqual([]);
      expect(tx.body.collateralReturn).toBeUndefined();
      expect(result.scriptHash).toBeUndefined();
    });
  });

  describe('collateral when the rest cannot pay fee and change', () => {
    const big: UTxO = { txHash: 'f1'.repeat(32), outputIndex: 0, address: SENDER, amount: [{ unit: 'lovelace', quantity: '20000000' }] };
    const small: UTxO = { txHash: 'f2'.repeat(32), outputIndex: 0, address: SENDER, amount: [{ unit: 'lovelace', quantity: '1231961' }] };

    it('also spends the collateral UTxO as an input', async () => {
      // the outputs take the whole value of the three script inputs; fee and change must come from the wallet
      const req = request({ outputs: [{ address: SCRIPT_ADDRESS, lovelaceAmount: '4500000' }, { address: OTHER, lovelaceAmount: '4500000' }] });
      const tx = Tx.fromCbor((await builder.buildUnsignedPlutusTransaction(req, context({
        utxos: [scriptUtxo(A), scriptUtxo(B), scriptUtxo(C), big, small],
      }))).unsignedTxCbor);

      const inputs = tx.body.inputs.map((i: any) => i.utxoRef.id.toString());
      expect(inputs).toContain(big.txHash);
      expect((tx.body.collateralInputs ?? []).map((i: any) => i.utxoRef.id.toString())).toEqual([big.txHash]);
    });
  });
});

