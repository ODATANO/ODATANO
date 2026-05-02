import { BuildooorTxBuilder } from '../../srv/blockchain/transaction-building/buildooor-tx';
import { TxMetadata } from '@harmoniclabs/cardano-ledger-ts/dist/tx/metadata/TxMetadata';
import { TxMetadatumInt, TxMetadatumText, TxMetadatumList, TxMetadatumMap } from '@harmoniclabs/cardano-ledger-ts/dist/tx/metadata/TxMetadatum';
import type { TxBuildMintRequest, TxBuildPlutusSpendRequest, TxBuildContext, UTxO } from '../../srv/utils/types';
import { TransactionValidationError } from '../../srv/utils/errors';

// Test addresses and script hex from integration test fixtures
const TEST_ADDRESS = 'addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp';
const VALID_PLUTUS_SCRIPT = '585401010029800aba2aba1aab9eaab9dab9a4888896600264653001300600198031803800cc0180092225980099b8748000c01cdd500144c9289bae30093008375400516401830060013003375400d149a26cac8009';
const VALID_SPENDING_SCRIPT = '587601010029800aba2aba1aab9eaab9dab9a48888966002646465300130053754003300700398038012444b30013370e9000001c4c9289bae300a3009375400915980099b874800800e2646644944c02c004c02cc030004c024dd5002459007200e18031803800980300098019baa0068a4d13656400401';
const POLICY_ID = 'def68337867cb4f1f95b6b811fedbfcdd7780d10a95cc072077088ea';
const ASSET_NAME = '546f6b656e4d';
const ASSET_UNIT = POLICY_ID + ASSET_NAME;

