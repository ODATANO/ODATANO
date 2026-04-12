import { BuildooorTxBuilder } from '../../srv/blockchain/transaction-building/buildooor-tx';
import { TxMetadata } from '@harmoniclabs/cardano-ledger-ts/dist/tx/metadata/TxMetadata';
import { TxMetadatumInt, TxMetadatumText, TxMetadatumList, TxMetadatumMap } from '@harmoniclabs/cardano-ledger-ts/dist/tx/metadata/TxMetadatum';
import type { TxBuildMintRequest, TxBuildPlutusSpendRequest, TxBuildContext, UTxO } from '../../srv/utils/types';

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
  // _parseInlineDatum — branch coverage
  // =========================================================================

  describe('_parseInlineDatum — branch coverage', () => {
    const parseInlineDatum = (value: any) => (builder as any)._parseInlineDatum(value);

    it('should parse CBOR hex inline datum strings', () => {
      const parsed = parseInlineDatum('d87980');
      expect(parsed).toBeDefined();
    });

    it('should parse JSON string inline datum', () => {
      const parsed = parseInlineDatum('{"int": 42}');
      expect(parsed).toBeDefined();
    });

    it('should throw for hollow inline datum objects', () => {
      expect(() => parseInlineDatum({ bytes: null, value: null })).toThrow('Inline datum object has only null values');
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
});
