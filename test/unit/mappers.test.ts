/**
 * Unit tests for mapper utilities
 */

import {
  mapTransaction,
  txSeqOf,
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
  mapBareAsset,
  BARE_ASSET_STAMP,
  mapPoolSnapshot,
  mapDrepSnapshot,
  computeCip14Fingerprint,
  mapTransactionCertificates,
  mapTransactionWithdrawals,
  credentialToStakeAddress,
  credentialToDrepId,
  decodeShelleyAddress,
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

  describe('txSeqOf / mapTransaction.txSeq', () => {
    it('orders by slot, then by position in the block', () => {
      expect(txSeqOf(0, 0)).toBe(0);
      expect(txSeqOf(1, 0)).toBeGreaterThan(txSeqOf(0, 65535));
      expect(txSeqOf(170_000_000, 300)).toBe(170_000_000 * 65536 + 300);
      expect(Number.isSafeInteger(txSeqOf(2 ** 36, 65535))).toBe(true);
    });

    it('sets txSeq on the transaction row', () => {
      const row = mapTransaction({ hash: 'h', blockHash: 'b', blockHeight: 1, slot: 10, index: 2, fee: '0', deposit: '0', size: 0, blockTime: 0 } as never);
      expect(row.txSeq).toBe(10 * 65536 + 2);
    });
  });

  // mapTransactionInputAssets — amount guard
  describe('mapTransactionInputAssets', () => {
    it('should return empty array when input.amount is undefined', () => {
      const result = mapTransactionInputAssets(42, [
        { txHash: 'def456', outputIndex: 0, address: 'addr_test1...', amount: undefined as any },
      ]);
      expect(result).toEqual([]);
    });

    it('should return empty array when input.amount is null', () => {
      const result = mapTransactionInputAssets(42, [
        { txHash: 'def456', outputIndex: 0, address: 'addr_test1...', amount: null as any },
      ]);
      expect(result).toEqual([]);
    });

    it('should map assets correctly when amount is valid array', () => {
      const result = mapTransactionInputAssets(42, [
        {
          txHash: 'def456',
          outputIndex: 0,
          address: 'addr_test1...',
          amount: [{ unit: 'lovelace', quantity: '5000000' }],
        },
      ]);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0].input_txSeq).toBe(42);
    });
  });

  // mapTransactionOutputAssets — amount guard
  describe('mapTransactionOutputAssets', () => {
    it('should return empty array when output.amount is undefined', () => {
      const result = mapTransactionOutputAssets(42, [
        { address: 'addr_test1...', outputIndex: 0, txHash: 'def456', dataHash: null, inlineDatum: null, isCollateral: false, amount: undefined as any },
      ]);
      expect(result).toEqual([]);
    });

    it('should return empty array when output.amount is null', () => {
      const result = mapTransactionOutputAssets(42, [
        { address: 'addr_test1...', outputIndex: 0, txHash: 'def456', dataHash: null, inlineDatum: null, isCollateral: false, amount: null as any },
      ]);
      expect(result).toEqual([]);
    });
  });

  // normalizeCostModels — object-format V3 handling
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

  describe('mapTransactionInputs', () => {
    it('should map inputs with collateral and reference flags', () => {
      const result = mapTransactionInputs(7, [
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
      expect(result[0].txSeq).toBe(7);
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

    it('keeps the consumed outpoint (spentTxHash / spentOutputIndex) on every row', () => {
      const result = mapTransactionInputs(7, [
        { txHash: 'a'.repeat(64), outputIndex: 2, address: 'addr_test1...', amount: [] },
        // a malformed line without an outpoint must not crash the block — null, not NaN
        { txHash: '', outputIndex: undefined as unknown as number, address: 'addr_test2...', amount: [] },
      ]);

      expect(result[0].spentTxHash).toBe('a'.repeat(64));
      expect(result[0].spentOutputIndex).toBe(2);
      expect(result[1].spentTxHash).toBeNull();
      expect(result[1].spentOutputIndex).toBeNull();
    });
  });

  // mapTransactionCertificates / mapTransactionWithdrawals (crawler.certificates)
  describe('mapTransactionCertificates', () => {
    it('maps every field and nulls the ones a kind does not carry', () => {
      const rows = mapTransactionCertificates('tx1', [
        { certIndex: 0, kind: 'stake_registration', stakeAddress: 'stake_test1abc', deposit: '2000000' },
        { certIndex: 1, kind: 'pool_retirement', poolId: 'pool1abc', epoch: 320 },
        { certIndex: 2, kind: 'someFutureType' },
      ]);

      expect(rows).toEqual([
        { tx_hash: 'tx1', certIndex: 0, kind: 'stake_registration', stakeAddress: 'stake_test1abc', poolId: null, drepId: null, deposit: '2000000', epoch: null },
        { tx_hash: 'tx1', certIndex: 1, kind: 'pool_retirement', stakeAddress: null, poolId: 'pool1abc', drepId: null, deposit: null, epoch: 320 },
        { tx_hash: 'tx1', certIndex: 2, kind: 'someFutureType', stakeAddress: null, poolId: null, drepId: null, deposit: null, epoch: null },
      ]);
    });

    it('stringifies a numeric deposit (Lovelace is Decimal(20,0) — never a JS number)', () => {
      const [row] = mapTransactionCertificates('tx1', [{ certIndex: 0, kind: 'drep_registration', drepId: 'drep1x', deposit: 500000000 }]);
      expect(row.deposit).toBe('500000000');
    });
  });

  describe('mapTransactionWithdrawals', () => {
    it('maps one row per reward account and drops entries without one', () => {
      const rows = mapTransactionWithdrawals('tx1', [
        { stakeAddress: 'stake_test1abc', amount: '99' },
        { stakeAddress: '', amount: '1' },
      ]);
      expect(rows).toEqual([{ tx_hash: 'tx1', stakeAddress: 'stake_test1abc', lovelace: '99' }]);
    });
  });

  // credentialToStakeAddress / credentialToDrepId (Ogmios hands out bare hashes)
  describe('credentialToStakeAddress', () => {
    // Koios API docs example reward account; payload e1 || hash (key credential, mainnet)
    const HASH = '9084d6174b028be3b346f5eb11e0a8bf889a7e464447f7973605c886';

    it('encodes a mainnet key credential as stake1…', () => {
      expect(credentialToStakeAddress(HASH, false, 'mainnet')).toBe('stake1uxggf4shfvpghcangm67ky0q4zlc3xn7gezy0auhxczu3pslm9wrj');
    });

    it('uses the stake_test HRP and network nibble 0 on preview/preprod', () => {
      const preview = credentialToStakeAddress(HASH, false, 'preview');
      expect(preview.startsWith('stake_test1')).toBe(true);
      expect(credentialToStakeAddress(HASH, false, 'preprod')).toBe(preview);
    });

    it('distinguishes a script credential by the type nibble', () => {
      expect(credentialToStakeAddress(HASH, true, 'mainnet')).not.toBe(credentialToStakeAddress(HASH, false, 'mainnet'));
      expect(credentialToStakeAddress(HASH, true, 'mainnet').startsWith('stake1')).toBe(true);
    });
  });

  describe('decodeShelleyAddress', () => {
    const BASE = 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';

    it('decodes a testnet base address to its reward account', () => {
      expect(decodeShelleyAddress(BASE)).toEqual({
        type: 'base', isScript: false, networkId: 0,
        stakeAddress: 'stake_test1uzkwsx05zawfcpyj8x53e8q8an3qhal8fpwhe4q5uus6tlq5k9vsh',
      });
    });

    it('flags a script payment credential and keeps the mainnet network nibble', () => {
      const d = decodeShelleyAddress('addr1zyetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qzrwnlv');
      expect(d).toMatchObject({ type: 'base', isScript: true, networkId: 1 });
      expect(d.stakeAddress).toMatch(/^stake1/);
    });

    it('returns no stake address for enterprise addresses and recognizes Byron / garbage', () => {
      expect(decodeShelleyAddress('addr_test1vqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxgntxrh0')).toEqual({ type: 'enterprise', isScript: false, stakeAddress: null, networkId: 0 });
      expect(decodeShelleyAddress('Ae2tdPwUPEZFRbyhz3cpfC2CumGzNkFBN2L42rcUc2yjQpEkxDbkPodpMAi').type).toBe('byron');
      expect(decodeShelleyAddress('not-an-address')).toEqual({ type: 'unknown', isScript: false, stakeAddress: null, networkId: null });
      expect(decodeShelleyAddress('')).toMatchObject({ type: 'unknown' });
    });

    it('treats a reward address as its own stake address', () => {
      const stake = 'stake_test1uzkwsx05zawfcpyj8x53e8q8an3qhal8fpwhe4q5uus6tlq5k9vsh';
      expect(decodeShelleyAddress(stake)).toEqual({ type: 'reward', isScript: false, stakeAddress: stake, networkId: 0 });
    });
  });

  describe('credentialToDrepId', () => {
    // CIP-129 id used across the suite; header 0x22 = key-hash DRep
    const HASH = 'bed9febc46ee63fa370bbc65446c067d61adcc46d8094e372694666b';

    it('encodes a key-hash credential as a CIP-129 drep1… id', () => {
      expect(credentialToDrepId(HASH, false)).toBe('drep1y2ldnl4ugmhx873hpw7x23rvqe7krtwvgmvqjn3hy62xv6c8ashc0');
    });

    it('sets the script nibble (0x23) for a script credential', () => {
      expect(credentialToDrepId(HASH, true)).not.toBe(credentialToDrepId(HASH, false));
      expect(credentialToDrepId(HASH, true).startsWith('drep1')).toBe(true);
    });
  });

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

  describe('mapBlock', () => {
    it('persists a real null slotLeader (not the string "null")', () => {
      const row = mapBlock({ time: 1700000000, height: 1, hash: 'h', slotLeader: null, epoch: 5, epochSlot: 1, size: 1, txCount: 0, fees: '0' } as any);
      expect(row.slotLeader).toBeNull();
      expect(row.slotLeader).not.toBe('null');
    });
  });

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

  // mapPool / mapDrep — temporal stamping (Pools/Dreps are temporal)
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
// mapBareAsset / mapPoolSnapshot / mapDrepSnapshot — crawler analytics coverage
describe('crawler analytics mappers', () => {
  const POLICY = 'a1'.repeat(28);
  const UNIT = POLICY + Buffer.from('SUNDAE').toString('hex');

  describe('mapBareAsset', () => {
    it('derives policy, name and CIP-14 fingerprint from the unit alone', () => {
      const row = mapBareAsset(UNIT)!;
      expect(row).toMatchObject({
        unit: UNIT,
        policyId: POLICY,
        assetNameHex: Buffer.from('SUNDAE').toString('hex'),
        assetName: 'SUNDAE',
      });
      expect(row.fingerprint).toBe(computeCip14Fingerprint(POLICY, Buffer.from('SUNDAE').toString('hex')));
    });

    it('leaves everything a provider would have to answer null', () => {
      const row = mapBareAsset(UNIT)!;
      expect(row.totalSupply).toBeNull();
      expect(row.mintOrBurnCount).toBeNull();
      expect(row.registryTicker).toBeNull();
      expect(row.onchainMetadata).toBeNull();
    });

    it('is born expired at the fixed sentinel, not at "now"', () => {
      const row = mapBareAsset(UNIT)!;
      // born expired -> hidden by CAP's temporal filter, so the lazy path still enriches it
      expect(row.validTo).toBe(row.validFrom);
      // fixed, so the same unit is one idempotent row and can never collide with the
      // wall-clock (validFrom, unit) key of a mapAsset() slice inside the block transaction
      expect(row.validFrom).toBe(BARE_ASSET_STAMP);
      expect(mapBareAsset(UNIT)!.validFrom).toBe(row.validFrom);
    });

    it('handles a nameless asset (policy only)', () => {
      const row = mapBareAsset(POLICY)!;
      expect(row.assetNameHex).toBe('');
      expect(row.assetName).toBe('');
      expect(row.fingerprint).toMatch(/^asset1/);
    });

    it('keeps the hex when the name is not clean UTF-8', () => {
      const nameHex = 'ff00ff';
      const row = mapBareAsset(POLICY + nameHex)!;
      expect(row.assetName).toBe(nameHex);
    });

    it('rejects what is not a native-asset unit', () => {
      expect(mapBareAsset('lovelace')).toBeNull();
      expect(mapBareAsset('tooshort')).toBeNull();
      expect(mapBareAsset(POLICY + 'zz')).toBeNull();
      // beyond the ledger's 32-byte asset-name cap
      expect(mapBareAsset(POLICY + 'ab'.repeat(33))).toBeNull();
      // odd-length name: not a whole number of bytes, so not a unit
      expect(mapBareAsset(POLICY + 'abc')).toBeNull();
    });
  });

  describe('mapPoolSnapshot / mapDrepSnapshot', () => {
    const at = { slot: 123456, time: 1700000000 };

    it('dates a pool observation by epoch and slot instead of stamping validity', () => {
      const row = mapPoolSnapshot({
        poolId: 'pool1abc', vrfKeyHash: 'vrf', blocksMinted: 42, blocksEpoch: 2,
        liveStake: '1000000', liveSize: 0.01, liveSaturation: 0.5, liveDelegators: 7,
        activeStake: '900000', activeSize: 0.009, pledge: '500000', margin: '0.03',
        fixedCost: '340000000', rewardAccount: 'stake1',
      } as any, 512, at);

      expect(row).toMatchObject({
        poolId: 'pool1abc', epoch: 512, snapshotSlot: 123456, snapshotTime: 1700000000,
        blocksMinted: 42, liveStake: '1000000', liveSaturation: 0.5, margin: 0.03,
      });
      expect((row as Record<string, unknown>).validFrom).toBeUndefined();
      expect((row as Record<string, unknown>).validTo).toBeUndefined();
    });

    it('dates a DRep observation the same way', () => {
      const row = mapDrepSnapshot({
        drepId: 'drep1xyz', hex: 'ab', amount: '250000', hasScript: false,
        lastActiveEpoch: 511, retired: false, expired: false,
      } as any, 512, at);

      expect(row).toMatchObject({
        drepId: 'drep1xyz', epoch: 512, snapshotSlot: 123456, snapshotTime: 1700000000,
        amount: '250000', retired: false, expired: false,
      });
      expect((row as Record<string, unknown>).validTo).toBeUndefined();
    });
  });
});
});
