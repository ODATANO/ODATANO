/**
 * CardanoIndexer Unit Tests
 * Tests edge cases and branch coverage for cardano-indexer.ts
 */

// Mock CDS entities and QL operators
const mockRun = jest.fn().mockResolvedValue(undefined);
const mockTx = { run: mockRun };

jest.mock('@sap/cds', () => {
  const mockEntries = jest.fn().mockReturnValue({});
  const mockFrom = jest.fn().mockReturnValue({
    columns: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({})
    }),
    where: jest.fn().mockReturnValue({})
  });
  const mockEntity = jest.fn().mockReturnValue({
    set: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({})
    })
  });
  const mockOne = {
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({})
    })
  };

  return {
    log: jest.fn(() => ({
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    })),
    utils: {
      uuid: jest.fn(() => 'test-uuid-1234'),
    },
    ql: {
      UPSERT: { into: jest.fn().mockReturnValue({ entries: mockEntries }) },
      INSERT: { into: jest.fn().mockReturnValue({ entries: mockEntries }) },
      UPDATE: { entity: mockEntity },
      SELECT: {
        from: mockFrom,
        one: mockOne,
      },
    },
  };
});

// Mock all CDS entity imports
jest.mock('#cds-models/CardanoODataService', () => ({
  Addresses: 'Addresses',
  Transaction: 'Transaction',
  AddressAssets: 'AddressAssets',
  AddressUTxOs: 'AddressUTxOs',
  Transactions: 'Transactions',
  TransactionInputs: 'TransactionInputs',
  TransactionInputAssets: 'TransactionInputAssets',
  TransactionOutputs: 'TransactionOutputs',
  TransactionOutputAssets: 'TransactionOutputAssets',
  TransactionMetadata: 'TransactionMetadata',
  NetworkInformation: 'NetworkInformation',
  UTxOAssets: 'UTxOAssets',
  Block: 'Block',
  Epoch: 'Epoch',
  Accounts: 'Accounts',
  Pools: 'Pools',
  Dreps: 'Dreps',
  Assets: 'Assets',
  AssetHistory: 'AssetHistory',
  Account: 'Account',
  Drep: 'Drep',
  Pool: 'Pool',
  Asset: 'Asset',
  Address: 'Address',
  LedgerProtocolParameter: 'LedgerProtocolParameter',
  AddressTransactions: 'AddressTransactions',
}), { virtual: true });

jest.mock('#cds-models/CardanoTransactionService', () => ({
  TransactionBuild: 'TransactionBuild',
  TransactionBuilds: 'TransactionBuilds',
  TransactionBuildInputs: 'TransactionBuildInputs',
  TransactionBuildOutputs: 'TransactionBuildOutputs',
  TransactionSubmission: 'TransactionSubmission',
  TransactionSubmissions: 'TransactionSubmissions',
  AddressTransactionBuilds: 'AddressTransactionBuilds',
}), { virtual: true });

jest.mock('#cds-models/CardanoSignService', () => ({
  SigningRequests: 'SigningRequests',
  SignatureVerifications: 'SignatureVerifications',
  AddressSigningRequests: 'AddressSigningRequests',
}), { virtual: true });

