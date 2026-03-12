/**
 * Unit tests for mapper utilities
 */

import {
  mapTransaction,
  mapTransactionInputs,
  mapTransactionInputAssets,
  mapTransactionOutputAssets,
  mapAddress,
  mapAddressTransactions,
  mapAddressAssets,
  mapAddressUtxos,
  mapBuildResult,
  normalizeCostModels,
  scriptHashToEnterpriseAddress,
} from '../../srv/utils/mappers';

// Mock cds logger + utils
jest.mock('@sap/cds', () => ({
  log: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
  utils: {
    uuid: jest.fn(() => 'test-uuid-1234'),
  },
}));

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

    it('should handle V3 array format with padding to 297', () => {
      // V3 arrays are padded to 297 by toCostModelArrV3
      const raw = { PlutusV3: new Array(251).fill(100) };
      const result = normalizeCostModels(raw);
      expect(result.PlutusV3.length).toBe(297);
    });

    it('should handle V3 object format and convert to array', () => {
      // Create a minimal V3 object-format with a few known params
      const raw = { PlutusV3: { 'addInteger-cpu-arguments-intercept': 100, 'addInteger-cpu-arguments-slope': 200 } };
      const result = normalizeCostModels(raw);
      expect(Array.isArray(result.PlutusV3)).toBe(true);
      expect(result.PlutusV3.length).toBe(297);
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
      expect(result.hasAssets).toBe(false);
      expect(result.hasUTxOs).toBe(false);
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
      } as any], '2024-01-01', '2025-01-01');

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
  });

  // ==========================================================================
  // mapBuildResult
  // ==========================================================================
  describe('mapBuildResult', () => {
    it('should map build result with all fields', () => {
      const result = mapBuildResult({
        builderEngine: 'csl',
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
      expect(result.builderEngine).toBe('csl');
      expect(result.network).toBe('preview');
      expect(result.unsignedTxCbor).toBe('aabbccdd');
      expect(result.txBodyHash).toBe('hash123');
      expect(result.fee).toBe('200000');
      expect(result.hasInputs).toBe(true);
      expect(result.hasOutputs).toBe(true);
    });
  });
});
