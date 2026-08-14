/**
 * Unit tests for mapper utilities
 */

import {
  mapTransaction,
  mapTransactionMetadata,
  mapTransactionInputs,
  mapTransactionInputAssets,
  mapTransactionOutputAssets,
  mapAddress,
  mapAddressTransactions,
  mapAddressAssets,
  mapAddressUtxos,
  mapAsset,
  mapAssetHistory,
  mapBlock,
  mapBuildResult,
  mapPool,
  mapDrep,
  normalizeCostModels,
  scriptHashToEnterpriseAddress,
} from '../../srv/utils/mappers';
import { N_COST_MODEL_PLUTUS_V3 } from '@harmoniclabs/cardano-costmodels-ts';

// Mock cds logger + utils
vi.mock('@sap/cds', () => {
  const cdsMock = {
  log: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  utils: {
    uuid: vi.fn(() => 'test-uuid-1234'),
  },
};
  return { default: cdsMock, ...cdsMock };
});

describe('mappers', () => {

  // ==========================================================================
  // mapTransactionInputAssets — amount guard
  // ==========================================================================
  describe('mapTransactionInputAssets', () => {
    it('should return empty array when input.amount is undefined', () => {
      const result = mapTransactionInputAssets('abc123', [
        { txHash: 'def456', outputIndex: 0, address: 'addr_test1...', amount: undefined as any },
      ]);
      expect(result).toEqual([]);
    });

    it('should return empty array when input.amount is null', () => {
      const result = mapTransactionInputAssets('abc123', [
        { txHash: 'def456', outputIndex: 0, address: 'addr_test1...', amount: null as any },
      ]);
      expect(result).toEqual([]);
    });

    it('should map assets correctly when amount is valid array', () => {
      const result = mapTransactionInputAssets('abc123', [
        {
          txHash: 'def456',
          outputIndex: 0,
          address: 'addr_test1...',
          amount: [{ unit: 'lovelace', quantity: '5000000' }],
        },
      ]);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0].input_tx_hash).toBe('abc123');
    });
  });

  // ==========================================================================
  // mapTransactionOutputAssets — amount guard
  // ==========================================================================
  describe('mapTransactionOutputAssets', () => {
    it('should return empty array when output.amount is undefined', () => {
      const result = mapTransactionOutputAssets('abc123', [
        { address: 'addr_test1...', outputIndex: 0, txHash: 'def456', dataHash: null, inlineDatum: null, isCollateral: false, amount: undefined as any },
      ]);
      expect(result).toEqual([]);
    });

    it('should return empty array when output.amount is null', () => {
      const result = mapTransactionOutputAssets('abc123', [
        { address: 'addr_test1...', outputIndex: 0, txHash: 'def456', dataHash: null, inlineDatum: null, isCollateral: false, amount: null as any },
      ]);
      expect(result).toEqual([]);
    });
  });

  // ==========================================================================
  // normalizeCostModels — object-format V3 handling
  // ==========================================================================
  describe('normalizeCostModels', () => {
    it('should pass through V1/V2 arrays unchanged', () => {
      const raw = { PlutusV1: [1, 2, 3, 4, 5] };
      const result = normalizeCostModels(raw);
      expect(result.PlutusV1).toEqual([1, 2, 3, 4, 5]);
    });

    it('should convert V1/V2 object format to sorted array', () => {
      const raw = { PlutusV1: { 'b-param': 2, 'a-param': 1 } };
      const result = normalizeCostModels(raw);
      // Alphabetical sort: a-param=1, b-param=2
      expect(result.PlutusV1).toEqual([1, 2]);
    });

    it('should handle V3 array format with padding to the current on-chain cardinality', () => {
      // V3 arrays are padded by toCostModelArrV3 to N_COST_MODEL_PLUTUS_V3
      // (350 since costmodels-ts 1.6 / post-Plomin²; was 297 on Chang-2)
      const raw = { PlutusV3: new Array(251).fill(100) };
      const result = normalizeCostModels(raw);
      expect(result.PlutusV3.length).toBe(N_COST_MODEL_PLUTUS_V3);
    });

    it('should handle V3 object format and convert to array', () => {
      // Create a minimal V3 object-format with a few known params
      const raw = { PlutusV3: { 'addInteger-cpu-arguments-intercept': 100, 'addInteger-cpu-arguments-slope': 200 } };
      const result = normalizeCostModels(raw);
      expect(Array.isArray(result.PlutusV3)).toBe(true);
      expect(result.PlutusV3.length).toBe(N_COST_MODEL_PLUTUS_V3);
    });

    it('should skip non-array non-object values', () => {
      const raw = { PlutusV1: 'invalid' as any };
      const result = normalizeCostModels(raw);
      expect(result.PlutusV1).toBeUndefined();
    });
  });

  // ==========================================================================
  // scriptHashToEnterpriseAddress
  // ==========================================================================
  describe('scriptHashToEnterpriseAddress', () => {
    // Known script hash (28 bytes = 56 hex chars)
    const scriptHash = 'a'.repeat(56);

    it('should generate testnet address with addr_test prefix for preview', () => {
      const addr = scriptHashToEnterpriseAddress(scriptHash, 'preview');
      expect(addr).toMatch(/^addr_test1/);
    });

    it('should generate testnet address with addr_test prefix for preprod', () => {
      const addr = scriptHashToEnterpriseAddress(scriptHash, 'preprod');
      expect(addr).toMatch(/^addr_test1/);
    });

    it('should generate mainnet address with addr prefix', () => {
      const addr = scriptHashToEnterpriseAddress(scriptHash, 'mainnet');
      expect(addr).toMatch(/^addr1/);
      expect(addr).not.toMatch(/^addr_test/);
    });

    it('should produce different addresses for different networks', () => {
      const testAddr = scriptHashToEnterpriseAddress(scriptHash, 'preview');
      const mainAddr = scriptHashToEnterpriseAddress(scriptHash, 'mainnet');
      expect(testAddr).not.toBe(mainAddr);
    });

    it('should produce consistent results for same input', () => {
      const addr1 = scriptHashToEnterpriseAddress(scriptHash, 'preview');
      const addr2 = scriptHashToEnterpriseAddress(scriptHash, 'preview');
      expect(addr1).toBe(addr2);
    });
  });

  // ==========================================================================
  // mapTransaction
  // ==========================================================================
  describe('mapTransaction', () => {
    it('should map all fields from provider data', () => {
      const result = mapTransaction({
        hash: 'abc123',
        blockHash: 'block456',
        blockHeight: 100,
        blockTime: 1700000000,
        slot: 50000,
        index: 3,
        fee: '200000',
        deposit: '0',
        size: 512,
        inputs: [{ txHash: 'in1', outputIndex: 0, address: 'addr1', amount: [] }],
        outputs: [{ txHash: 'abc123', outputIndex: 0, address: 'addr2', amount: [], dataHash: null, inlineDatum: null, isCollateral: false }],
        metadata: [{ txHash: 'abc123', label: '721', json: '{}' }],
      });

      expect(result.hash).toBe('abc123');
      expect(result.blockHash).toBe('block456');
      expect(result.blockHeight).toBe(100);
      expect(result.blockTime).toBe(1700000000);
      expect(result.slot).toBe(50000);
      expect(result.txIndex).toBe(3);
      expect(result.fee).toBe('200000');
      expect(result.hasInputs).toBe(true);
      expect(result.hasOutputs).toBe(true);
      expect(result.hasMetadata).toBe(true);
    });

    it('should handle missing optional fields with null coalescing', () => {
      const result = mapTransaction({
        hash: 'abc123',
        blockHash: 'block456',
        inputs: [],
        outputs: [],
      } as any);

      expect(result.blockHeight).toBeNull();
      expect(result.blockTime).toBeNull();
      expect(result.slot).toBeNull();
      expect(result.txIndex).toBeNull();
      expect(result.fee).toBe('0');
      expect(result.deposit).toBe('0');
      expect(result.size).toBeNull();
      expect(result.hasInputs).toBe(false);
      expect(result.hasOutputs).toBe(false);
      expect(result.hasMetadata).toBe(false);
    });
  });

  describe('mapTransactionMetadata', () => {
    it('serializes nested Ogmios bigint metadata without precision loss', () => {
      const huge = 9_007_199_254_740_993_123_456_789n;
      const [row] = mapTransactionMetadata([{
        txHash: 'abc123',
        label: '721',
        json: { int: huge, nested: [1n, { negative: -huge }] } as never,
      }]);

      expect(row.payload).toBe(
        `{"int":${huge},"nested":[1,{"negative":${-huge}}]}`
      );
      expect(row.payload).not.toContain(`"${huge}"`);
    });
  });

  // ==========================================================================
  // mapTransactionInputs
  // ==========================================================================
  describe('mapTransactionInputs', () => {
    it('should map inputs with collateral and reference flags', () => {
      const result = mapTransactionInputs('tx123', [
        {
          txHash: 'utxo1', outputIndex: 0, address: 'addr_test1...',
          amount: [{ unit: 'lovelace', quantity: '5000000' }],
          isCollateral: true, isReference: false,
        },
        {
          txHash: 'utxo2', outputIndex: 1, address: 'addr_test2...',
          amount: [], isCollateral: false, isReference: true,
          dataHash: 'abc', inlineDatum: '{"int": 1}', referenceScriptHash: 'def',
        },
      ]);

      expect(result).toHaveLength(2);
      expect(result[0].tx_hash).toBe('tx123');
      expect(result[0].inputIndex).toBe(0);
      expect(result[0].isCollateral).toBe(true);
      expect(result[0].isReference).toBe(false);
      expect(result[0].hasAssets).toBe(true);
      expect(result[1].inputIndex).toBe(1);
      expect(result[1].isCollateral).toBe(false);
      expect(result[1].isReference).toBe(true);
      expect(result[1].hasAssets).toBe(false);
      expect(result[1].utxoData_dataHash).toBe('abc');
    });
  });

  // ==========================================================================
  // mapAddress
  // ==========================================================================
  describe('mapAddress', () => {
    it('should map address data with all optional fields', () => {
      const result = mapAddress('addr_test1abc', {
        address: 'addr_test1abc',
        amount: [{ unit: 'lovelace', quantity: '10000000' }],
        stakeAddress: 'stake_test1xyz',
        type: 'shelley',
        isScript: true,
        utxos: [{ txHash: 'a', outputIndex: 0, address: 'addr_test1abc', amount: [], blockHash: '', datumHash: null, scriptRef: null }],
      }, 3600000);

      expect(result.address).toBe('addr_test1abc');
      expect(result.stakeAddress).toBe('stake_test1xyz');
      expect(result.type).toBe('shelley');
      expect(result.isScript).toBe(true);
      expect(result.totalLovelace).toBe('10000000');
      expect(result.utxoCount).toBe(1);
      expect(result.hasAssets).toBe(false); // lovelace-only — no native assets
      expect(result.hasUTxOs).toBe(true);
    });

    it('should handle missing optional fields with defaults', () => {
      const result = mapAddress('addr_test1abc', {
        amount: [],
        utxos: [],
      } as any, 3600000);

      expect(result.stakeAddress).toBeNull();
      expect(result.type).toBe('base');
      expect(result.isScript).toBe(false);
      expect(result.totalLovelace).toBe('0');
      expect(result.utxoCount).toBe(0);
      expect(result.hasAssets).toBe(false);
      expect(result.hasUTxOs).toBe(false);
    });

    it('should count multiple UTxOs accurately', () => {
      const utxos = Array.from({ length: 7 }, (_, i) => ({
        txHash: 'a'.repeat(64),
        outputIndex: i,
        address: 'addr_test1abc',
        amount: [{ unit: 'lovelace', quantity: '1000000' }],
        blockHash: '',
        datumHash: null,
        scriptRef: null,
      }));
      const result = mapAddress('addr_test1abc', {
        address: 'addr_test1abc',
        amount: [{ unit: 'lovelace', quantity: '7000000' }],
        utxos,
      } as any, 3600000);

      expect(result.utxoCount).toBe(7);
      expect(result.hasUTxOs).toBe(true);
    });
  });

  // ==========================================================================
  // mapAddressTransactions
  // ==========================================================================
  describe('mapAddressTransactions', () => {
    it('should include net native asset deltas in netAssets JSON', () => {
      const addr = 'addr_test1abc';
      const unit = 'a'.repeat(56) + '546f6b656e4d'; // policy + "TokenM" hex

      const rows = mapAddressTransactions(addr, [{
        hash: 'tx123',
        blockTime: 1700000000,
        inputs: [{ txHash: 'in1', outputIndex: 0, address: addr, amount: [{ unit, quantity: '2' }] }],
        outputs: [{ txHash: 'tx123', outputIndex: 0, address: addr, amount: [{ unit, quantity: '5' }], dataHash: null, inlineDatum: null, isCollateral: false }],
      } as any]);

      expect(rows).toHaveLength(1);
      expect(rows[0].hasAssets).toBe(true);
      const parsed = JSON.parse(rows[0].netAssets!);
      expect(parsed[0].unit).toBe(unit);
      expect(parsed[0].quantity).toBe('3');
    });
  });

  // ==========================================================================
  // mapAddressAssets
  // ==========================================================================
  describe('mapAddressAssets', () => {
    it('should map invalid/short asset units with null policyId and raw assetName', () => {
      const rows = mapAddressAssets('addr_test1abc', '2024-01-01', '2025-01-01', [
        { unit: 'nothex', quantity: '10' } as any,
      ]);

      expect(rows).toHaveLength(1);
      expect(rows[0].asset_policyId).toBeNull();
      expect(rows[0].asset_assetName).toBe('nothex');
    });
  });

  // ==========================================================================
  // mapAddressUtxos
  // ==========================================================================
  describe('mapAddressUtxos', () => {
    it('should extract lovelace and detect multi-asset UTxOs', () => {
      const result = mapAddressUtxos('addr_test1abc', '2024-01-01', '2025-01-01', [
        {
          txHash: 'tx1', outputIndex: 0, address: 'addr_test1abc',
          amount: [
            { unit: 'lovelace', quantity: '5000000' },
            { unit: 'a'.repeat(56) + 'token1', quantity: '100' },
          ],
          blockHash: 'block1', datumHash: null, scriptRef: null,
        },
        {
          txHash: 'tx2', outputIndex: 1, address: 'addr_test1abc',
          amount: [{ unit: 'lovelace', quantity: '2000000' }],
          blockHash: 'block2', datumHash: null, scriptRef: null,
        },
      ]);

      expect(result).toHaveLength(2);
      expect(result[0].lovelace).toBe('5000000');
      expect(result[0].hasAssets).toBe(true);
      expect(result[1].lovelace).toBe('2000000');
      expect(result[1].hasAssets).toBe(false);
    });

    it('stores a hash-length scriptRef as-is but drops full-CBOR scriptRef (would truncate the hash column)', () => {
      const hash = 'ab'.repeat(28); // 56 hex = a script hash (Blockfrost/Ogmios)
      const fullCbor = '5876' + 'cd'.repeat(80); // full script CBOR from Koios (>64 chars)
      const result = mapAddressUtxos('addr_test1abc', '2024-01-01', '2025-01-01', [
        { txHash: 't1', outputIndex: 0, address: 'addr_test1abc', amount: [{ unit: 'lovelace', quantity: '1' }], blockHash: 'b', datumHash: null, scriptRef: hash } as any,
        { txHash: 't2', outputIndex: 0, address: 'addr_test1abc', amount: [{ unit: 'lovelace', quantity: '1' }], blockHash: 'b', datumHash: null, scriptRef: fullCbor } as any,
      ]);

      expect(result[0].utxodata_referenceScriptHash).toBe(hash);
      expect(result[1].utxodata_referenceScriptHash).toBeNull();
    });
  });

  // ==========================================================================
  // mapBlock
  // ==========================================================================
  describe('mapBlock', () => {
    it('persists a real null slotLeader (not the string "null")', () => {
      const row = mapBlock({ time: 1700000000, height: 1, hash: 'h', slotLeader: null, epoch: 5, epochSlot: 1, size: 1, txCount: 0, fees: '0' } as any);
      expect(row.slotLeader).toBeNull();
      expect(row.slotLeader).not.toBe('null');
    });
  });

  // ==========================================================================
  // mapBuildResult
  // ==========================================================================
  describe('mapBuildResult', () => {
    it('should map build result with all fields', () => {
      const result = mapBuildResult({
        builderEngine: 'buildooor',
        network: 'preview',
        senderAddress: 'addr_test1sender',
        unsignedTxCbor: 'aabbccdd',
        txBodyHash: 'hash123',
        feeLovelace: '200000',
        inputs: [{ txHash: 'in1', index: 0, lovelace: '5000000' }],
        outputs: [{ address: 'addr_test1out', lovelace: '3000000' }],
        warnings: [],
      }, 3600000);

      expect(result.id).toBe('test-uuid-1234');
      expect(result.builderEngine).toBe('buildooor');
      expect(result.network).toBe('preview');
      expect(result.unsignedTxCbor).toBe('aabbccdd');
      expect(result.txBodyHash).toBe('hash123');
      expect(result.fee).toBe('200000');
      expect(result.hasInputs).toBe(true);
      expect(result.hasOutputs).toBe(true);
    });
  });

  // ==========================================================================
  // mapAsset
  // ==========================================================================
  describe('mapAsset', () => {
    const POLICY = 'a'.repeat(56);
    const UNIT = POLICY + '484f534b59';

    it('passes through canonical fields and stamps temporal validity', () => {
      const before = Date.now();
      const result = mapAsset({
        unit: UNIT,
        policyId: POLICY,
        assetNameHex: '484f534b59',
        assetName: 'HOSKY',
        fingerprint: 'asset1xyz',
        totalSupply: '1000000',
        mintOrBurnCount: 3,
        initialMintTxHash: 'b'.repeat(64),
        initialMintTime: 1700000000,
        onchainMetadata: { name: 'Hosky' },
        registryName: 'Hosky Token',
        registryTicker: 'HOSKY',
        registryDecimals: 0,
        registryDescription: 'desc',
        registryUrl: 'https://hosky.io',
        registryLogo: 'data:...',
      }, 3600000);

      expect(result.unit).toBe(UNIT);
      expect(result.policyId).toBe(POLICY);
      expect(result.assetName).toBe('HOSKY');
      expect(result.totalSupply).toBe('1000000');
      expect(result.mintOrBurnCount).toBe(3);
      expect(result.initialMintTime).toBe(1700000000);
      expect(result.registryDecimals).toBe(0);
      // onchainMetadata is JSON-stringified for LargeString storage
      expect(result.onchainMetadata).toBe(JSON.stringify({ name: 'Hosky' }));
      // validFrom and validTo are ISO strings; validTo ~ now + max_age
      expect(typeof result.validFrom).toBe('string');
      expect(new Date(result.validTo!).getTime()).toBeGreaterThanOrEqual(before + 3600000 - 100);
    });

    it('serializes onchainMetadata=null to null (not "null")', () => {
      const result = mapAsset({
        unit: UNIT,
        policyId: POLICY,
        assetNameHex: '484f534b59',
        assetName: null,
        fingerprint: 'asset1xyz',
        totalSupply: '1',
        mintOrBurnCount: 1,
        initialMintTxHash: null,
        initialMintTime: null,
        onchainMetadata: null,
        registryName: null,
        registryTicker: null,
        registryDecimals: null,
        registryDescription: null,
        registryUrl: null,
        registryLogo: null,
      }, 3600000);

      expect(result.onchainMetadata).toBeNull();
      expect(result.assetName).toBeNull();
    });
  });

  // ==========================================================================
  // mapPool / mapDrep — temporal stamping (Pools/Dreps are now : temporal)
  // ==========================================================================
  describe('mapPool / mapDrep temporal stamping', () => {
    it('mapPool stamps validFrom/validTo from max_age so slices expire and re-fetch', () => {
      const before = Date.now();
      const row = mapPool({ poolId: 'pool1', margin: '0.05' } as any, 3_600_000);
      expect(row.validFrom).toBeDefined();
      expect(row.validTo).toBeDefined();
      const span = new Date(row.validTo!).getTime() - new Date(row.validFrom!).getTime();
      expect(span).toBe(3_600_000);
      expect(new Date(row.validFrom!).getTime()).toBeGreaterThanOrEqual(before);
    });

    it('mapDrep stamps validFrom/validTo from max_age', () => {
      const row = mapDrep({ drepId: 'drep1', retired: false, expired: false } as any, 60_000);
      const span = new Date(row.validTo!).getTime() - new Date(row.validFrom!).getTime();
      expect(span).toBe(60_000);
    });
  });

  // ==========================================================================
  // mapAssetHistory
  // ==========================================================================
  describe('mapAssetHistory', () => {
    const POLICY = 'a'.repeat(56);
    const UNIT = POLICY + '484f534b59';

    it('passes through canonical entries 1:1', () => {
      const entries = [
        { unit: UNIT, txHash: 'b'.repeat(64), action: 'mint' as const, quantity: '1000', blockTime: 1700000000, blockHeight: 100 },
        { unit: UNIT, txHash: 'c'.repeat(64), action: 'burn' as const, quantity: '50',   blockTime: null,        blockHeight: null },
      ];
      const rows = mapAssetHistory(entries);
      expect(rows).toEqual([
        { unit: UNIT, txHash: 'b'.repeat(64), action: 'mint', quantity: '1000', blockTime: 1700000000, blockHeight: 100 },
        { unit: UNIT, txHash: 'c'.repeat(64), action: 'burn', quantity: '50',   blockTime: null,        blockHeight: null },
      ]);
    });

    it('returns empty array for empty input', () => {
      expect(mapAssetHistory([])).toEqual([]);
    });
  });
});