describe('BuildooorTxBuilder', () => {
  let builder: BuildooorTxBuilder;

  beforeEach(() => {
    builder = new BuildooorTxBuilder();
  });

  describe('_mapOdatanoMetadataToLedgerMetadata', () => {
    const mapMetadata = (value: any) =>
      (builder as any)._mapOdatanoMetadataToLedgerMetadata(value);

    it('should return empty TxMetadata for undefined', () => {
      const result = mapMetadata(undefined);
      expect(result).toBeInstanceOf(TxMetadata);
    });

    it('should return empty TxMetadata for null', () => {
      const result = mapMetadata(null);
      expect(result).toBeInstanceOf(TxMetadata);
    });

    it('should map numeric label with string value', () => {
      const result = mapMetadata({ '721': 'hello' });
      expect(result).toBeInstanceOf(TxMetadata);
    });

    it('should map numeric label with number value', () => {
      const result = mapMetadata({ '1': 42 });
      expect(result).toBeInstanceOf(TxMetadata);
    });

    it('should map multiple labels', () => {
      const result = mapMetadata({ '721': 'nft-data', '1': 100 });
      expect(result).toBeInstanceOf(TxMetadata);
    });
  });

  describe('_jsonToTxMetadatum', () => {
    const toMetadatum = (value: any) =>
      (builder as any)._jsonToTxMetadatum(value);

    it('should convert number to TxMetadatumInt', () => {
      const result = toMetadatum(42);
      expect(result).toBeInstanceOf(TxMetadatumInt);
    });

    it('should convert string to TxMetadatumText', () => {
      const result = toMetadatum('hello');
      expect(result).toBeInstanceOf(TxMetadatumText);
    });

    it('should convert array to TxMetadatumList', () => {
      const result = toMetadatum([1, 'two', 3]);
      expect(result).toBeInstanceOf(TxMetadatumList);
    });

    it('should convert object to TxMetadatumMap', () => {
      const result = toMetadatum({ key: 'value' });
      expect(result).toBeInstanceOf(TxMetadatumMap);
    });

    it('should throw on unsupported type (boolean)', () => {
      expect(() => toMetadatum(true)).toThrow('Unsupported metadata value type');
    });
  });

  // =========================================================================
  // buildUnsignedTransfer — branch coverage
  // =========================================================================

  describe('buildUnsignedTransfer — branch coverage', () => {
    it('should throw insufficient funds when no UTxOs are provided', async () => {
      const req = {
        network: 'preview',
        senderAddress: TEST_ADDRESS,
        recipientAddress: TEST_ADDRESS,
        lovelaceAmount: 2000000,
      } as any;

      const ctx = {
        utxos: [],
        protocolParameters: {} as any,
      } as any;

      await expect(builder.buildUnsignedTransfer(req, ctx)).rejects.toThrow('Insufficient lovelace');
    });
  });

  // =========================================================================
  // buildUnsignedMintTransaction — error/branch paths
  // =========================================================================

  describe('buildUnsignedMintTransaction — branch coverage', () => {
    it('should exercise inlineDatum path before throwing on no ADA-only collateral', async () => {
      // UTxOs with native assets only — no ADA-only UTxO for collateral
      const multiAssetUtxo: UTxO = {
        txHash: 'abcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcd',
        outputIndex: 0,
        address: TEST_ADDRESS,
        amount: [
          { unit: 'lovelace', quantity: '10000000' },
          { unit: ASSET_UNIT, quantity: '100' },
        ],
      };

      const req: TxBuildMintRequest = {
        network: 'preview',
        senderAddress: TEST_ADDRESS,
        recipientAddress: TEST_ADDRESS,
        lovelaceAmount: 2000000,
        mintActions: [{ assetUnit: ASSET_UNIT, quantity: 1n }],
        mintingPolicyScript: VALID_PLUTUS_SCRIPT,
        inlineDatum: { constructor: 0, fields: [] },  // exercises lines 257-259
      };

      const ctx: TxBuildContext = {
        utxos: [multiAssetUtxo],  // no ADA-only → throws at 265-267
        protocolParameters: {} as any,
      };

      await expect(builder.buildUnsignedMintTransaction(req, ctx))
        .rejects.toThrow('No ADA-only UTxO available for collateral');
    });
  });

  // =========================================================================
  // buildUnsignedPlutusSpendTransaction — error/branch paths
  // =========================================================================

  describe('buildUnsignedPlutusSpendTransaction — branch coverage', () => {
    it('should throw when script UTxO is not found in ctx.utxos', async () => {
      const req: TxBuildPlutusSpendRequest = {
        network: 'preview',
        senderAddress: TEST_ADDRESS,
        recipientAddress: TEST_ADDRESS,
        lovelaceAmount: 2000000,
        plutusScriptExecution: {
          validatorScript: VALID_SPENDING_SCRIPT,
          scriptUtxo: { txHash: 'aaaa'.repeat(16), outputIndex: 0 },
          redeemer: { constructor: 0, fields: [] },
        },
      };

      // ctx.utxos does NOT contain the referenced script UTxO
      const ctx: TxBuildContext = {
        utxos: [{
          txHash: 'bbbb'.repeat(16),
          outputIndex: 0,
          address: TEST_ADDRESS,
          amount: [{ unit: 'lovelace', quantity: '10000000' }],
        }],
        protocolParameters: {} as any,
      };

      await expect(builder.buildUnsignedPlutusSpendTransaction(req, ctx))
        .rejects.toThrow('Script UTxO');
      await expect(builder.buildUnsignedPlutusSpendTransaction(req, ctx))
        .rejects.toThrow('not found in provided UTxOs');
    });

    it('should throw when no ADA-only collateral — also exercises changeAddress fallback and multi-asset loop', async () => {
      const scriptTxHash = '1234123412341234123412341234123412341234123412341234123412341234';

      // Script UTxO has lovelace + native asset → exercises multi-asset loop (lines 427-432)
      const scriptUtxo: UTxO = {
        txHash: scriptTxHash,
        outputIndex: 0,
        address: TEST_ADDRESS,
        amount: [
          { unit: 'lovelace', quantity: '5000000' },
          { unit: ASSET_UNIT, quantity: '1' },
        ],
      };

      // Funding UTxO also has native assets → no ADA-only UTxO for collateral
      const fundingUtxo: UTxO = {
        txHash: 'abcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcd',
        outputIndex: 0,
        address: TEST_ADDRESS,
        amount: [
          { unit: 'lovelace', quantity: '10000000' },
          { unit: ASSET_UNIT, quantity: '50' },
        ],
      };

      const req: TxBuildPlutusSpendRequest = {
        network: 'preview',
        senderAddress: TEST_ADDRESS,
        recipientAddress: TEST_ADDRESS,
        lovelaceAmount: 2000000,
        // No changeAddress → exercises fallback to senderAddress (line 422)
        plutusScriptExecution: {
          validatorScript: VALID_SPENDING_SCRIPT,
          scriptUtxo: { txHash: scriptTxHash, outputIndex: 0 },
          redeemer: { constructor: 0, fields: [] },
        },
      };

      const ctx: TxBuildContext = {
        utxos: [scriptUtxo, fundingUtxo],
        protocolParameters: {} as any,
      };

      await expect(builder.buildUnsignedPlutusSpendTransaction(req, ctx))
        .rejects.toThrow('No ADA-only UTxO available for collateral');
    });
  });

  // =========================================================================
  // _partitionForcedInputs — pure function tests
  // =========================================================================

  describe('_partitionForcedInputs', () => {
    const partition = (utxos: UTxO[], forceInputs?: Array<{ txHash: string; outputIndex: number }>) =>
      (builder as any)._partitionForcedInputs(utxos, forceInputs);

    const mkUtxo = (txHash: string, outputIndex: number, lovelace = '5000000'): UTxO => ({
      txHash, outputIndex, address: TEST_ADDRESS,
      amount: [{ unit: 'lovelace', quantity: lovelace }],
    });

    it('should split UTxOs into forced and rest (1 of 3 forced)', () => {
      const utxos = [mkUtxo('aaaa', 0), mkUtxo('bbbb', 0), mkUtxo('cccc', 0)];
      const { forced, rest } = partition(utxos, [{ txHash: 'bbbb', outputIndex: 0 }]);

      expect(forced).toHaveLength(1);
      expect(forced[0].txHash).toBe('bbbb');
      expect(rest).toHaveLength(2);
      expect(rest.map((u: UTxO) => u.txHash)).toEqual(['aaaa', 'cccc']);
    });

    it('should return all UTxOs as rest when forceInputs is undefined', () => {
      const utxos = [mkUtxo('aaaa', 0), mkUtxo('bbbb', 0)];
      const { forced, rest } = partition(utxos, undefined);

      expect(forced).toHaveLength(0);
      expect(rest).toBe(utxos); // same reference (short-circuit)
    });

    it('should return all UTxOs as rest when forceInputs is empty array', () => {
      const utxos = [mkUtxo('aaaa', 0)];
      const { forced, rest } = partition(utxos, []);

      expect(forced).toHaveLength(0);
      expect(rest).toEqual(utxos);
    });

    it('should silently ignore refs not present in the UTxO pool', () => {
      const utxos = [mkUtxo('aaaa', 0), mkUtxo('bbbb', 0)];
      const { forced, rest } = partition(utxos, [
        { txHash: 'ffff', outputIndex: 0 }, // not in pool
        { txHash: 'aaaa', outputIndex: 0 }, // in pool
      ]);

      expect(forced).toHaveLength(1);
      expect(forced[0].txHash).toBe('aaaa');
      expect(rest).toHaveLength(1);
      expect(rest[0].txHash).toBe('bbbb');
    });

    it('should distinguish by outputIndex when txHash matches multiple entries', () => {
      const utxos = [mkUtxo('aaaa', 0), mkUtxo('aaaa', 1), mkUtxo('aaaa', 2)];
      const { forced, rest } = partition(utxos, [{ txHash: 'aaaa', outputIndex: 1 }]);

      expect(forced).toHaveLength(1);
      expect(forced[0].outputIndex).toBe(1);
      expect(rest.map((u: UTxO) => u.outputIndex)).toEqual([0, 2]);
    });

    it('should handle multiple forced refs in one call', () => {
      const utxos = [mkUtxo('aaaa', 0), mkUtxo('bbbb', 0), mkUtxo('cccc', 0), mkUtxo('dddd', 0)];
      const { forced, rest } = partition(utxos, [
        { txHash: 'aaaa', outputIndex: 0 },
        { txHash: 'cccc', outputIndex: 0 },
      ]);

      expect(forced).toHaveLength(2);
      expect(forced.map((u: UTxO) => u.txHash).sort()).toEqual(['aaaa', 'cccc']);
      expect(rest).toHaveLength(2);
      expect(rest.map((u: UTxO) => u.txHash).sort()).toEqual(['bbbb', 'dddd']);
    });
  });

  // =========================================================================
  // FR-2: _appendExtraOutputs — extraOutputs handling
  // =========================================================================

  describe('_appendExtraOutputs (FR-2)', () => {
    // Initialised builder with mocked Buildooor TxBuilder that exposes getMinimumOutputLovelaces.
    // We avoid full init() because that needs a CardanoClient; the helper only uses txBuilder.
    let initialisedBuilder: BuildooorTxBuilder;

    beforeEach(() => {
      initialisedBuilder = new BuildooorTxBuilder();
      // Inject a minimal txBuilder stub: returns a fixed min-ADA so we can drive the guard predictably.
      (initialisedBuilder as any).txBuilder = {
        getMinimumOutputLovelaces: jest.fn(() => 1_500_000n),
      };
    });

    const append = (outputs: any[], extras: any) =>
      (initialisedBuilder as any)._appendExtraOutputs(outputs, extras);

    const validExtra = { address: TEST_ADDRESS, lovelaceAmount: '2000000' };

    it('appends multiple extra outputs in declared order', () => {
      const outputs: any[] = [];
      append(outputs, [
        { ...validExtra, lovelaceAmount: '2000000' },
        { ...validExtra, lovelaceAmount: '3000000' },
        { ...validExtra, lovelaceAmount: '4000000' },
      ]);
      expect(outputs).toHaveLength(3);
      expect(outputs[0].value.lovelaces.toString()).toBe('2000000');
      expect(outputs[1].value.lovelaces.toString()).toBe('3000000');
      expect(outputs[2].value.lovelaces.toString()).toBe('4000000');
    });

    it('throws TransactionValidationError with min-ADA hint when lovelaceAmount is below required min', () => {
      const outputs: any[] = [];
      expect(() => append(outputs, [{ ...validExtra, lovelaceAmount: '500000' }]))
        .toThrow(TransactionValidationError);
      expect(() => append(outputs, [{ ...validExtra, lovelaceAmount: '500000' }]))
        .toThrow(/below required min-ADA/);
    });

    it('attaches inline datum when inlineDatum is provided on the extra output', () => {
      const outputs: any[] = [];
      append(outputs, [{ ...validExtra, inlineDatum: { constructor: 0, fields: [{ int: 7 }] } }]);
      expect(outputs).toHaveLength(1);
      expect(outputs[0].datum).toBeDefined();
    });

    it('builds the TxOut with native assets via _buildLedgerValue', () => {
      const outputs: any[] = [];
      append(outputs, [{
        ...validExtra,
        lovelaceAmount: '2500000',
        assets: [{ unit: ASSET_UNIT, quantity: '5' }],
      }]);
      expect(outputs).toHaveLength(1);
      // Buildooor's Value exposes the asset under the policy hash; smoke-check it is non-empty
      expect(outputs[0].value.toCborObj).toBeDefined();
    });

    it('is a no-op when extraOutputs is undefined or empty', () => {
      const outputs: any[] = [];
      append(outputs, undefined);
      append(outputs, []);
      expect(outputs).toHaveLength(0);
    });
  });

  // =========================================================================
  // FR-3: _computeSortedInputs / _resolveExtraOutputPlaceholders / _extractFundingRefs
  // =========================================================================

  describe('_computeSortedInputs (FR-3)', () => {
    const compute = (script: any, forced: any[], funding: any[]) =>
      (builder as any)._computeSortedInputs(script, forced, funding);

    const mkUtxo = (txHash: string, outputIndex: number): UTxO => ({
      txHash, outputIndex, address: TEST_ADDRESS,
      amount: [{ unit: 'lovelace', quantity: '5000000' }],
    });

    it('places script + forced + funding refs into single Buildooor-equivalent lex order', () => {
      const script = { txHash: 'aa'.repeat(32), outputIndex: 0 };
      const forced = [mkUtxo('cc'.repeat(32), 0)];
      const funding = [{ txHash: 'bb'.repeat(32), outputIndex: 0 }];

      const sorted = compute(script, forced, funding);
      expect(sorted.map((r: any) => r.txHash)).toEqual([
        'aa'.repeat(32), 'bb'.repeat(32), 'cc'.repeat(32),
      ]);
    });

    it('keeps tie-breaks on outputIndex within identical txHashes', () => {
      const script = { txHash: 'aa'.repeat(32), outputIndex: 1 };
      const forced = [mkUtxo('aa'.repeat(32), 0)];
      const funding = [{ txHash: 'aa'.repeat(32), outputIndex: 2 }];

      const sorted = compute(script, forced, funding);
      expect(sorted.map((r: any) => r.outputIndex)).toEqual([0, 1, 2]);
    });
  });

  describe('_resolveExtraOutputPlaceholders (FR-3)', () => {
    const resolve = (extras: any, sortedInputs: any[]) =>
      (builder as any)._resolveExtraOutputPlaceholders(extras, { sortedInputs });

    const SORTED = [
      { txHash: 'aa'.repeat(32), outputIndex: 0 },
      { txHash: 'bb'.repeat(32), outputIndex: 0 },
    ];

    it('returns undefined or empty unchanged (no-op)', () => {
      expect(resolve(undefined, SORTED)).toBeUndefined();
      expect(resolve([], SORTED)).toEqual([]);
    });

    it('passes through entries that have no inlineDatum', () => {
      const input = [{ address: 'addr', lovelaceAmount: '2000000' }];
      const out = resolve(input, SORTED);
      expect(out[0].inlineDatum).toBeUndefined();
      expect(out[0].address).toBe('addr');
    });

    it('replaces placeholders inside extraOutputs[i].inlineDatum and preserves other fields', () => {
      const input = [{
        address: 'addr',
        lovelaceAmount: '2000000',
        inlineDatum: { constructor: 0, fields: [{ int: `__INPUT_IDX:${'bb'.repeat(32)}#0__` }] },
      }];
      const out = resolve(input, SORTED);
      expect(out[0].inlineDatum).toEqual({ constructor: 0, fields: [{ int: 1 }] });
      expect(out[0].address).toBe('addr');
      expect(out[0].lovelaceAmount).toBe('2000000');
    });
  });

  describe('_extractFundingRefs (FR-3)', () => {
    const extract = (inputs: any[]) => (builder as any)._extractFundingRefs(inputs);

    it('maps Buildooor funding-input shape to InputRef list (txHash + outputIndex)', () => {
      const fundingInputs = [
        { utxo: { utxoRef: { id: { toString: () => 'aa'.repeat(32) }, index: 1 } } },
        { utxo: { utxoRef: { id: { toString: () => 'bb'.repeat(32) }, index: 2 } } },
      ];
      expect(extract(fundingInputs)).toEqual([
        { txHash: 'aa'.repeat(32), outputIndex: 1 },
        { txHash: 'bb'.repeat(32), outputIndex: 2 },
      ]);
    });
  });

  // =========================================================================
  // FR-1: Combined spend+mint — branch / extra-field coverage
  // =========================================================================

  describe('buildUnsignedPlutusSpendTransaction — combined spend+mint (FR-1)', () => {
    it('exercises the hasMint branch (parses mintingPolicyScript) before failing on no ADA-only collateral', async () => {
      // ALL UTxOs carry native assets → no ADA-only available → throws AFTER FR-1 setup ran.
      const scriptTxHash = '1234123412341234123412341234123412341234123412341234123412341234';
      const scriptUtxo: UTxO = {
        txHash: scriptTxHash,
        outputIndex: 0,
        address: TEST_ADDRESS,
        amount: [
          { unit: 'lovelace', quantity: '5000000' },
          { unit: ASSET_UNIT, quantity: '1' },
        ],
      };
      const fundingUtxo: UTxO = {
        txHash: 'abcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcd',
        outputIndex: 0,
        address: TEST_ADDRESS,
        amount: [
          { unit: 'lovelace', quantity: '10000000' },
          { unit: ASSET_UNIT, quantity: '50' },
        ],
      };

      const req: TxBuildPlutusSpendRequest = {
        network: 'preview',
        senderAddress: TEST_ADDRESS,
        recipientAddress: TEST_ADDRESS,
        lovelaceAmount: 2000000,
        plutusScriptExecution: {
          validatorScript: VALID_SPENDING_SCRIPT,
          scriptUtxo: { txHash: scriptTxHash, outputIndex: 0 },
          redeemer: { constructor: 0, fields: [] },
        },
        // FR-1 inputs:
        mintActions: [{ assetUnit: ASSET_UNIT, quantity: 1n }],
        mintingPolicyScript: VALID_PLUTUS_SCRIPT,
        mintRedeemer: { constructor: 0, fields: [] },
      };

      const ctx: TxBuildContext = {
        utxos: [scriptUtxo, fundingUtxo],
        protocolParameters: {} as any,
      };

      // FR-1 setup runs (Script.fromCbor on mintingPolicyScript), then setup throws on collateral
      await expect(builder.buildUnsignedPlutusSpendTransaction(req, ctx))
        .rejects.toThrow('No ADA-only UTxO available for collateral');
    });

    it('skips FR-1 setup entirely when mintActions is empty (no mintScriptHash branch)', async () => {
      const scriptTxHash = '5678567856785678567856785678567856785678567856785678567856785678';
      const scriptUtxo: UTxO = {
        txHash: scriptTxHash,
        outputIndex: 0,
        address: TEST_ADDRESS,
        amount: [{ unit: 'lovelace', quantity: '5000000' }, { unit: ASSET_UNIT, quantity: '1' }],
      };
      const fundingUtxo: UTxO = {
        txHash: 'cdefcdefcdefcdefcdefcdefcdefcdefcdefcdefcdefcdefcdefcdefcdefcdef',
        outputIndex: 0,
        address: TEST_ADDRESS,
        amount: [{ unit: 'lovelace', quantity: '10000000' }, { unit: ASSET_UNIT, quantity: '50' }],
      };

      const req: TxBuildPlutusSpendRequest = {
        network: 'preview',
        senderAddress: TEST_ADDRESS,
        recipientAddress: TEST_ADDRESS,
        lovelaceAmount: 2000000,
        plutusScriptExecution: {
          validatorScript: VALID_SPENDING_SCRIPT,
          scriptUtxo: { txHash: scriptTxHash, outputIndex: 0 },
          redeemer: { constructor: 0, fields: [] },
        },
        mintActions: [], // empty → hasMint = false
      };

      const ctx: TxBuildContext = {
        utxos: [scriptUtxo, fundingUtxo],
        protocolParameters: {} as any,
      };

      // Reaches collateral check identically; just confirms the empty-mint branch is non-fatal.
      await expect(builder.buildUnsignedPlutusSpendTransaction(req, ctx))
        .rejects.toThrow('No ADA-only UTxO available for collateral');
    });
  });

  describe('_buildResult — mintScriptHash forwarding (FR-1)', () => {
    beforeEach(() => {
      (builder as any).cardanoClient = { network: 'preview' };
    });

    it('includes mintScriptHash in the result when supplied via extra', () => {
      const buildResult = (req: any, ctx: any, txDetails: any, extra: any) =>
        (builder as any)._buildResult(req, ctx, txDetails, extra);

      const result = buildResult(
        { senderAddress: TEST_ADDRESS, network: 'preview' },
        { utxos: [] },
        { unsignedTxCbor: 'aa', txBodyHash: 'bb', sizeBytes: 1, feeLovelace: '0', inputRefs: [], outputs: [] },
        { scriptHash: 'spend-hash', mintScriptHash: 'mint-hash', forcedInputsUsed: 0 }
      );
      expect(result.scriptHash).toBe('spend-hash');
      expect(result.mintScriptHash).toBe('mint-hash');
    });

    it('omits mintScriptHash when not provided in extra', () => {
      const buildResult = (req: any, ctx: any, txDetails: any, extra: any) =>
        (builder as any)._buildResult(req, ctx, txDetails, extra);

      const result = buildResult(
        { senderAddress: TEST_ADDRESS, network: 'preview' },
        { utxos: [] },
        { unsignedTxCbor: 'aa', txBodyHash: 'bb', sizeBytes: 1, feeLovelace: '0', inputRefs: [], outputs: [] },
        { scriptHash: 'spend-hash' }
      );
      expect(result.scriptHash).toBe('spend-hash');
      expect(result.mintScriptHash).toBeUndefined();
    });
  });

  // =========================================================================
  // _parseReferenceScript — CIP-33 reference script attachment
  // =========================================================================

  describe('_parseReferenceScript', () => {
    const parseRefScript = (hex: string | undefined) => (builder as any)._parseReferenceScript(hex);

    it('returns undefined when hex is missing', () => {
      expect(parseRefScript(undefined)).toBeUndefined();
      expect(parseRefScript('')).toBeUndefined();
    });

    it('parses a valid PlutusV3 CBOR hex into a Script', () => {
      const script = parseRefScript(VALID_PLUTUS_SCRIPT);
      expect(script).toBeDefined();
      expect(typeof script.hash.toString()).toBe('string');
      expect(script.hash.toString()).toHaveLength(56);
    });

    it('throws TransactionValidationError on malformed CBOR', () => {
      expect(() => parseRefScript('zznothex')).toThrow(TransactionValidationError);
      expect(() => parseRefScript('zznothex')).toThrow(/Invalid referenceScript CBOR/);
    });
  });

  describe('_buildTxOut — refScript parameter', () => {
    it('constructs TxOut without refScript when not supplied', () => {
      const { Address, Value } = require('@harmoniclabs/cardano-ledger-ts');
      const addr = Address.fromString(TEST_ADDRESS);
      const out = (builder as any)._buildTxOut(addr, Value.lovelaces(2000000n));
      expect(out).toBeDefined();
      expect(out.refScript).toBeUndefined();
    });

    it('attaches refScript when Script is supplied', () => {
      const { Address, Value } = require('@harmoniclabs/cardano-ledger-ts');
      const addr = Address.fromString(TEST_ADDRESS);
      const script = (builder as any)._parseReferenceScript(VALID_PLUTUS_SCRIPT);
      const out = (builder as any)._buildTxOut(addr, Value.lovelaces(20000000n), undefined, script);
      expect(out.refScript).toBeDefined();
      expect(out.refScript.hash.toString()).toBe(script.hash.toString());
    });
  });

  // =========================================================================
  // _buildInputRefScript — input-side refScript preservation (Fix C)
  // =========================================================================

  describe('_buildInputRefScript', () => {
    const buildInputRefScript = (utxo: any) => (builder as any)._buildInputRefScript(utxo);
    const makeUtxo = (scriptRef: string | null | undefined): any => ({
      txHash: '2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83',
      outputIndex: 0,
      address: TEST_ADDRESS,
      amount: [{ unit: 'lovelace', quantity: '2000000' }],
      scriptRef,
    });

    it('returns undefined when scriptRef is absent', () => {
      expect(buildInputRefScript(makeUtxo(undefined))).toBeUndefined();
      expect(buildInputRefScript(makeUtxo(null))).toBeUndefined();
    });

    it('returns undefined for hash-only scriptRef (56 hex chars) — Blockfrost/Ogmios case', () => {
      const hashOnly = 'a'.repeat(56);
      expect(buildInputRefScript(makeUtxo(hashOnly))).toBeUndefined();
    });

    it('parses full-bytes scriptRef into a Script — Koios case', () => {
      const script = buildInputRefScript(makeUtxo(VALID_PLUTUS_SCRIPT));
      expect(script).toBeDefined();
      expect(script.hash.toString()).toHaveLength(56);
    });

    it('returns undefined (no throw) on malformed scriptRef', () => {
      const malformed = 'zz' + VALID_PLUTUS_SCRIPT.slice(2);
      expect(() => buildInputRefScript(makeUtxo(malformed))).not.toThrow();
      expect(buildInputRefScript(makeUtxo(malformed))).toBeUndefined();
    });
  });

  // =========================================================================
  // _appendExtraOutputs — per-entry refScript (Fix A)
  // =========================================================================

  describe('_appendExtraOutputs — per-entry referenceScript', () => {
    it('attaches refScript to extra outputs that supply referenceScript', () => {
      // Stub txBuilder.getMinimumOutputLovelaces — bypass real protocol-params dependency
      (builder as any).txBuilder = { getMinimumOutputLovelaces: () => 0n };
      const outs: any[] = [];
      (builder as any)._appendExtraOutputs(outs, [
        {
          address: TEST_ADDRESS,
          lovelaceAmount: '20000000',
          referenceScript: VALID_PLUTUS_SCRIPT,
        },
      ]);
      expect(outs).toHaveLength(1);
      expect(outs[0].refScript).toBeDefined();
      expect(outs[0].refScript.hash.toString()).toHaveLength(56);
    });

    it('emits plain extra outputs (no refScript) when referenceScript is omitted', () => {
      (builder as any).txBuilder = { getMinimumOutputLovelaces: () => 0n };
      const outs: any[] = [];
      (builder as any)._appendExtraOutputs(outs, [
        { address: TEST_ADDRESS, lovelaceAmount: '2000000' },
      ]);
      expect(outs).toHaveLength(1);
      expect(outs[0].refScript).toBeUndefined();
    });
  });

  // =========================================================================
  // _resolveValiditySlots — validity window resolution
  // =========================================================================

  describe('_resolveValiditySlots', () => {
    // Use preview preset: systemStartPosixMs 1666656000000, slotLengthMs 1000, startSlotNo 0.
    // posixToSlot(ms) = floor((ms - systemStart) / slotLength) + startSlotNo.
    const PREVIEW_SYSTEM_START_MS = 1666656000000;
    const fakePosixToSlot = (ms: number) => Math.floor((ms - PREVIEW_SYSTEM_START_MS) / 1000);

    const resolve = (req: any, mode: 'script' | 'passthrough') =>
      (builder as any)._resolveValiditySlots(req, mode);

    beforeEach(() => {
      (builder as any).txBuilder = { posixToSlot: fakePosixToSlot };
    });

    it('returns converted slots when both validity bounds are explicit (script mode)', () => {
      const startMs = 1700000000000;
      const endMs = 1700003600000;
      const { invalidBefore, invalidAfter } = resolve({ validityStartMs: String(startMs), validityEndMs: String(endMs) }, 'script');

      expect(invalidBefore).toBe(BigInt(fakePosixToSlot(startMs)));
      expect(invalidAfter).toBe(BigInt(fakePosixToSlot(endMs)));
      expect(invalidAfter! > invalidBefore!).toBe(true);
    });

    it('falls back to now-2min / now+1h defaults when bounds are absent (script mode)', () => {
      const frozen = 1700000000000;
      const spy = jest.spyOn(Date, 'now').mockReturnValue(frozen);
      try {
        const { invalidBefore, invalidAfter } = resolve({}, 'script');
        expect(invalidBefore).toBe(BigInt(fakePosixToSlot(frozen - 120_000)));
        expect(invalidAfter).toBe(BigInt(fakePosixToSlot(frozen + 3_600_000)));
      } finally {
        spy.mockRestore();
      }
    });

    it('returns empty object in passthrough mode when no bounds are provided', () => {
      const result = resolve({}, 'passthrough');
      expect(result).toEqual({});
    });

    it('applies bounds in passthrough mode only when explicitly set', () => {
      const { invalidBefore, invalidAfter } = resolve({ validityStartMs: '1700000000000', validityEndMs: '1700003600000' }, 'passthrough');
      expect(invalidBefore).toBeDefined();
      expect(invalidAfter).toBeDefined();
    });

    // Regression: passthrough must not default the unspecified bound, otherwise
    // `validityStartMs` alone could produce invalidBefore > invalidAfter and the
    // ledger would reject on submit.
    it('emits only invalidBefore when passthrough supplies just validityStartMs', () => {
      const startMs = 1700000000000;
      const result = resolve({ validityStartMs: String(startMs) }, 'passthrough');
      expect(result.invalidBefore).toBe(BigInt(fakePosixToSlot(startMs)));
      expect(result.invalidAfter).toBeUndefined();
    });

    it('emits only invalidAfter when passthrough supplies just validityEndMs', () => {
      const endMs = 1700003600000;
      const result = resolve({ validityEndMs: String(endMs) }, 'passthrough');
      expect(result.invalidAfter).toBe(BigInt(fakePosixToSlot(endMs)));
      expect(result.invalidBefore).toBeUndefined();
    });
  });

  // =========================================================================
  // _evaluateExUnits — relative multiplier + absolute cushion
  // =========================================================================

  describe('_evaluateExUnits', () => {
    const evaluateExUnits = async (evaluator?: any) => {
      const buildEvalTx = async () => 'deadbeef';
      return (builder as any)._evaluateExUnits(buildEvalTx, evaluator);
    };

    it('returns defaults when no evaluator is provided', async () => {
      const result = await evaluateExUnits(undefined);
      expect(typeof result.mem).toBe('number');
      expect(typeof result.cpu).toBe('number');
    });

    // Regression: tiny validators were hitting ledger overspend by ~10k–30k CPU
    // because metadata presence shifted the real tx body vs evaluator's simulated
    // ScriptContext. Fixed absolute cushion (ABS_*_BUFFER) guards that gap.
    it('adds absolute cushion on top of the relative buffer for small budgets', async () => {
      const tinyEvaluator = async () => [{ budget: { memory: 100, cpu: 1000 } }];
      const result = await evaluateExUnits(tinyEvaluator);
      // mem: ceil(100 * 1.1) + 1000 = 1110
      expect(result.mem).toBeGreaterThanOrEqual(1100);
      // cpu: ceil(1000 * 1.1) + 50000 = 51100
      expect(result.cpu).toBeGreaterThanOrEqual(51000);
    });

    it('keeps proportional scaling for large budgets', async () => {
      const bigEvaluator = async () => [{ budget: { memory: 10_000_000, cpu: 10_000_000_000 } }];
      const result = await evaluateExUnits(bigEvaluator);
      expect(result.mem).toBeGreaterThanOrEqual(11_000_000);
      expect(result.cpu).toBeGreaterThanOrEqual(11_000_000_000);
    });
  });
});