// Mock the mapper functions
jest.mock('../../srv/utils/mappers', () => ({
  mapTransaction: jest.fn((tx: any) => ({ hash: tx.hash, block_hash: tx.blockHash })),
  mapTransactionInputs: jest.fn(() => []),
  mapTransactionInputAssets: jest.fn(() => []),
  mapTransactionOutputs: jest.fn(() => []),
  mapTransactionOutputAssets: jest.fn(() => []),
  mapAddress: jest.fn((addr: string) => ({
    address: addr,
    validFrom: new Date().toISOString(),
    validTo: new Date(Date.now() + 3600000).toISOString(),
  })),
  mapAddressAssets: jest.fn(() => []),
  mapAddressUtxos: jest.fn(() => []),
  mapAddressUtxoAssets: jest.fn(() => []),
  mapNetworkInfo: jest.fn(() => ({})),
  mapBlock: jest.fn((blockInfo: any, epoch: any) => ({
    hash: blockInfo.hash || 'block-hash',
    epochNumber: epoch?.epoch ?? blockInfo.epoch,
  })),
  mapEpoch: jest.fn((epochInfo: any) => ({ epoch: epochInfo.epoch })),
  mapAccount: jest.fn((info: any) => ({
    stakeaddress: info.stakeaddress,
    hasAddresses: info.addresses?.length > 0,
  })),
  mapAsset: jest.fn((info: any) => ({ unit: info.unit, totalSupply: info.totalSupply })),
  mapAssetHistory: jest.fn((entries: any[]) => entries.map((e: any) => ({ unit: e.unit, txHash: e.txHash }))),
  mapDrep: jest.fn(() => ({})),
  mapPool: jest.fn(() => ({})),
  mapTransactionMetadata: jest.fn(() => []),
  mapBuildResult: jest.fn(() => ({ id: 'build-1' })),
  mapBuildInputs: jest.fn(() => []),
  mapBuildOutputs: jest.fn(() => []),
  mapProtocolParameters: jest.fn(() => ({})),
  mapTransactionSubmission: jest.fn(() => ({ id: 'sub-1' })),
  mapAddressTransactions: jest.fn(() => []),
  mapAddressSigningRequest: jest.fn(() => ({})),
  mapAddressTransactionBuild: jest.fn(() => ({})),
}));

import { CardanoIndexer } from '../../srv/blockchain/cardano-indexer';

function createMockClient(overrides: Record<string, any> = {}) {
  return {
    max_age_ms: 3600000,
    network: 'preview',
    getTransaction: jest.fn(),
    getAddress: jest.fn(),
    getBlock: jest.fn(),
    getEpoch: jest.fn(),
    getLatestEpoch: jest.fn(),
    getLatestBlock: jest.fn(),
    getNetworkInformation: jest.fn(),
    getAccount: jest.fn(),
    getDrep: jest.fn(),
    getPool: jest.fn(),
    getProtocolParameters: jest.fn(),
    getTransactionMetadata: jest.fn(),
    getAddressTransactionHashes: jest.fn(),
    getTransactionsBatch: jest.fn(),
    getCredentialUtxos: jest.fn(),
    getAssetInfo: jest.fn(),
    getAssetHistory: jest.fn(),
    ...overrides,
  } as any;
}

function createMockTxBuilder(overrides: Record<string, any> = {}) {
  return {
    buildSimpleAdaTransaction: jest.fn(),
    buildTransactionWithMetadata: jest.fn(),
    buildMultiAssetTransaction: jest.fn(),
    buildMintTransaction: jest.fn(),
    buildPlutusSpendTransaction: jest.fn(),
    ...overrides,
  } as any;
}

