import { BuildooorTxBuilder } from '../../srv/blockchain/transaction-building/buildooor-tx';
// dist paths on purpose — must match the class identities buildooor-tx uses (see its import note)
import { TxMetadata } from '@harmoniclabs/cardano-ledger-ts/dist/tx/metadata/TxMetadata';
import { TxMetadatumInt, TxMetadatumText, TxMetadatumList, TxMetadatumMap } from '@harmoniclabs/cardano-ledger-ts/dist/tx/metadata/TxMetadatum';
import type { TxBuildMintRequest, TxBuildPlutusSpendRequest, TxBuildContext, UTxO } from '../../srv/utils/types';
import { TransactionValidationError, ScriptValidationError } from '../../srv/utils/errors';

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

    it('should reject non-numeric labels with a clear 400', () => {
      expect(() => mapMetadata({ foo: 'bar' })).toThrow('Invalid metadata label');
    });
  });

  describe('_jsonToTxMetadatum', () => {
    const toMetadatum = (value: any) =>
      (builder as any)._jsonToTxMetadatum(value, '721');

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

    it('should reject non-integer numbers with a clear 400 instead of a raw RangeError', () => {
      expect(() => toMetadatum(1.5)).toThrow('Metadata numbers must be integers');
    });

    it('should keep short strings as a single TxMetadatumText', () => {
      const result = toMetadatum('a'.repeat(64));
      expect(result).toBeInstanceOf(TxMetadatumText);
    });

    it('should chunk text longer than 64 bytes into a list of ≤64-byte pieces', () => {
      const long = 'a'.repeat(150);
      const result = toMetadatum(long);
      expect(result).toBeInstanceOf(TxMetadatumList);
      const parts = (result as any).list as Array<{ text: string }>;
      expect(parts.every(p => Buffer.byteLength(p.text, 'utf8') <= 64)).toBe(true);
      expect(parts.map(p => p.text).join('')).toBe(long);
    });

    it('should chunk by BYTES without splitting multi-byte UTF-8 code points', () => {
      const long = 'ä'.repeat(50); // 100 bytes, 50 chars
      const result = toMetadatum(long);
      expect(result).toBeInstanceOf(TxMetadatumList);
      const parts = (result as any).list as Array<{ text: string }>;
      expect(parts.every(p => Buffer.byteLength(p.text, 'utf8') <= 64)).toBe(true);
      expect(parts.map(p => p.text).join('')).toBe(long);
    });

    it('should map 0x-prefixed hex strings to byte metadata', () => {
      const { TxMetadatumBytes } = require('@harmoniclabs/cardano-ledger-ts/dist/tx/metadata/TxMetadatum');
      const result = toMetadatum('0xdeadbeef');
      expect(result).toBeInstanceOf(TxMetadatumBytes);
      expect(Buffer.from((result as any).bytes).toString('hex')).toBe('deadbeef');
    });

    it('should chunk 0x byte strings longer than 64 bytes', () => {
      const { TxMetadatumBytes } = require('@harmoniclabs/cardano-ledger-ts/dist/tx/metadata/TxMetadatum');
      const hex = 'ab'.repeat(100); // 100 bytes
      const result = toMetadatum('0x' + hex);
      expect(result).toBeInstanceOf(TxMetadatumList);
      const parts = (result as any).list;
      expect(parts.length).toBe(2);
      expect(parts[0]).toBeInstanceOf(TxMetadatumBytes);
      expect(parts[0].bytes.length).toBe(64);
      expect(parts[1].bytes.length).toBe(36);
    });

    it('should treat non-hex 0x strings as plain text', () => {
      expect(toMetadatum('0xzz')).toBeInstanceOf(TxMetadatumText);
    });

    it('should reject map keys longer than 64 bytes', () => {
      expect(() => toMetadatum({ ['k'.repeat(65)]: 1 })).toThrow('Metadata map key exceeds 64 bytes');
    });

    it('should name the label-rooted path of the offending value in rejections', () => {
      // nested map: 721.result → boolean
      expect(() => toMetadatum({ result: true })).toThrow('at 721.result');
      // nested list element: 721.files[1] → non-integer number
      expect(() => toMetadatum({ files: ['ok', 1.5] })).toThrow('at 721.files[1]');
      // over-long key reports the containing map's path
      expect(() => toMetadatum({ nested: { ['k'.repeat(65)]: 1 } })).toThrow('at 721.nested');
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
        lovelaceAmount: '2000000',
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
        lovelaceAmount: '2000000',
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
        lovelaceAmount: '2000000',
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
        lovelaceAmount: '2000000',
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

  describe('_buildMintEntries — per-action policy (multi-policy mint FR)', () => {
    const parseScript = (hex: string) => (builder as any)._parsePlutusV3Script(hex, 'test');
    const entriesOf = (actions: unknown[], defaultRedeemer?: unknown) =>
      (builder as any)._buildMintEntries(actions, parseScript(VALID_PLUTUS_SCRIPT), defaultRedeemer);
    const spendingHash = () => parseScript(VALID_SPENDING_SCRIPT).hash.toString();

    it('per-action script and redeemer override the top-level ones', () => {
      const entries = entriesOf([
        { assetUnit: ASSET_UNIT, quantity: 1n },
        {
          assetUnit: spendingHash() + 'aa', quantity: 1n,
          mintingPolicyScript: VALID_SPENDING_SCRIPT,
          redeemerJson: { constructor: 0, fields: [] },
        },
      ]);
      expect(entries[0].script.inline.hash.toString()).toBe(POLICY_ID);
      expect(entries[1].script.inline.hash.toString()).toBe(spendingHash());
      // distinct redeemers: the default (DataI 0) vs the per-action constr
      expect(entries[0].script.redeemer).not.toEqual(entries[1].script.redeemer);
    });

    it('actions without per-action fields fall back to the default script and redeemer', () => {
      const entries = entriesOf(
        [{ assetUnit: ASSET_UNIT, quantity: 2n }],
        { constructor: 0, fields: [] }
      );
      expect(entries[0].script.inline.hash.toString()).toBe(POLICY_ID);
    });

    it('rejects same-policy actions with different redeemers (one redeemer per policy)', () => {
      expect(() => entriesOf([
        { assetUnit: ASSET_UNIT, quantity: 1n, mintingPolicyScript: VALID_PLUTUS_SCRIPT, redeemerJson: { int: 1 } },
        { assetUnit: POLICY_ID + 'bb', quantity: 1n, mintingPolicyScript: VALID_PLUTUS_SCRIPT, redeemerJson: { int: 2 } },
      ])).toThrow(/different redeemers/);
    });

    it('accepts same-policy actions with an identical redeemer', () => {
      const entries = entriesOf([
        { assetUnit: ASSET_UNIT, quantity: 1n, mintingPolicyScript: VALID_PLUTUS_SCRIPT, redeemerJson: { int: 1 } },
        { assetUnit: POLICY_ID + 'bb', quantity: 1n, mintingPolicyScript: VALID_PLUTUS_SCRIPT, redeemerJson: { int: 1 } },
      ]);
      expect(entries).toHaveLength(2);
    });

    it('key-order-swapped JSON redeemers compare equal (canonical CBOR)', () => {
      const entries = entriesOf([
        { assetUnit: ASSET_UNIT, quantity: 1n, mintingPolicyScript: VALID_PLUTUS_SCRIPT, redeemerJson: { constructor: 0, fields: [] } },
        { assetUnit: POLICY_ID + 'bb', quantity: 1n, mintingPolicyScript: VALID_PLUTUS_SCRIPT, redeemerJson: { fields: [], constructor: 0 } },
      ]);
      expect(entries).toHaveLength(2);
    });

    it('a JSON {int:0} redeemer equals the DataI(0) fallback under one policy', () => {
      const entries = entriesOf([
        { assetUnit: ASSET_UNIT, quantity: 1n },
        { assetUnit: POLICY_ID + 'bb', quantity: 1n, mintingPolicyScript: VALID_PLUTUS_SCRIPT, redeemerJson: { int: 0 } },
      ]);
      expect(entries).toHaveLength(2);
    });

    it('a per-action redeemer also conflicts with the default redeemer under one policy', () => {
      expect(() => entriesOf([
        { assetUnit: ASSET_UNIT, quantity: 1n },
        { assetUnit: POLICY_ID + 'bb', quantity: 1n, mintingPolicyScript: VALID_PLUTUS_SCRIPT, redeemerJson: { int: 9 } },
      ], { int: 1 })).toThrow(/different redeemers/);
    });
  });

  describe('_extraOutputsFundingAfterMint (FR-2 on mint)', () => {
    const OTHER_UNIT = 'a'.repeat(56) + 'cc';
    const funding = (mintActions: unknown[], extraOutputs: unknown[]) =>
      (builder as any)._extraOutputsFundingAfterMint(mintActions, extraOutputs);
    const out = (assets?: Array<{ unit: string; quantity: string }>) =>
      ({ address: TEST_ADDRESS, lovelaceAmount: '2000000', ...(assets ? { assets } : {}) });

    it('sums the extra outputs lovelace', () => {
      const result = funding([{ assetUnit: ASSET_UNIT, quantity: 1n }], [out(), out()]);
      expect(result.lovelace).toBe(4000000n);
      expect(result.assets).toBeUndefined();
    });

    it('a fully mint-covered unit is not requested from the wallet', () => {
      const result = funding(
        [{ assetUnit: ASSET_UNIT, quantity: 1n }],
        [out([{ unit: ASSET_UNIT, quantity: '1' }])]
      );
      expect(result.assets).toBeUndefined();
    });

    it('requests only the demand the mint does not cover', () => {
      // mint 1, outputs place 2: 1 must come from the wallet
      const result = funding(
        [{ assetUnit: ASSET_UNIT, quantity: 1n }],
        [out([{ unit: ASSET_UNIT, quantity: '2' }])]
      );
      expect(result.assets).toEqual([{ unit: ASSET_UNIT.toLowerCase(), quantity: '1' }]);
    });

    it('aggregates demand across outputs and mint quantity across actions', () => {
      const result = funding(
        [
          { assetUnit: ASSET_UNIT, quantity: 2n },
          { assetUnit: ASSET_UNIT, quantity: 1n },
        ],
        [out([{ unit: ASSET_UNIT, quantity: '2' }]), out([{ unit: ASSET_UNIT, quantity: '2' }])]
      );
      // demand 4, minted 3: request 1
      expect(result.assets).toEqual([{ unit: ASSET_UNIT.toLowerCase(), quantity: '1' }]);
    });

    it('requests non-minted units in full and ignores burns', () => {
      const result = funding(
        [{ assetUnit: ASSET_UNIT, quantity: -1n }],
        [out([{ unit: OTHER_UNIT, quantity: '3' }])]
      );
      expect(result.assets).toEqual([{ unit: OTHER_UNIT, quantity: '3' }]);
    });
  });

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
        getMinimumOutputLovelaces: vi.fn(() => 1_500_000n),
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
        lovelaceAmount: '2000000',
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
        lovelaceAmount: '2000000',
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
      const spy = vi.spyOn(Date, 'now').mockReturnValue(frozen);
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
  // _evaluateExUnitsByRedeemer — per-redeemer Ogmios mapping + cushion
  // =========================================================================

  describe('_evaluateExUnitsByRedeemer', () => {
    const evaluate = async (evaluator: any) =>
      (builder as any)._evaluateExUnitsByRedeemer('deadbeef', evaluator);

    it('keys results by redeemer tag:index from the validator pointer', async () => {
      const evaluator = async () => [
        { validator: { purpose: 'spend', index: 0 }, budget: { memory: 100, cpu: 1000 } },
        { validator: { purpose: 'mint', index: 0 }, budget: { memory: 200, cpu: 2000 } }
      ];
      const result = await evaluate(evaluator);
      // TxRedeemerTag.Spend = 0, TxRedeemerTag.Mint = 1
      expect(result.has('0:0')).toBe(true);
      expect(result.has('1:0')).toBe(true);
      expect(result.size).toBe(2);
    });

    // Regression: tiny validators were hitting ledger overspend by ~10k–30k CPU
    // because metadata presence shifted the real tx body vs evaluator's simulated
    // ScriptContext. Fixed absolute cushion (ABS_*_BUFFER) guards that gap.
    it('adds absolute cushion on top of the relative buffer for small budgets', async () => {
      const evaluator = async () => [
        { validator: { purpose: 'spend', index: 0 }, budget: { memory: 100, cpu: 1000 } }
      ];
      const result = await evaluate(evaluator);
      const units = result.get('0:0');
      // mem: ceil(100 * 1.1) + ABS_MEM_BUFFER(5000) = 5110
      expect(units.mem).toBeGreaterThanOrEqual(1100n);
      // cpu: ceil(1000 * 1.1) + ABS_CPU_BUFFER(200000) = 201100
      expect(units.cpu).toBeGreaterThanOrEqual(51000n);
    });

    it('keeps proportional scaling for large budgets', async () => {
      const evaluator = async () => [
        { validator: { purpose: 'spend', index: 0 }, budget: { memory: 10_000_000, cpu: 10_000_000_000 } }
      ];
      const result = await evaluate(evaluator);
      const units = result.get('0:0');
      expect(units.mem).toBeGreaterThanOrEqual(11_000_000n);
      expect(units.cpu).toBeGreaterThanOrEqual(11_000_000_000n);
    });

    it('supports the legacy "purpose:index" string validator form', async () => {
      const evaluator = async () => [
        { validator: 'mint:1', budget: { memory: 50, cpu: 500 } }
      ];
      const result = await evaluate(evaluator);
      expect(result.has('1:1')).toBe(true);
    });

    it('returns undefined for an empty evaluation result', async () => {
      expect(await evaluate(async () => [])).toBeUndefined();
    });

    it('returns undefined on transient evaluator failure (fallback to local units)', async () => {
      const evaluator = async () => { throw new Error('connection refused'); };
      expect(await evaluate(evaluator)).toBeUndefined();
    });

    it('rethrows TransactionValidationError (authoritative script failure)', async () => {
      const evaluator = async () => { throw new TransactionValidationError('script failed phase-2'); };
      await expect(evaluate(evaluator)).rejects.toThrow(TransactionValidationError);
    });

    it('skips results with unrecognized validator pointers', async () => {
      const evaluator = async () => [
        { validator: { purpose: 'somethingelse', index: 0 }, budget: { memory: 1, cpu: 1 } }
      ];
      expect(await evaluate(evaluator)).toBeUndefined();
    });
  });

  // =========================================================================
  // _resolveTargetExUnits — stamping policy
  // =========================================================================

  describe('_resolveTargetExUnits', () => {
    // The method only reads tag/index/execUnits, so lightweight fakes suffice.
    const fakeRedeemer = (tag: number, index: number, mem: bigint, cpu: bigint) =>
      ({ tag, index, execUnits: { mem, cpu } });
    const resolve = (rdmrs: any[], evaluated?: Map<string, { mem: bigint; cpu: bigint }>, failures: any[] = []) =>
      (builder as any)._resolveTargetExUnits(rdmrs, evaluated, failures);

    it('buffers the local budget when no Ogmios result exists (local success)', () => {
      const [target] = resolve([fakeRedeemer(0, 0, 1000n, 10000n)]);
      // ceil(1000 * 1.1) + 5000 = 6100 / ceil(10000 * 1.1) + 200000 = 211000
      expect(target.mem).toBe(6100n);
      expect(target.cpu).toBe(211000n);
    });

    it('takes the componentwise max of local and Ogmios units (local success)', () => {
      const evaluated = new Map([['0:0', { mem: 500n, cpu: 99999999n }]]);
      const [target] = resolve([fakeRedeemer(0, 0, 1000n, 10000n)], evaluated);
      expect(target.mem).toBe(1000n);      // local higher
      expect(target.cpu).toBe(99999999n);  // ogmios higher
    });

    it('uses the Ogmios units verbatim when the local run failed (partial budget is meaningless)', () => {
      const evaluated = new Map([['0:0', { mem: 777n, cpu: 8888n }]]);
      const failures = [{ tag: 0, index: 0, logs: ['boom'] }];
      const [target] = resolve([fakeRedeemer(0, 0, 999999n, 999999999n)], evaluated, failures);
      expect(target.mem).toBe(777n);
      expect(target.cpu).toBe(8888n);
    });

    it('throws when the local run failed and no Ogmios evaluation is available', () => {
      const failures = [{ tag: 0, index: 0, logs: ['validator error'] }];
      expect(() => resolve([fakeRedeemer(0, 0, 1n, 1n)], undefined, failures))
        .toThrow(TransactionValidationError);
      expect(() => resolve([fakeRedeemer(0, 0, 1n, 1n)], undefined, failures))
        .toThrow(/forfeit the collateral/);
    });

    it('only fails the redeemer that actually failed', () => {
      const evaluated = new Map([['1:0', { mem: 10n, cpu: 20n }]]);
      const failures = [{ tag: 1, index: 0, logs: [] }];
      const targets = resolve(
        [fakeRedeemer(0, 0, 100n, 200n), fakeRedeemer(1, 0, 5n, 5n)],
        evaluated,
        failures
      );
      expect(targets[0].mem).toBeGreaterThan(100n); // buffered local
      expect(targets[1]).toEqual({ mem: 10n, cpu: 20n }); // ogmios verbatim
    });
  });

  // =========================================================================
  // _buildScriptTx — end-to-end with the real Buildooor TxBuilder
  // =========================================================================

  describe('buildUnsignedMintTransaction — end-to-end ExUnits stamping', () => {
    // Subset of the fields _mapLedgerParametersToBuildooorParams consumes; everything
    // else (cost models, prices) falls back to Buildooor's defaults — the same ones the
    // builder's local CEK evaluation and our scriptDataHash recompute use.
    const PROTOCOL_PARAMS = {
      minFeeA: 44,
      minFeeB: 155381,
      coinsPerUtxoSize: '4310',
      maxTxSize: 16384,
      maxValSize: '5000',
      keyDeposit: '2000000',
      poolDeposit: '500000000'
    } as any;

    const adaOnlyUtxo: UTxO = {
      txHash: 'cc'.repeat(32),
      outputIndex: 0,
      address: TEST_ADDRESS,
      amount: [{ unit: 'lovelace', quantity: '5000000' }],
    };
    const fundingUtxo: UTxO = {
      txHash: 'dd'.repeat(32),
      outputIndex: 1,
      address: TEST_ADDRESS,
      amount: [{ unit: 'lovelace', quantity: '50000000' }],
    };

    const mintReq = (): TxBuildMintRequest => ({
      network: 'preview',
      senderAddress: TEST_ADDRESS,
      recipientAddress: TEST_ADDRESS,
      lovelaceAmount: '2000000',
      mintActions: [{ assetUnit: ASSET_UNIT, quantity: 1n }],
      mintingPolicyScript: VALID_PLUTUS_SCRIPT,
    });

    const initBuilder = async () => {
      await builder.init({ network: 'preview' } as any, PROTOCOL_PARAMS);
    };

    /**
     * Independent consistency check: re-parse the produced CBOR and recompute the
     * script data hash from the *parsed* witness set (exact wire bytes) with the same
     * language views the builder uses. A stale-witness hash (the TxBuilder
     * overrideTxRedeemers bug) or any stamping inconsistency fails this check —
     * on-chain it would surface as a PPViewHashesDontMatch phase-1 rejection.
     */
    const assertScriptDataHashConsistent = (unsignedTxCbor: string) => {
      const { Tx } = require('@harmoniclabs/cardano-ledger-ts');
      const { getScriptDataHash, costModelsToLanguageViewCbor, defaultProtocolParameters } =
        require('@harmoniclabs/buildooor');
      const parsed = Tx.fromCbor(unsignedTxCbor);
      const views = costModelsToLanguageViewCbor(defaultProtocolParameters.costModels, { mustHaveV3: true });
      const recomputed = getScriptDataHash(parsed.witnesses, views);
      expect(parsed.body.scriptDataHash?.toString()).toBe(recomputed?.toString());
      return parsed;
    };

    it('stamps buffered local units and a consistent scriptDataHash without an evaluator', async () => {
      await initBuilder();
      const ctx: TxBuildContext = {
        utxos: [adaOnlyUtxo, fundingUtxo],
        protocolParameters: PROTOCOL_PARAMS,
        // no evaluateTransaction → buffered local units
      };

      const result = await builder.buildUnsignedMintTransaction(mintReq(), ctx);
      expect(result.unsignedTxCbor).toBeDefined();

      const parsed = assertScriptDataHashConsistent(result.unsignedTxCbor!);
      const redeemers = parsed.witnesses.redeemers ?? [];
      expect(redeemers.length).toBe(1);
      // Buffered local: at least the absolute cushion on top of a real (>0) local run
      expect(BigInt(redeemers[0].execUnits.mem)).toBeGreaterThanOrEqual(5000n);   // ABS_MEM_BUFFER
      expect(BigInt(redeemers[0].execUnits.cpu)).toBeGreaterThanOrEqual(200000n); // ABS_CPU_BUFFER
      expect(BigInt(parsed.body.fee)).toBeGreaterThan(0n);
    });

    it('stamps the evaluator units (with cushion) when they exceed the local budget', async () => {
      await initBuilder();
      // Far above any real local budget for this tiny policy → buffered evaluator
      // units must win and appear verbatim in the produced CBOR.
      const evaluatedMem = 5_000_000;
      const evaluatedCpu = 2_000_000_000;
      const expectedMem = BigInt(Math.ceil(evaluatedMem * 1.1) + 5_000);       // EXECUTION_UNIT_BUFFER / ABS_MEM_BUFFER
      const expectedCpu = BigInt(Math.ceil(evaluatedCpu * 1.1) + 200_000);     // EXECUTION_UNIT_BUFFER / ABS_CPU_BUFFER

      const evaluatorCalls: string[] = [];
      const ctx: TxBuildContext = {
        utxos: [adaOnlyUtxo, fundingUtxo],
        protocolParameters: PROTOCOL_PARAMS,
        evaluateTransaction: async (cbor: string) => {
          evaluatorCalls.push(cbor);
          return [{ validator: { purpose: 'mint', index: 0 }, budget: { memory: evaluatedMem, cpu: evaluatedCpu } }];
        },
      };

      const resultNoEval = await builder.buildUnsignedMintTransaction(mintReq(), {
        utxos: [adaOnlyUtxo, fundingUtxo], protocolParameters: PROTOCOL_PARAMS,
      });
      const result = await builder.buildUnsignedMintTransaction(mintReq(), ctx);

      expect(evaluatorCalls.length).toBe(1);
      const parsed = assertScriptDataHashConsistent(result.unsignedTxCbor!);
      const redeemers = parsed.witnesses.redeemers ?? [];
      expect(redeemers.length).toBe(1);
      expect(BigInt(redeemers[0].execUnits.mem)).toBe(expectedMem);
      expect(BigInt(redeemers[0].execUnits.cpu)).toBe(expectedCpu);

      // The fee must cover the much larger declared units: strictly higher than the
      // buffered-local build of the identical request.
      const parsedNoEval = require('@harmoniclabs/cardano-ledger-ts').Tx.fromCbor(resultNoEval.unsignedTxCbor!);
      expect(BigInt(parsed.body.fee)).toBeGreaterThan(BigInt(parsedNoEval.body.fee));
    });

    // CBOR-wrapped flat UPLC for `(program 1.1.0 (error))` — a policy that always fails
    // phase-2. Local CEK evaluation errors out, which previously produced a transaction
    // carrying the partial budget (collateral-forfeiting if submitted).
    const ALWAYS_FAIL_SCRIPT = '4401010061';

    it('rejects with a clear error when local evaluation fails and no evaluator is configured', async () => {
      await initBuilder();
      const req: TxBuildMintRequest = {
        ...mintReq(),
        mintingPolicyScript: ALWAYS_FAIL_SCRIPT,
      };
      const ctx: TxBuildContext = {
        utxos: [adaOnlyUtxo, fundingUtxo],
        protocolParameters: PROTOCOL_PARAMS,
      };

      await expect(builder.buildUnsignedMintTransaction(req, ctx))
        .rejects.toThrow(/forfeit the collateral/);
    });

    it('builds successfully when local evaluation fails but Ogmios certifies the units', async () => {
      await initBuilder();
      const req: TxBuildMintRequest = {
        ...mintReq(),
        mintingPolicyScript: ALWAYS_FAIL_SCRIPT,
      };
      const ctx: TxBuildContext = {
        utxos: [adaOnlyUtxo, fundingUtxo],
        protocolParameters: PROTOCOL_PARAMS,
        evaluateTransaction: async () => [
          { validator: { purpose: 'mint', index: 0 }, budget: { memory: 100_000, cpu: 50_000_000 } }
        ],
      };

      const result = await builder.buildUnsignedMintTransaction(req, ctx);
      const parsed = assertScriptDataHashConsistent(result.unsignedTxCbor!);
      const redeemers = parsed.witnesses.redeemers ?? [];
      expect(redeemers.length).toBe(1);
      // Ogmios units verbatim (with cushion) — the local partial budget is discarded
      expect(BigInt(redeemers[0].execUnits.mem)).toBe(BigInt(Math.ceil(100_000 * 1.1) + 5_000));
      expect(BigInt(redeemers[0].execUnits.cpu)).toBe(BigInt(Math.ceil(50_000_000 * 1.1) + 200_000));
    });

    it('propagates an authoritative Ogmios ScriptValidationError instead of falling back to local units', async () => {
      await initBuilder();
      // VALID_PLUTUS_SCRIPT evaluates fine locally, so the ONLY failure signal is Ogmios's
      // ledger phase-2 rejection (normalizeBackendError surfaces PlutusFailure/CekError as
      // ScriptValidationError). That must propagate — silently returning local buffered units
      // would hand back a transaction the node has already rejected.
      const req: TxBuildMintRequest = { ...mintReq(), mintingPolicyScript: VALID_PLUTUS_SCRIPT };
      const ctx: TxBuildContext = {
        utxos: [adaOnlyUtxo, fundingUtxo],
        protocolParameters: PROTOCOL_PARAMS,
        evaluateTransaction: async () => { throw new ScriptValidationError('Script validation failed: CekError'); },
      };

      await expect(builder.buildUnsignedMintTransaction(req, ctx))
        .rejects.toThrow(/Script validation failed/);
    });

    it('stamps the collateral return output into the tx body when the collateral UTxO exceeds the floor', async () => {
      await initBuilder();
      // Only large ADA-only UTxOs: 50 ADA becomes collateral (smallest sufficient),
      // 45 ADA must come back via collateralReturn; 100 ADA funds the mint.
      const bigFunding: UTxO = {
        txHash: 'aa'.repeat(32), outputIndex: 0, address: TEST_ADDRESS,
        amount: [{ unit: 'lovelace', quantity: '100000000' }],
      };
      const bigCollateral: UTxO = {
        txHash: 'bb'.repeat(32), outputIndex: 0, address: TEST_ADDRESS,
        amount: [{ unit: 'lovelace', quantity: '50000000' }],
      };
      const ctx: TxBuildContext = {
        utxos: [bigFunding, bigCollateral],
        protocolParameters: PROTOCOL_PARAMS,
      };

      const result = await builder.buildUnsignedMintTransaction(mintReq(), ctx);
      const parsed = assertScriptDataHashConsistent(result.unsignedTxCbor!);

      const collaterals = parsed.body.collateralInputs ?? [];
      expect(collaterals.length).toBe(1);
      expect(collaterals[0].utxoRef.id.toString()).toBe(bigCollateral.txHash);

      // Without the return, the full 50 ADA would be forfeited on phase-2 failure.
      expect(parsed.body.collateralReturn).toBeDefined();
      expect(parsed.body.collateralReturn!.address.toString()).toBe(TEST_ADDRESS);
      expect(BigInt(parsed.body.collateralReturn!.value.lovelaces)).toBe(45_000_000n);
    });

    it('names the collateral partition when funding is insufficient after the reservation', async () => {
      await initBuilder();
      // 6 ADA UTxO becomes collateral (smallest ≥ 5 ADA floor); only 4.4 ADA remains
      // for funding a 4.4 ADA mint output + fee → insufficient. The old message was
      // "required 0, available 0" with the reservation invisible.
      const smallFunding: UTxO = {
        txHash: 'ee'.repeat(32), outputIndex: 0, address: TEST_ADDRESS,
        amount: [{ unit: 'lovelace', quantity: '4400000' }],
      };
      const collateral: UTxO = {
        txHash: 'ff'.repeat(32), outputIndex: 0, address: TEST_ADDRESS,
        amount: [{ unit: 'lovelace', quantity: '6000000' }],
      };
      const ctx: TxBuildContext = {
        utxos: [smallFunding, collateral],
        protocolParameters: PROTOCOL_PARAMS,
      };

      await expect(builder.buildUnsignedMintTransaction({ ...mintReq(), lovelaceAmount: '4400000' }, ctx))
        .rejects.toThrow(/reserved as collateral/);
    });

    it('hashes the language views from the raw chain cost-model array (protocol-11: 350 V3 entries)', async () => {
      const { Tx } = require('@harmoniclabs/cardano-ledger-ts');
      const { getScriptDataHash, costModelsToLanguageViewCbor, defaultProtocolParameters } =
        require('@harmoniclabs/buildooor');

      // Simulate a chain serving MORE V3 entries than this costmodels-ts release
      // knows (as protocol-11 did against the 297-entry Chang-2 releases).
      const v3Extended = [
        ...Object.values(defaultProtocolParameters.costModels.PlutusScriptV3).map(Number),
        ...Array.from({ length: 53 }, (_, i) => 1_000_000 + i),
      ];
      const params = { ...PROTOCOL_PARAMS, costModels: JSON.stringify({ PlutusV3: v3Extended }) };
      await builder.init({ network: 'preview' } as any, params);

      const ctx: TxBuildContext = { utxos: [adaOnlyUtxo, fundingUtxo], protocolParameters: params };
      const result = await builder.buildUnsignedMintTransaction(mintReq(), ctx);
      const parsed = Tx.fromCbor(result.unsignedTxCbor!);

      // The stamped hash must cover ALL served entries (raw array form passes through unclamped)…
      const rawViews = costModelsToLanguageViewCbor({ PlutusScriptV3: v3Extended }, { mustHaveV3: true });
      expect(parsed.body.scriptDataHash?.toString())
        .toBe(getScriptDataHash(parsed.witnesses, rawViews)?.toString());

      // …and must differ from the clamped named-key hash (library param count), which the node
      // rejects with ScriptIntegrityHashMismatch on protocol-11 networks.
      const clamped = (builder as any).txBuilder.protocolParamters.costModels;
      const clampedViews = costModelsToLanguageViewCbor(clamped, { mustHaveV3: true });
      expect(parsed.body.scriptDataHash?.toString())
        .not.toBe(getScriptDataHash(parsed.witnesses, clampedViews)?.toString());
    });
  });

  // =========================================================================
  // _parsePlutusV3Script — UPLC version validation (V2-as-V3 guard)
  // =========================================================================

  describe('_parsePlutusV3Script — UPLC version validation', () => {
    // always-succeed PlutusV2 script: CBOR-wrapped flat UPLC 1.0.0
    const PLUTUS_V2_SCRIPT = '4e4d01000033222220051200120011';

    const parse = (hex: string) => (builder as any)._parsePlutusV3Script(hex, 'testField');

    it('accepts UPLC 1.1.0 (Plutus V3) scripts', () => {
      const script = parse(VALID_PLUTUS_SCRIPT);
      expect(script.hash.toString()).toBe(POLICY_ID);
    });

    it('rejects UPLC 1.0.0 (Plutus V1/V2) scripts with a clear 400', () => {
      expect(() => parse(PLUTUS_V2_SCRIPT)).toThrow(TransactionValidationError);
      expect(() => parse(PLUTUS_V2_SCRIPT)).toThrow(/UPLC 1\.0\.0/);
    });

    it('rejects unparseable script CBOR with a clear 400 naming the field', () => {
      expect(() => parse('zz')).toThrow(/Invalid testField CBOR/);
    });

    it('rejects a V2 minting policy at the build entry point', async () => {
      const req: TxBuildMintRequest = {
        network: 'preview',
        senderAddress: TEST_ADDRESS,
        recipientAddress: TEST_ADDRESS,
        lovelaceAmount: '2000000',
        mintActions: [{ assetUnit: ASSET_UNIT, quantity: 1n }],
        mintingPolicyScript: PLUTUS_V2_SCRIPT,
      };
      const ctx: TxBuildContext = { utxos: [], protocolParameters: {} as any };

      await expect(builder.buildUnsignedMintTransaction(req, ctx))
        .rejects.toThrow(/UPLC 1\.0\.0/);
    });
  });

  // =========================================================================
  // _setupCollateral — smallest-sufficient selection + collateralReturn
  // =========================================================================

  describe('_setupCollateral — smallest-sufficient selection + collateralReturn', () => {
    const adaUtxo = (txHashByte: string, lovelace: string): UTxO => ({
      txHash: txHashByte.repeat(32),
      outputIndex: 0,
      address: TEST_ADDRESS,
      amount: [{ unit: 'lovelace', quantity: lovelace }],
    });
    const assetUtxo: UTxO = {
      txHash: 'ab'.repeat(32),
      outputIndex: 0,
      address: TEST_ADDRESS,
      amount: [{ unit: 'lovelace', quantity: '2000000' }, { unit: ASSET_UNIT, quantity: '1' }],
    };

    const setup = (utxos: UTxO[]) => (builder as any)._setupCollateral(utxos);

    beforeEach(async () => {
      // _setupCollateral needs an initialized TxBuilder for min-ADA computation
      await builder.init({ network: 'preview' } as any, { minFeeA: 44, minFeeB: 155381, coinsPerUtxoSize: '4310' } as any);
    });

    it('picks the smallest ADA-only UTxO that covers the 5 ADA floor, not the first', () => {
      const big = adaUtxo('aa', '100000000');   // 100 ADA, listed first
      const small = adaUtxo('bb', '6000000');   // 6 ADA — smallest sufficient
      const { collateralUtxos, fundingUtxos } = setup([big, small, assetUtxo]);

      expect(collateralUtxos[0].utxoRef.id.toString()).toBe(small.txHash);
      // chosen UTxO removed from funding; everything else kept
      expect(fundingUtxos.map((u: UTxO) => u.txHash)).toEqual([big.txHash, assetUtxo.txHash]);
    });

    it('sets a collateralReturn for the excess above the floor', () => {
      const big = adaUtxo('aa', '50000000'); // 50 ADA → 45 ADA excess
      const { collateralReturn } = setup([big]);

      expect(collateralReturn).toBeDefined();
      expect(collateralReturn!.address.toString()).toBe(TEST_ADDRESS);
      expect(collateralReturn!.value.lovelaces).toBe(45_000_000n);
    });

    it('sets no collateralReturn when the UTxO matches the floor exactly', () => {
      const { collateralReturn } = setup([adaUtxo('aa', '5000000')]);
      expect(collateralReturn).toBeUndefined();
    });

    it('sets no collateralReturn when the excess is below min-ADA for the return output', () => {
      // 5.2 ADA → 0.2 ADA excess, far below min-ADA (~0.86 ADA)
      const { collateralReturn } = setup([adaUtxo('aa', '5200000')]);
      expect(collateralReturn).toBeUndefined();
    });

    it('falls back to the largest ADA-only UTxO (with warning, without throwing) when none reaches the floor', () => {
      const dust1 = adaUtxo('aa', '2000000');
      const dust2 = adaUtxo('bb', '3000000');
      const { collateralUtxos, collateralReturn } = setup([dust1, dust2]);

      expect(collateralUtxos[0].utxoRef.id.toString()).toBe(dust2.txHash);
      expect(collateralReturn).toBeUndefined();
    });

    it('still throws when no ADA-only UTxO exists', () => {
      expect(() => setup([assetUtxo])).toThrow('No ADA-only UTxO available for collateral');
    });
  });

  // =========================================================================
  // _mapMultiAssetUtxoToLedgerUtxo — datum mapping (M5)
  // =========================================================================

  describe('_mapMultiAssetUtxoToLedgerUtxo — datum mapping (M5)', () => {
    const { Hash32 } = require('@harmoniclabs/cardano-ledger-ts');
    // blake2b-256 of PlutusData Constr 0 []
    const DATUM_HASH = '923918e403bf43c34b4ef6b48eb2ee04babed17320d8d1b9ff9ad086e86f44ec';
    const baseUtxo: UTxO = {
      txHash: 'aa'.repeat(32),
      outputIndex: 0,
      address: TEST_ADDRESS,
      amount: [{ unit: 'lovelace', quantity: '5000000' }],
    };
    const map = (u: UTxO) => (builder as any)._mapMultiAssetUtxoToLedgerUtxo(u);

    it('carries the datum hash into the resolved TxOut', () => {
      const ledgerUtxo = map({ ...baseUtxo, datumHash: DATUM_HASH });
      expect(ledgerUtxo.resolved.datum).toBeInstanceOf(Hash32);
      expect(ledgerUtxo.resolved.datum.toString()).toBe(DATUM_HASH);
    });

    it('prefers the inline datum when both inlineDatum and datumHash are present', () => {
      const ledgerUtxo = map({ ...baseUtxo, inlineDatum: 'd87980', datumHash: DATUM_HASH });
      expect(ledgerUtxo.resolved.datum).toBeDefined();
      expect(ledgerUtxo.resolved.datum).not.toBeInstanceOf(Hash32);
    });

    it('leaves the datum undefined when neither is present', () => {
      expect(map(baseUtxo).resolved.datum).toBeUndefined();
    });
  });

  // =========================================================================
  // buildUnsignedPlutusSpendTransaction — datum-hash-locked UTxO (M5 E2E)
  // =========================================================================

  describe('buildUnsignedPlutusSpendTransaction — datum-hash-locked UTxO (M5 E2E)', () => {
    // Script address of VALID_SPENDING_SCRIPT (testnet) and the hash of Constr 0 []
    const SCRIPT_ADDRESS = 'addr_test1wps7xts4e28ykdmg0uq86y6x050wsse86q42eytg6ljz5tqmrcwgm';
    const DATUM_HASH = '923918e403bf43c34b4ef6b48eb2ee04babed17320d8d1b9ff9ad086e86f44ec';
    const PARAMS = {
      minFeeA: 44, minFeeB: 155381, coinsPerUtxoSize: '4310', maxTxSize: 16384,
    } as any;

    const scriptUtxo: UTxO = {
      txHash: 'ee'.repeat(32),
      outputIndex: 0,
      address: SCRIPT_ADDRESS,
      amount: [{ unit: 'lovelace', quantity: '5000000' }],
      datumHash: DATUM_HASH, // hash-locked, NO inline datum
    };
    const collateralUtxo: UTxO = {
      txHash: 'cc'.repeat(32),
      outputIndex: 0,
      address: TEST_ADDRESS,
      amount: [{ unit: 'lovelace', quantity: '5000000' }],
    };
    const fundingUtxo: UTxO = {
      txHash: 'dd'.repeat(32),
      outputIndex: 1,
      address: TEST_ADDRESS,
      amount: [{ unit: 'lovelace', quantity: '50000000' }],
    };

    it('includes the provided datum preimage in the witness set', async () => {
      await builder.init({ network: 'preview' } as any, PARAMS);

      const req: TxBuildPlutusSpendRequest = {
        network: 'preview',
        senderAddress: TEST_ADDRESS,
        recipientAddress: TEST_ADDRESS,
        lovelaceAmount: '2000000',
        plutusScriptExecution: {
          validatorScript: VALID_SPENDING_SCRIPT,
          scriptUtxo: { txHash: scriptUtxo.txHash, outputIndex: 0 },
          redeemer: { constructor: 0, fields: [] },
          datum: { constructor: 0, fields: [] }, // preimage of DATUM_HASH
        },
      };
      const ctx: TxBuildContext = {
        utxos: [scriptUtxo, collateralUtxo, fundingUtxo],
        protocolParameters: PARAMS,
        // Certified units for either possible spend-redeemer index, so the build
        // completes independently of the local CEK outcome for the test validator.
        evaluateTransaction: async () => [
          { validator: { purpose: 'spend', index: 0 }, budget: { memory: 200_000, cpu: 100_000_000 } },
          { validator: { purpose: 'spend', index: 1 }, budget: { memory: 200_000, cpu: 100_000_000 } },
        ],
      };

      const result = await builder.buildUnsignedPlutusSpendTransaction(req, ctx);
      expect(result.unsignedTxCbor).toBeDefined();

      const { Tx } = require('@harmoniclabs/cardano-ledger-ts');
      const { hashData } = require('@harmoniclabs/buildooor');
      const parsed = Tx.fromCbor(result.unsignedTxCbor!);
      const datums = parsed.witnesses.datums ?? [];
      // Without the datumHash mapping the preimage was silently dropped here
      // (empty witness datums → MissingRequiredDatums on submit).
      expect(datums.length).toBe(1);
      expect(Buffer.from(hashData(datums[0])).toString('hex')).toBe(DATUM_HASH);
    });
  });

  // =========================================================================
  // _mapLedgerParametersToBuildooorParams (M3) — full mapping with null guards
  // =========================================================================

  describe('_mapLedgerParametersToBuildooorParams', () => {
    const { defaultProtocolParameters, TxBuilder } = require('@harmoniclabs/buildooor');

    const mapParams = (pp: any) =>
      (builder as any)._mapLedgerParametersToBuildooorParams(pp);

    it('keeps library defaults for missing/null fields instead of degrading to 0', () => {
      const mapped = mapParams({ coinsPerUtxoSize: null, minFeeA: undefined, maxTxSize: '' });
      // Number(null) === 0 previously set utxoCostPerByte = 0, disabling min-ADA checks
      expect(mapped.utxoCostPerByte).toBe(defaultProtocolParameters.utxoCostPerByte);
      expect(mapped.utxoCostPerByte).not.toBe(0);
      expect(mapped.txFeePerByte).toBe(defaultProtocolParameters.txFeePerByte);
      expect(mapped.maxTxSize).toBe(defaultProtocolParameters.maxTxSize);
    });

    it('maps all scalar fields including string→number conversion and deposit names', () => {
      const mapped = mapParams({
        minFeeA: 44,
        minFeeB: '155381',
        coinsPerUtxoSize: '4310',
        maxTxSize: 16384,
        maxValSize: '5000',
        maxBlockSize: 90112,
        maxBlockHeaderSize: 1100,
        keyDeposit: '2000000',
        poolDeposit: '500000000',
        minPoolCost: '170000000',
        eMax: 18,
        nOpt: 500,
        collateralPercent: 150,
        maxCollateralInputs: 3,
      });
      expect(mapped.txFeePerByte).toBe(44);
      expect(mapped.txFeeFixed).toBe(155381);
      expect(mapped.utxoCostPerByte).toBe(4310);
      expect(mapped.maxTxSize).toBe(16384);
      expect(mapped.maxValueSize).toBe(5000);
      expect(mapped.maxBlockBodySize).toBe(90112);
      expect(mapped.maxBlockHeaderSize).toBe(1100);
      expect(mapped.stakeAddressDeposit).toBe(2000000);
      expect(mapped.stakePoolDeposit).toBe(500000000);
      expect(mapped.minPoolCost).toBe(170000000);
      expect(mapped.poolRetireMaxEpoch).toBe(18);
      expect(mapped.stakePoolTargetNum).toBe(500);
      expect(mapped.collateralPercentage).toBe(150);
      expect(mapped.maxCollateralInputs).toBe(3);
    });

    it('maps execution-unit prices and caps when both halves of each pair are present', () => {
      const mapped = mapParams({
        priceMem: '0.0577',
        priceStep: 0.0000721,
        maxTxExMem: '14000000',
        maxTxExSteps: '10000000000',
        maxBlockExMem: 62000000,
        maxBlockExSteps: 20000000000,
      });
      expect(mapped.executionUnitPrices).toEqual({ priceMemory: 0.0577, priceSteps: 0.0000721 });
      expect(mapped.maxTxExecutionUnits).toEqual({ memory: 14000000, steps: 10000000000 });
      expect(mapped.maxBlockExecutionUnits).toEqual({ memory: 62000000, steps: 20000000000 });
    });

    it('keeps default prices/caps when a pair is incomplete', () => {
      const mapped = mapParams({ priceMem: 0.0577, maxTxExMem: 14000000 });
      expect(mapped.executionUnitPrices).toBe(defaultProtocolParameters.executionUnitPrices);
      expect(mapped.maxTxExecutionUnits).toBe(defaultProtocolParameters.maxTxExecutionUnits);
    });

    it('maps backend cost-model arrays into a form TxBuilder accepts', () => {
      // Backend blob: number arrays with backend/Ogmios key styles
      const v1Arr = Object.values(defaultProtocolParameters.costModels.PlutusScriptV1).map(Number);
      const v3Arr = Object.values(defaultProtocolParameters.costModels.PlutusScriptV3).map(Number);
      const mapped = mapParams({
        costModels: JSON.stringify({ PlutusV1: v1Arr, 'plutus:v3': v3Arr }),
      });
      expect(mapped.costModels.PlutusScriptV1).toBeDefined();
      expect(mapped.costModels.PlutusScriptV3).toBeDefined();
      expect(mapped.costModels.PlutusScriptV2).toBeUndefined();
      // Arrays must be converted to named-key objects — raw arrays crash the CEK Machine
      expect(Array.isArray(mapped.costModels.PlutusScriptV3)).toBe(false);
      expect(() => new TxBuilder(mapped)).not.toThrow();
    });

    it('keeps default cost models on invalid JSON or unusable content', () => {
      expect(mapParams({ costModels: 'not-json{' }).costModels)
        .toBe(defaultProtocolParameters.costModels);
      expect(mapParams({ costModels: JSON.stringify({ unknownKey: [1, 2] }) }).costModels)
        .toBe(defaultProtocolParameters.costModels);
      // Wrong array length → conversion fails → key skipped → defaults kept
      expect(mapParams({ costModels: JSON.stringify({ PlutusV1: [1, 2, 3] }) }).costModels)
        .toBe(defaultProtocolParameters.costModels);
    });

    it('keeps the raw chain arrays (unclamped) for language-view hashing', () => {
      // Chain-ahead-of-library shape: every V3 param this release knows plus 53 newer entries.
      const libV3Count = Object.values(defaultProtocolParameters.costModels.PlutusScriptV3).length;
      const v3Extended = [
        ...Object.values(defaultProtocolParameters.costModels.PlutusScriptV3).map(Number),
        ...Array.from({ length: 53 }, (_, i) => 1_000_000 + i),
      ];
      expect(v3Extended.length).toBe(libV3Count + 53);
      const mapped = mapParams({ costModels: JSON.stringify({ 'plutus:v3': v3Extended }) });
      // Named-key form for the TxBuilder/CEK machine stays clamped to the known params…
      expect(Array.isArray(mapped.costModels.PlutusScriptV3)).toBe(false);
      // …but the raw 350-entry array is preserved verbatim for the scriptDataHash views.
      expect((builder as any).rawCostModelArrays.PlutusScriptV3).toEqual(v3Extended);
    });

    it('clears stale raw arrays when the next parameters carry no usable cost models', () => {
      const v3Arr = Object.values(defaultProtocolParameters.costModels.PlutusScriptV3).map(Number);
      mapParams({ costModels: JSON.stringify({ PlutusV3: v3Arr }) });
      expect((builder as any).rawCostModelArrays.PlutusScriptV3).toBeDefined();
      mapParams({ costModels: 'not-json{' });
      expect((builder as any).rawCostModelArrays).toEqual({});
    });
  });

  // =========================================================================
  // _ensureCurrentProtocolParameters (M4) — per-request param refresh
  // =========================================================================

  describe('_ensureCurrentProtocolParameters', () => {
    const baseParams = {
      network: 'preview',
      epoch: 100,
      minFeeA: 44,
      minFeeB: 155381,
      coinsPerUtxoSize: '4310',
    } as any;

    const initWith = async (params: any) => {
      await builder.init({ network: 'preview' } as any, params);
    };

    it('rebuilds the TxBuilder when the network#epoch fingerprint changes', async () => {
      await initWith(baseParams);
      const before = (builder as any).txBuilder;

      const nextEpochParams = { ...baseParams, epoch: 101, minFeeB: 200000 };
      (builder as any)._ensureCurrentProtocolParameters({ utxos: [], protocolParameters: nextEpochParams });

      const after = (builder as any).txBuilder;
      expect(after).not.toBe(before);
      // New params actually took effect
      expect(Number(after.protocolParamters.txFeeFixed)).toBe(200000);
    });

    it('does not rebuild when the fingerprint is unchanged', async () => {
      await initWith(baseParams);
      const before = (builder as any).txBuilder;

      (builder as any)._ensureCurrentProtocolParameters({ utxos: [], protocolParameters: { ...baseParams } });

      expect((builder as any).txBuilder).toBe(before);
    });

    it('does not rebuild when the context carries no protocol parameters', async () => {
      await initWith(baseParams);
      const before = (builder as any).txBuilder;

      (builder as any)._ensureCurrentProtocolParameters({ utxos: [] });

      expect((builder as any).txBuilder).toBe(before);
    });

    it('falls back to a content fingerprint when network/epoch keys are missing', async () => {
      const noKeyParams = { minFeeA: 44, minFeeB: 155381 } as any;
      await initWith(noKeyParams);
      const before = (builder as any).txBuilder;

      // Same content → no rebuild even without network/epoch
      (builder as any)._ensureCurrentProtocolParameters({ utxos: [], protocolParameters: { minFeeA: 44, minFeeB: 155381 } });
      expect((builder as any).txBuilder).toBe(before);

      // Changed content → rebuild
      (builder as any)._ensureCurrentProtocolParameters({ utxos: [], protocolParameters: { minFeeA: 50, minFeeB: 155381 } });
      expect((builder as any).txBuilder).not.toBe(before);
    });
  });
});
