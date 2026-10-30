/**
 * Page sizes, ranges and enum parameters live in the service models, so CAP answers 400 before any
 * handler runs. Each case sends the real model's operation through CAP's input validation.
 */

import cds from '@sap/cds';
import path from 'path';

const ADDR = 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';

const services = new Map<string, cds.Service>();
beforeAll(async () => {
  const files = ['cardano-service', 'cardano-backend-service', 'cardano-tx-service', 'cardano-sign-service',
    'cardano-indexer-service', 'cardano-worker-service'];
  const csn = await cds.load(files.map(f => path.resolve(__dirname, '../../srv', `${f}.cds`)));
  const model = cds.linked(cds.compile.for.nodejs(csn as never) as never);
  for (const name of ['CardanoODataService', 'CardanoBackendService', 'CardanoTransactionService', 'CardanoSignService',
    'CardanoIndexerService', 'CardanoWorkerService']) {
    const srv = new cds.ApplicationService(name, model as never);
    await srv.init();
    // stands in for every handler: reaching it means validation let the request through
    srv.on('*', () => 'handled');
    services.set(name, srv);
  }
});

async function statusOf(service: string, op: string, data: Record<string, unknown>): Promise<number | string> {
  try {
    await services.get(service)!.send(op, data);
    return 200;
  } catch (e) {
    const err = e as { status?: number; code?: string | number; message?: string; details?: Array<{ status?: number; code?: string | number }> };
    if (err.message === 'MULTIPLE_ERRORS') {
      return err.details!.length === 2 && err.details!.every(d => Number(d.status ?? d.code) === 400) ? 'MULTIPLE_400' : JSON.stringify(err.details);
    }
    return err.status ?? Number(err.code);
  }
}

describe('list operations: limit and skip', () => {
  const lists: Array<[string, string, Record<string, unknown>, number]> = [
    ['CardanoODataService', 'GetAssetHistory', { unit: 'a'.repeat(56) }, 100],
    ['CardanoODataService', 'GetLatestTransactionsByAddress', { address: ADDR }, 100],
    ['CardanoODataService', 'GetUTxOsByAddress', { address: ADDR }, 5000],
    ['CardanoODataService', 'GetUTxOsByCredential', { credential: 'a'.repeat(56) }, 5000],
    ['CardanoODataService', 'GetAssetsByAddress', { address: ADDR }, 5000],
    ['CardanoODataService', 'GetMetadataByTxHash', { txHash: 'a'.repeat(64) }, 5000],
    ['CardanoTransactionService', 'GetTransactionBuildsByAddress', { address: ADDR }, 5000],
    ['CardanoSignService', 'GetSigningRequestsByAddress', { address: ADDR }, 5000],
  ];

  it.each(lists)('%s.%s accepts 1..max and rejects 0, max+1 and a negative skip', async (svc, op, base, max) => {
    expect(await statusOf(svc, op, base)).toBe(200);
    expect(await statusOf(svc, op, { ...base, limit: 1, skip: 0 })).toBe(200);
    expect(await statusOf(svc, op, { ...base, limit: max })).toBe(200);
    expect(await statusOf(svc, op, { ...base, limit: 0 })).toBe(400);
    expect(await statusOf(svc, op, { ...base, limit: max + 1 })).toBe(400);
    expect(await statusOf(svc, op, { ...base, skip: -1 })).toBe(400);
  });

  it('two invalid parameters in one request stay a 400 with both details', async () => {
    expect(await statusOf('CardanoODataService', 'GetUTxOsByAddress', { address: ADDR, limit: 0, skip: -1 })).toBe('MULTIPLE_400');
  });

  it('the backend service caps its counts', async () => {
    expect(await statusOf('CardanoBackendService', 'GetNextBlocks', { afterHash: 'a'.repeat(64), count: 500 })).toBe(200);
    expect(await statusOf('CardanoBackendService', 'GetNextBlocks', { afterHash: 'a'.repeat(64), count: 501 })).toBe(400);
    expect(await statusOf('CardanoBackendService', 'GetNextBlocks', { afterHash: 'a'.repeat(64), afterHeight: -1 })).toBe(400);
    expect(await statusOf('CardanoBackendService', 'GetAddressTransactionHashes', { address: ADDR, limit: 101 })).toBe(400);
    expect(await statusOf('CardanoBackendService', 'GetAssetHistory', { unit: 'a'.repeat(56), limit: 0 })).toBe(400);
  });
});

describe('ranges and enums', () => {
  it('rejects negative heights, slots and epochs', async () => {
    expect(await statusOf('CardanoODataService', 'GetEpochByNumber', { epochNumber: -1 })).toBe(400);
    expect(await statusOf('CardanoBackendService', 'GetBlockByHeight', { height: -1 })).toBe(400);
    expect(await statusOf('CardanoIndexerService', 'backfillCertificates', { fromSlot: -1 })).toBe(400);
    expect(await statusOf('CardanoIndexerService', 'backfillTransactions', { toSlot: -1 })).toBe(400);
    expect(await statusOf('CardanoIndexerService', 'importUtxoSet', { source: 'file', anchorSlot: -5 })).toBe(400);
  });

  it('rejects unknown enum values and accepts the listed ones', async () => {
    expect(await statusOf('CardanoIndexerService', 'importUtxoSet', { source: 'tape' })).toBe(400);
    expect(await statusOf('CardanoIndexerService', 'importUtxoSet', { source: 'scripts' })).toBe(200);
    expect(await statusOf('CardanoTransactionService', 'SubmitSignedTransaction', { signedTxCbor: 'aa', network: 'testnet' })).toBe(400);
    expect(await statusOf('CardanoTransactionService', 'DeriveScriptAddress', { validatorScript: 'aa', network: 'preprod' })).toBe(200);
    expect(await statusOf('CardanoWorkerService', 'SubmitWalletJob', { walletId: 'w', kind: 'teleport' })).toBe(400);
    expect(await statusOf('CardanoWorkerService', 'SubmitWalletJob', { walletId: 'w', kind: 'simpleAda', priority: 10_001 })).toBe(400);
    expect(await statusOf('CardanoWorkerService', 'SubmitWalletJob', { walletId: 'w', kind: 'simpleAda', priority: 10_000 })).toBe(200);
  });
});