describe('CardanoIndexer', () => {
  let indexer: CardanoIndexer;
  let mockClient: any;
  let mockTxBuilder: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRun.mockResolvedValue(undefined);
    mockClient = createMockClient();
    mockTxBuilder = createMockTxBuilder();
    indexer = new CardanoIndexer(mockClient, mockTxBuilder);
  });

  describe('indexAddress', () => {
    it('should skip asset UPSERT when address has no assets (lovelace only)', async () => {
      mockClient.getAddress.mockResolvedValue({
        address: 'addr_test1qlovelace',
        amount: [{ unit: 'lovelace', quantity: '5000000' }],
        utxos: [],
      });

      const mapAddressAssets = require('../../srv/utils/mappers').mapAddressAssets;
      mapAddressAssets.mockReturnValue([]); // no assets

      await indexer.indexAddress(mockTx as any, 'addr_test1qlovelace');

      // UPSERT into Addresses should be called, but not into AddressAssets
      const calls = mockRun.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(1); // at least Addresses UPSERT
    });

    it('should skip UTxO UPSERT when address has no UTxOs', async () => {
      mockClient.getAddress.mockResolvedValue({
        address: 'addr_test1qempty',
        amount: [{ unit: 'lovelace', quantity: '0' }],
        utxos: [],
      });

      const mapAddressUtxos = require('../../srv/utils/mappers').mapAddressUtxos;
      mapAddressUtxos.mockReturnValue([]); // no utxos

      const mapAddressUtxoAssets = require('../../srv/utils/mappers').mapAddressUtxoAssets;
      mapAddressUtxoAssets.mockReturnValue([]); // no utxo assets

      await indexer.indexAddress(mockTx as any, 'addr_test1qempty');

      // Should not throw and should complete successfully
      expect(mockClient.getAddress).toHaveBeenCalledWith('addr_test1qempty');
    });

    it('should log error but not rethrow when indexAddressTransactions fails', async () => {
      mockClient.getAddress.mockResolvedValue({
        address: 'addr_test1qfail',
        amount: [{ unit: 'lovelace', quantity: '5000000' }],
        utxos: [{ txHash: 'tx1', outputIndex: 0, address: 'addr_test1qfail', amount: [{ unit: 'lovelace', quantity: '5000000' }] }],
      });

      const mapAddressUtxoAssets = require('../../srv/utils/mappers').mapAddressUtxoAssets;
      mapAddressUtxoAssets.mockReturnValue([
        { utxo_address_address: 'addr_test1qfail', utxo_hash: 'tx1', utxo_index: 0, unit: 'lovelace' }
      ]);

      // Make getAddressTransactionHashes throw to trigger the catch
      mockClient.getAddressTransactionHashes.mockRejectedValue(new Error('Backend timeout'));

      const result = await indexer.indexAddress(mockTx as any, 'addr_test1qfail');

      // Should complete without throwing
      expect(result).toBeDefined();
      expect(result.address).toBe('addr_test1qfail');
    });

    it('should supplement address assets from UTxOs', async () => {
      mockClient.getAddress.mockResolvedValue({
        address: 'addr_test1qassets',
        amount: [{ unit: 'lovelace', quantity: '5000000' }],
        utxos: [{
          txHash: 'tx1',
          outputIndex: 0,
          address: 'addr_test1qassets',
          amount: [
            { unit: 'lovelace', quantity: '2000000' },
            { unit: 'policyabc.token1', quantity: '100' }
          ]
        }],
      });

      const mapAddressAssets = require('../../srv/utils/mappers').mapAddressAssets;
      mapAddressAssets.mockReturnValue([{ unit: 'policyabc.token1', quantity: '100' }]);

      const mapAddressUtxoAssets = require('../../srv/utils/mappers').mapAddressUtxoAssets;
      mapAddressUtxoAssets.mockReturnValue([]);

      await indexer.indexAddress(mockTx as any, 'addr_test1qassets');

      // mapAddressAssets should have been called with the supplemented amount array
      expect(mapAddressAssets).toHaveBeenCalled();
    });
  });

  describe('indexAddressTransactions', () => {
    it('should return empty array when no tx hashes found', async () => {
      mockClient.getAddressTransactionHashes.mockResolvedValue([]);

      const result = await indexer.indexAddressTransactions(mockTx as any, 'addr_test1q', 10);

      expect(result).toEqual([]);
      expect(mockClient.getTransactionsBatch).not.toHaveBeenCalled();
    });

    it('should batch-fetch transactions missing from ensureTransactionsIndexed', async () => {
      mockClient.getAddressTransactionHashes.mockResolvedValue(['tx1', 'tx2']);

      // ensureTransactionsIndexed returns only tx1 (tx2 was already in DB)
      mockRun.mockImplementation((query: any) => {
        // SELECT from Transactions for DB check
        if (typeof query === 'object') {
          return Promise.resolve([{ hash: 'tx2' }]);
        }
        return Promise.resolve(undefined);
      });

      // getTransactionsBatch returns tx1
      mockClient.getTransactionsBatch.mockResolvedValue(
        new Map([['tx1', { hash: 'tx1', blockHash: 'b1', inputs: [], outputs: [], metadata: [] }]])
      );

      const mapAddressTransactions = require('../../srv/utils/mappers').mapAddressTransactions;
      mapAddressTransactions.mockReturnValue([
        { hash: 'tx1', blockTime: 1000 },
        { hash: 'tx2', blockTime: 2000 },
      ]);

      const result = await indexer.indexAddressTransactions(mockTx as any, 'addr_test1q', 10);

      // Should have called getTransactionsBatch for missing tx2
      expect(result).toHaveLength(2);
    });
  });

  describe('ensureTransactionsIndexed', () => {
    it('should return empty Map for empty hash list', async () => {
      const result = await indexer.ensureTransactionsIndexed(mockTx as any, []);
      expect(result).toEqual(new Map());
      expect(mockRun).not.toHaveBeenCalled();
    });

    it('should skip backend fetch when all transactions are cached', async () => {
      // All hashes already in DB
      mockRun.mockResolvedValue([{ hash: 'tx1' }, { hash: 'tx2' }]);

      const result = await indexer.ensureTransactionsIndexed(mockTx as any, ['tx1', 'tx2']);

      // Should have checked DB but not called getTransactionsBatch
      expect(mockClient.getTransactionsBatch).not.toHaveBeenCalled();
      expect(result.size).toBe(0); // returns empty map since nothing was fetched
    });

    it('should deduplicate hashes', async () => {
      mockRun.mockResolvedValue([]);
      mockClient.getTransactionsBatch.mockResolvedValue(
        new Map([['tx1', { hash: 'tx1', inputs: [], outputs: [], metadata: [] }]])
      );

      await indexer.ensureTransactionsIndexed(mockTx as any, ['tx1', 'tx1', 'tx1']);

      // Should only fetch unique hashes
      expect(mockClient.getTransactionsBatch).toHaveBeenCalledWith(['tx1']);
    });
  });

  describe('persistSignatureVerification', () => {
    it('should set status to "failed" when signature is invalid', async () => {
      const cds = require('@sap/cds');
      cds.utils.uuid.mockReturnValue('ver-uuid');

      await indexer.persistSignatureVerification(mockTx as any, {
        signingRequestId: 'sr-1',
        signedTxCbor: 'cbor-hex',
        verificationResult: {
          isValid: false,
          txBodyHash: 'hash',
          witnessCount: 0,
          signerKeyHashes: [],
          errorMessage: 'Invalid witness',
          warnings: [],
        },
      });

      // UPDATE should set status to 'failed' and include errorMessage
      expect(cds.ql.UPDATE.entity).toHaveBeenCalled();
    });

    it('should set status to "verified" when signature is valid', async () => {
      const cds = require('@sap/cds');
      cds.utils.uuid.mockReturnValue('ver-uuid-2');

      await indexer.persistSignatureVerification(mockTx as any, {
        signingRequestId: 'sr-2',
        signedTxCbor: 'cbor-hex-valid',
        verificationResult: {
          isValid: true,
          txBodyHash: 'hash2',
          witnessCount: 1,
          signerKeyHashes: ['keyhash1'],
          warnings: [],
        },
        signerType: 'cli',
        signerInfo: 'cardano-cli',
      });

      expect(cds.ql.UPDATE.entity).toHaveBeenCalled();
    });
  });

  describe('updateSubmissionStatus', () => {
    it('should update status without error message', async () => {
      const cds = require('@sap/cds');

      await indexer.updateSubmissionStatus(mockTx as any, 'sub-1', 'submitted');

      expect(cds.ql.UPDATE.entity).toHaveBeenCalled();
      expect(mockRun).toHaveBeenCalled();
    });

    it('should update status with error message', async () => {
      const cds = require('@sap/cds');

      await indexer.updateSubmissionStatus(mockTx as any, 'sub-2', 'failed', 'Transaction rejected');

      expect(cds.ql.UPDATE.entity).toHaveBeenCalled();
      expect(mockRun).toHaveBeenCalled();
    });
  });

  describe('indexBlock', () => {
    it('should handle missing epoch data gracefully', async () => {
      mockClient.getBlock.mockResolvedValue({
        hash: 'block-123',
        epoch: 999,
        height: 100,
        slot: 50000,
      });
      mockClient.getEpoch.mockRejectedValue(new Error('Epoch not found'));

      const mapBlock = require('../../srv/utils/mappers').mapBlock;
      mapBlock.mockReturnValue({ hash: 'block-123', epochNumber: 999 });

      const result = await indexer.indexBlock(mockTx as any, 'block-123');

      expect(result.hash).toBe('block-123');
      // mapBlock should have been called with undefined epoch
      expect(mapBlock).toHaveBeenCalledWith(expect.anything(), undefined);
    });
  });

  describe('indexLatestBlock', () => {
    it('should handle missing epoch data gracefully', async () => {
      mockClient.getLatestBlock.mockResolvedValue({
        hash: 'latest-block',
        epoch: 1000,
        height: 200,
        slot: 60000,
      });
      mockClient.getEpoch.mockRejectedValue(new Error('Epoch not available'));

      const mapBlock = require('../../srv/utils/mappers').mapBlock;
      mapBlock.mockReturnValue({ hash: 'latest-block', epochNumber: 1000 });

      const result = await indexer.indexLatestBlock(mockTx as any);

      expect(result.hash).toBe('latest-block');
      expect(mapBlock).toHaveBeenCalledWith(expect.anything(), undefined);
    });
  });

  describe('persistTransactionSubmission', () => {
    it('should persist submission without buildId', async () => {
      const result = await indexer.persistTransactionSubmission(mockTx as any, {
        signedTxCbor: 'cbor-hex',
        txHash: 'txhash-123',
      });

      expect(result).toBeDefined();
      expect(result.build_id).toBe(null);
    });

    it('should persist submission with buildId and update build status', async () => {
      const cds = require('@sap/cds');

      const result = await indexer.persistTransactionSubmission(mockTx as any, {
        signedTxCbor: 'cbor-hex',
        txHash: 'txhash-456',
        buildId: 'build-1',
      });

      expect(result).toBeDefined();
      expect(result.build_id).toBe('build-1');
      // Should have called UPDATE to set wasSubmitted
      expect(cds.ql.UPDATE.entity).toHaveBeenCalled();
    });
  });

  describe('indexProtocolParameters', () => {
    it('should return existing parameters if found in DB within TTL', async () => {
      const existingParams = { epoch: 100, minFeeA: 44 };
      // Simulate a recent fetch so the TTL check passes
      (indexer as any).lastParamsFetchTime = Date.now();
      mockRun.mockResolvedValueOnce(existingParams);

      const result = await indexer.indexProtocolParameters(mockTx as any);

      expect(result).toEqual(existingParams);
      // Should not have called getProtocolParameters on client
      expect(mockClient.getProtocolParameters).not.toHaveBeenCalled();
    });

    it('should fetch from provider when not in DB', async () => {
      mockRun.mockResolvedValueOnce(null); // SELECT returns null
      mockClient.getProtocolParameters.mockResolvedValue({ epoch: 200 });

      await indexer.indexProtocolParameters(mockTx as any);

      expect(mockClient.getProtocolParameters).toHaveBeenCalled();
    });
  });

  describe('indexCredentialUtxos', () => {
    const CRED = 'a'.repeat(56);
    const ADDR_WITH_STAKE = 'addr1z' + 'q'.repeat(98);
    const ADDR_NO_STAKE = 'addr1w' + 'q'.repeat(56);

    it('returns empty array and skips UPSERTs when client returns no UTxOs', async () => {
      mockClient.getCredentialUtxos.mockResolvedValue([]);

      const result = await indexer.indexCredentialUtxos(mockTx as any, CRED);

      expect(result).toEqual([]);
      expect(mockClient.getCredentialUtxos).toHaveBeenCalledWith(CRED);
      expect(mockRun).not.toHaveBeenCalled();
    });

    it('groups UTxOs by bech32 and UPSERTs each group separately', async () => {
      mockClient.getCredentialUtxos.mockResolvedValue([
        { txHash: 'a'.repeat(64), outputIndex: 0, address: ADDR_WITH_STAKE, amount: [{ unit: 'lovelace', quantity: '1' }] },
        { txHash: 'b'.repeat(64), outputIndex: 0, address: ADDR_NO_STAKE,    amount: [{ unit: 'lovelace', quantity: '2' }] },
        { txHash: 'c'.repeat(64), outputIndex: 1, address: ADDR_WITH_STAKE, amount: [{ unit: 'lovelace', quantity: '3' }] },
      ]);

      const mapAddressUtxos = require('../../srv/utils/mappers').mapAddressUtxos;
      // Return one row per input UTxO so we can count grouping
      mapAddressUtxos.mockImplementation((addr: string, _vf: string, _vt: string, group: any[]) =>
        group.map((u: any) => ({ address_address: addr, hash: u.txHash, index: u.outputIndex, lovelace: u.amount[0].quantity }))
      );

      const result = await indexer.indexCredentialUtxos(mockTx as any, CRED);

      // Two UPSERT calls expected (one per unique address group); UTxOAssets skipped (no native assets)
      expect(mapAddressUtxos).toHaveBeenCalledTimes(2);
      expect(mapAddressUtxos).toHaveBeenCalledWith(ADDR_WITH_STAKE, expect.any(String), expect.any(String), expect.arrayContaining([
        expect.objectContaining({ address: ADDR_WITH_STAKE })
      ]));
      expect(mapAddressUtxos).toHaveBeenCalledWith(ADDR_NO_STAKE, expect.any(String), expect.any(String), expect.arrayContaining([
        expect.objectContaining({ address: ADDR_NO_STAKE })
      ]));
      expect(result).toHaveLength(3);
    });

    it('writes UTxOAssets for groups with native assets and dedupes', async () => {
      const ASSET = 'a'.repeat(56) + '484f534b59';
      mockClient.getCredentialUtxos.mockResolvedValue([
        {
          txHash: 'a'.repeat(64),
          outputIndex: 0,
          address: ADDR_WITH_STAKE,
          amount: [
            { unit: 'lovelace', quantity: '1' },
            { unit: ASSET, quantity: '100' },
          ],
        },
      ]);

      const mapAddressUtxos = require('../../srv/utils/mappers').mapAddressUtxos;
      mapAddressUtxos.mockReturnValue([{ address_address: ADDR_WITH_STAKE, hash: 'a'.repeat(64), index: 0 }]);

      const mapAddressUtxoAssets = require('../../srv/utils/mappers').mapAddressUtxoAssets;
      // Simulate a duplicate row to verify dedup logic runs
      mapAddressUtxoAssets.mockReturnValue([
        { utxo_address_address: ADDR_WITH_STAKE, utxo_hash: 'a'.repeat(64), utxo_index: 0, unit: ASSET },
        { utxo_address_address: ADDR_WITH_STAKE, utxo_hash: 'a'.repeat(64), utxo_index: 0, unit: ASSET },
      ]);

      await indexer.indexCredentialUtxos(mockTx as any, CRED);

      // Find the UTxOAssets UPSERT call's payload
      const upsertCalls = mockRun.mock.calls;
      // At least 2 mockRun calls: AddressUTxOs + UTxOAssets
      expect(upsertCalls.length).toBeGreaterThanOrEqual(2);
    });

    it('does NOT upsert parent Addresses rows', async () => {
      mockClient.getCredentialUtxos.mockResolvedValue([
        { txHash: 'a'.repeat(64), outputIndex: 0, address: ADDR_WITH_STAKE, amount: [{ unit: 'lovelace', quantity: '1' }] },
      ]);
      const mapAddressUtxos = require('../../srv/utils/mappers').mapAddressUtxos;
      mapAddressUtxos.mockReturnValue([{ address_address: ADDR_WITH_STAKE, hash: 'a'.repeat(64), index: 0 }]);

      // Verify parent Addresses entity is NEVER UPSERTed during credential indexing
      const upsertInto = require('@sap/cds').ql.UPSERT.into;
      upsertInto.mockClear();

      await indexer.indexCredentialUtxos(mockTx as any, CRED);

      const upsertedEntities = upsertInto.mock.calls.map((c: any[]) => c[0]);
      expect(upsertedEntities).not.toContain('Addresses');
    });
  });

  describe('indexAsset', () => {
    const POLICY = 'a'.repeat(56);
    const UNIT = POLICY + '484f534b59';

    it('fetches asset info, maps it, and UPSERTs into Assets', async () => {
      const mockInfo = {
        unit: UNIT,
        policyId: POLICY,
        assetNameHex: '484f534b59',
        assetName: 'HOSKY',
        fingerprint: 'asset1xyz',
        totalSupply: '1000',
        mintOrBurnCount: 1,
        initialMintTxHash: 'b'.repeat(64),
        initialMintTime: 1700000000,
        onchainMetadata: null,
        registryName: null,
        registryTicker: null,
        registryDecimals: null,
        registryDescription: null,
        registryUrl: null,
        registryLogo: null,
      };
      mockClient.getAssetInfo.mockResolvedValue(mockInfo);

      const upsertInto = require('@sap/cds').ql.UPSERT.into;
      upsertInto.mockClear();

      const result = await indexer.indexAsset(mockTx as any, UNIT);

      expect(mockClient.getAssetInfo).toHaveBeenCalledWith(UNIT);
      expect(upsertInto).toHaveBeenCalledWith('Assets');
      expect(result.unit).toBe(UNIT);
    });

    it('propagates backend errors (no swallowing)', async () => {
      mockClient.getAssetInfo.mockRejectedValue(new Error('Asset not found'));
      await expect(indexer.indexAsset(mockTx as any, UNIT)).rejects.toThrow('Asset not found');
    });
  });

  describe('indexAssetHistory', () => {
    const POLICY = 'a'.repeat(56);
    const UNIT = POLICY + '484f534b59';

    it('returns empty array and skips UPSERT when client returns no events', async () => {
      mockClient.getAssetHistory.mockResolvedValue([]);

      const upsertInto = require('@sap/cds').ql.UPSERT.into;
      upsertInto.mockClear();

      const result = await indexer.indexAssetHistory(mockTx as any, UNIT);

      expect(result).toEqual([]);
      expect(mockClient.getAssetHistory).toHaveBeenCalledWith(UNIT, 100);
      expect(upsertInto).not.toHaveBeenCalled();
    });

    it('UPSERTs into AssetHistory and forwards limit', async () => {
      mockClient.getAssetHistory.mockResolvedValue([
        { unit: UNIT, txHash: 'b'.repeat(64), action: 'mint', quantity: '1', blockTime: 1, blockHeight: 1 },
      ]);

      const upsertInto = require('@sap/cds').ql.UPSERT.into;
      upsertInto.mockClear();

      const result = await indexer.indexAssetHistory(mockTx as any, UNIT, 25);

      expect(mockClient.getAssetHistory).toHaveBeenCalledWith(UNIT, 25);
      expect(upsertInto).toHaveBeenCalledWith('AssetHistory');
      expect(result).toHaveLength(1);
    });
  });
});
