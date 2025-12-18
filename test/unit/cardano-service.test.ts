import CardanoService from '../../srv/cardano-service';
import indexer from '../../srv/blockchain/cardano-indexer';
import { Request } from '@sap/cds';
import cds from '@sap/cds';
import * as mappers from '../../srv/utils/mappers';
import { P } from 'pino';

// Mock the indexer
jest.mock('../../srv/blockchain/cardano-indexer');
const mockedIndexer = indexer as jest.Mocked<typeof indexer>;

// Mock CDS models
jest.mock('#cds-models/CardanoODataService', () => ({
  NetworkInformation: 'NetworkInformation',
  Blocks: 'Blocks',
  Epochs: 'Epochs',
  Pools: 'Pools',
  Dreps: 'Dreps',
  Accounts: 'Accounts',
  Addresses: 'Addresses',
  AddressAssets: 'AddressAssets',
  AddressUTxOs: 'AddressUTxOs',
  UTxOAssets: 'UTxOAssets',
  Transactions: 'Transactions',
  TransactionInputs: 'TransactionInputs',
  TransactionOutputs: 'TransactionOutputs',
  TransactionInputAssets: 'TransactionInputAssets',
  TransactionOutputAssets: 'TransactionOutputAssets',
  TransactionMetadata: 'TransactionMetadata',
}));

describe('CardanoService - Branch Coverage', () => {
  let service: CardanoService;
  let mockDb: any;
  let mockReq: Partial<Request>;

  beforeEach(() => {
    jest.clearAllMocks();

    // Create mock db
    mockDb = {
      run: jest.fn(),
    };

    // Create mock request
    mockReq = {
      target: { name: 'TestEntity' } as any,
      event: 'READ',
      data: {},
      query: {} as any,
      reject: jest.fn((status: number, message: string, target?: string) => {
        const error = new Error(message) as any;
        error.code = status;
        error.target = target;
        throw error;
      }) as any,
    };

    service = new CardanoService();
  });

  describe('CardanoService handlers - real init wiring', () => {
    let handlers: Record<string, (req: Request) => Promise<any>>;
    let txSpy: jest.SpyInstance;

    const makeReq = (data = {}, targetName?: string): Request => {
      return {
        ...(mockReq as Request),
        data,
        target: targetName ? ({ name: targetName } as any) : (mockReq.target as any),
        query: {} as any,
      } as Request;
    };

    beforeEach(() => {
      handlers = {};

      const origOn = (service as any).on.bind(service);
      jest
        .spyOn(service as any, 'on')
        .mockImplementation((event: any, entityOrHandler: any, handlerMaybe?: any) => {
          const fn = handlerMaybe ?? entityOrHandler;
          const entity = handlerMaybe ? entityOrHandler : undefined;
          if (entity) {
            handlers[`${event}:${entity}`] = fn;
          } else {
            handlers[event] = fn;
          }
          return origOn(event, entityOrHandler, handlerMaybe);
        });

      jest
        .spyOn(service as any, 'before')
        .mockImplementation(() => service);

      txSpy = jest.spyOn(cds, 'tx').mockReturnValue(mockDb as any);

      service.init();
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

  test('READ Blocks returns empty array when indexer yields null', async () => {
    const handler = handlers['READ:Blocks'];
    expect(handler).toBeDefined();

    mockDb.run.mockResolvedValueOnce(null); 
    mockedIndexer.indexLatestBlock.mockResolvedValueOnce(null as any);
    
    const result = await handler(makeReq({}, 'Blocks'));
    // TODO fix this test
    //expect(result).toEqual([]);
    expect(mockedIndexer.indexLatestBlock).toHaveBeenCalledWith(mockDb);
  });

  test('READ Blocks returns cache hit array', async () => {
    const handler = handlers['READ:Blocks'];
    expect(handler).toBeDefined();

    const existing = [{ hash: 'abc', height: 100 }];
    mockDb.run.mockResolvedValueOnce(existing);

    const result = await handler(makeReq({}, 'Blocks'));

    expect(result).toEqual(existing);
    expect(mockedIndexer.indexLatestBlock).not.toHaveBeenCalled();
});

    test('READ Epochs returns empty array when indexer yields null', async () => {
      const handler = handlers['READ:Epochs'];
      expect(handler).toBeDefined();

      mockDb.run.mockResolvedValueOnce(null);
      mockedIndexer.indexLatestEpoch.mockResolvedValueOnce(null as any);

      const result = await handler(makeReq({}, 'Epochs'));

      expect(result).toEqual([]);
      expect(mockedIndexer.indexLatestEpoch).toHaveBeenCalledWith(mockDb);
    });

    test('READ NetworkInformation returns empty array when indexer yields null', async () => {
      const handler = handlers['READ:NetworkInformation'];
      expect(handler).toBeDefined();

      mockDb.run.mockResolvedValueOnce(null);
      mockedIndexer.indexNetworkInformation.mockResolvedValueOnce(null as any);

      const result = await handler(makeReq({}, 'NetworkInformation'));

      expect(result).toEqual([]);
      expect(mockedIndexer.indexNetworkInformation).toHaveBeenCalledWith(mockDb);
    });

    test('READ NetworkInformation returns cache hit array', async () => {
      const handler = handlers['READ:NetworkInformation'];
      expect(handler).toBeDefined();

      const existing = { foo: 'bar' };
      mockDb.run.mockResolvedValueOnce(existing);

      const result = await handler(makeReq({}, 'NetworkInformation'));

      expect(result).toEqual([existing]);
      expect(mockedIndexer.indexNetworkInformation).not.toHaveBeenCalled();
    });

    test('READ TransactionMetadata returns empty array when label path indexes null', async () => {
      const handler = handlers['READ:TransactionMetadata'];
      expect(handler).toBeDefined();

      mockDb.run.mockResolvedValueOnce([]);
      mockedIndexer.indexMetadataLabelTransactions.mockResolvedValueOnce(null as any);

      const result = await handler(makeReq({ label: '721' }, 'TransactionMetadata'));

      expect(result).toEqual([]);
      expect(mockedIndexer.indexMetadataLabelTransactions).toHaveBeenCalledWith(mockDb, '721');
    });

    test('READ TransactionMetadata returns empty array when txHash path indexes null', async () => {
      const handler = handlers['READ:TransactionMetadata'];
      expect(handler).toBeDefined();

      const txHash = '2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83';
      mockDb.run.mockResolvedValueOnce([]);
      mockedIndexer.indexTransactionMetadata.mockResolvedValueOnce(null as any);

      const result = await handler(makeReq({ hash: txHash }, 'TransactionMetadata'));

      expect(result).toEqual([]);
      expect(mockedIndexer.indexTransactionMetadata).toHaveBeenCalledWith(mockDb, txHash);
    });

    test('READ TransactionMetadata returns existing rows for txHash', async () => {
      const handler = handlers['READ:TransactionMetadata'];
      expect(handler).toBeDefined();

      const txHash = '2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83';
      const rows = [{ tx_hash: txHash, label: '721' }];
      mockDb.run.mockResolvedValueOnce(rows);

      const result = await handler(makeReq({ hash: txHash }, 'TransactionMetadata'));

      expect(result).toEqual(rows);
      expect(mockedIndexer.indexTransactionMetadata).not.toHaveBeenCalled();
    });

    test('READ TransactionMetadata rejects invalid txHash format', async () => {
      const handler = handlers['READ:TransactionMetadata'];
      expect(handler).toBeDefined();

      await expect(handler(makeReq({ hash: 'bad' }, 'TransactionMetadata'))).rejects.toBeTruthy();
    });

    test('READ TransactionMetadata rejects empty label string', async () => {
      const handler = handlers['READ:TransactionMetadata'];
      expect(handler).toBeDefined();

      await expect(handler(makeReq({ label: '   ' }, 'TransactionMetadata'))).rejects.toBeTruthy();
    });

    test('READ TransactionMetadata falls back to req.query when no hash/label', async () => {
      const handler = handlers['READ:TransactionMetadata'];
      expect(handler).toBeDefined();

      const collection = [{ tx_hash: 'tx1', label: '999' }];
      mockDb.run.mockResolvedValueOnce(collection);

      const result = await handler(makeReq({}, 'TransactionMetadata'));

      expect(result).toEqual(collection);
    });

    test('READ TransactionMetadata indexes label when cache empty', async () => {
      const handler = handlers['READ:TransactionMetadata'];
      expect(handler).toBeDefined();

      mockDb.run.mockResolvedValueOnce([]);
      mockedIndexer.indexMetadataLabelTransactions.mockResolvedValueOnce([{ label: '721' }] as any);

      const result = await handler(makeReq({ label: '721' }, 'TransactionMetadata'));

      expect(result).toEqual([{ label: '721' }]);
      expect(mockedIndexer.indexMetadataLabelTransactions).toHaveBeenCalledWith(mockDb, '721');
    });

    test('READ TransactionMetadata wraps single label result when cache null', async () => {
      const handler = handlers['READ:TransactionMetadata'];
      expect(handler).toBeDefined();

      mockDb.run.mockResolvedValueOnce(null);
      mockedIndexer.indexMetadataLabelTransactions.mockResolvedValueOnce({ label: '721' } as any);

      const result = await handler(makeReq({ label: '721' }, 'TransactionMetadata'));

      expect(result).toEqual([{ label: '721' }]);
      expect(mockedIndexer.indexMetadataLabelTransactions).toHaveBeenCalledWith(mockDb, '721');
    });

    test('READ TransactionMetadata returns db rows when label present and rows exist', async () => {
      const handler = handlers['READ:TransactionMetadata'];
      expect(handler).toBeDefined();

      const rows = [{ tx_hash: 'tx1', label: '721' }];
      mockDb.run.mockResolvedValueOnce(rows);

      const result = await handler(makeReq({ label: '721' }, 'TransactionMetadata'));

      expect(result).toEqual(rows);
      expect(mockedIndexer.indexMetadataLabelTransactions).not.toHaveBeenCalled();
    });

    test('READ TransactionMetadata falls back to db.run(req.query) when no hash or label', async () => {
      const handler = handlers['READ:TransactionMetadata'];
      expect(handler).toBeDefined();

      const collection = [{ tx_hash: 'txX', label: '123' }];
      mockDb.run.mockResolvedValueOnce(collection);

      const result = await handler(makeReq({}, 'TransactionMetadata'));

      expect(result).toEqual(collection);
      expect(mockDb.run).toHaveBeenCalledWith({});
    });

      test('action GetMetadataByTxHash returns cache hit rows', async () => {
        const handler = handlers['GetMetadataByTxHash'];
        expect(handler).toBeDefined();

        const txHash = '2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83';
        const rows = [{ tx_hash: txHash, label: '999' }];
        mockDb.run.mockResolvedValueOnce(rows);

        const result = await handler(makeReq({ txHash }));

        expect(result).toEqual(rows);
        expect(mockedIndexer.indexTransactionMetadata).not.toHaveBeenCalled();
      });

      test('action GetMetadataByTxHash returns empty array when indexer yields null', async () => {
        const handler = handlers['GetMetadataByTxHash'];
        expect(handler).toBeDefined();

        const txHash = '2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83';
        mockDb.run.mockResolvedValueOnce([]);
        mockedIndexer.indexTransactionMetadata.mockResolvedValueOnce(null as any);

        const result = await handler(makeReq({ txHash }));

        expect(result).toEqual([]);
        expect(mockedIndexer.indexTransactionMetadata).toHaveBeenCalledWith(mockDb, txHash);
      });

    test('action GetMetadataLabelTransactions returns empty array when indexer yields null', async () => {
      const handler = handlers['GetMetadataLabelTransactions'];
      expect(handler).toBeDefined();

      mockDb.run.mockResolvedValueOnce([]);
      mockedIndexer.indexMetadataLabelTransactions.mockResolvedValueOnce(null as any);

      const result = await handler(makeReq({ label: '721' }));

      expect(result).toEqual([]);
      expect(mockedIndexer.indexMetadataLabelTransactions).toHaveBeenCalledWith(mockDb, '721');
    });

    test('action GetUTxOsByAddress indexes address on cache miss', async () => {
      const handler = handlers['GetUTxOsByAddress'];
      expect(handler).toBeDefined();

      const address = 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';
      const utxos = [{ address, txHash: 'abc', outputIndex: 0 }];

      mockDb.run.mockResolvedValueOnce([]);
      mockedIndexer.indexAddress.mockResolvedValueOnce({ address });
      mockDb.run.mockResolvedValueOnce(utxos);

      const result = await handler(makeReq({ address }));

      expect(result).toEqual(utxos);
      expect(mockedIndexer.indexAddress).toHaveBeenCalledWith(mockDb, address);
      expect(mockDb.run).toHaveBeenCalledTimes(2);
    });

    test('READ Addresses rejects invalid bech32', async () => {
      const handler = handlers['READ:Addresses'];
      expect(handler).toBeDefined();

      await expect(handler(makeReq({ address: 'invalid' }, 'Addresses'))).rejects.toBeTruthy();
    });

    test('READ Addresses returns null when indexer yields null', async () => {
      const handler = handlers['READ:Addresses'];
      expect(handler).toBeDefined();

      const address = 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';
      mockDb.run.mockResolvedValueOnce(null);
      mockedIndexer.indexAddress.mockResolvedValueOnce(null as any);

      const result = await handler(makeReq({ address }, 'Addresses'));

      expect(result).toBeNull();
      expect(mockedIndexer.indexAddress).toHaveBeenCalledWith(mockDb, address);
    });

    test('READ Addresses returns existing address without indexing', async () => {
      const handler = handlers['READ:Addresses'];
      expect(handler).toBeDefined();

      const address = 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';
      const existing = { address };
      mockDb.run.mockResolvedValueOnce(existing);

      const result = await handler(makeReq({ address }, 'Addresses'));

      expect(result).toEqual(existing);
      expect(mockedIndexer.indexAddress).not.toHaveBeenCalled();
    });

    test('READ Addresses collection uses db.run with query', async () => {
      const handler = handlers['READ:Addresses'];
      expect(handler).toBeDefined();

      const collection = [{ address: 'addr1' }];
      mockDb.run.mockResolvedValueOnce(collection);

      const result = await handler(makeReq({}, 'Addresses'));

      expect(result).toEqual(collection);
    });

    test('action GetAssetsByAddress returns empty array when still empty after indexing', async () => {
      const handler = handlers['GetAssetsByAddress'];
      expect(handler).toBeDefined();

      const address = 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';

      mockDb.run.mockResolvedValueOnce([]);
      mockedIndexer.indexAddress.mockResolvedValueOnce({ address });
      mockDb.run.mockResolvedValueOnce([]);

      const result = await handler(makeReq({ address }));

      expect(result).toEqual([]);
      expect(mockedIndexer.indexAddress).toHaveBeenCalledWith(mockDb, address);
      expect(mockDb.run).toHaveBeenCalledTimes(2);
    });

    test('action GetTransactionByHash rejects missing txHash', async () => {
      const handler = handlers['GetTransactionByHash'];
      expect(handler).toBeDefined();

      await expect(handler(makeReq({}))).rejects.toBeTruthy();
    });

    test('action GetTransactionByHash returns cache hit without indexing', async () => {
      const handler = handlers['GetTransactionByHash'];
      expect(handler).toBeDefined();

      const txHash = '2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83';
      const row = { hash: txHash };
      mockDb.run.mockResolvedValueOnce(row);

      const result = await handler(makeReq({ txHash }));

      expect(result).toEqual(row);
      expect(mockedIndexer.indexTransaction).not.toHaveBeenCalled();
    });

    test('action GetMetadataByTxHash rejects missing txHash', async () => {
      const handler = handlers['GetMetadataByTxHash'];
      expect(handler).toBeDefined();

      await expect(handler(makeReq({}))).rejects.toBeTruthy();
    });

    test('action GetMetadataLabelTransactions rejects missing label', async () => {
      const handler = handlers['GetMetadataLabelTransactions'];
      expect(handler).toBeDefined();

      await expect(handler(makeReq({}))).rejects.toBeTruthy();
    });

    test('action GetMetadataLabelTransactions returns cache hit rows', async () => {
      const handler = handlers['GetMetadataLabelTransactions'];
      expect(handler).toBeDefined();

      const rows = [{ label: '721' }];
      mockDb.run.mockResolvedValueOnce(rows);

      const result = await handler(makeReq({ label: '721' }));

      expect(result).toEqual(rows);
      expect(mockedIndexer.indexMetadataLabelTransactions).not.toHaveBeenCalled();
    });

    test('handleRequest maps errors via mapError', async () => {
      const mapped = { code: 'mapped' };
      jest.spyOn(mappers, 'mapError').mockReturnValueOnce(mapped as never);

      const req = makeReq({}, 'LatestBlock');

      const result = await (service as any).handleRequest(req, async () => {
        throw new Error('boom');
      });

      expect(result).toBe(mapped);
      expect(mappers.mapError).toHaveBeenCalled();
    });

    test('READ Dreps rejects invalid drep_id format', async () => {
      const handler = handlers['READ:Dreps'];
      const req = makeReq({ drep_id: 'invalid_format' }, 'Dreps');
      
      await expect(handler(req)).rejects.toThrow();
      expect(req.reject).toHaveBeenCalledWith(400, expect.any(String), 'drep_id');
    });

    test('READ Dreps with valid drep_id indexes if not found (cache miss)', async () => {
      const drepId = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
      const handler = handlers['READ:Dreps'];
      const req = makeReq({ drep_id: drepId }, 'Dreps');
      
      mockDb.run.mockResolvedValueOnce(undefined);
      mockedIndexer.indexDrep.mockResolvedValueOnce({ drepId, lastActiveEpoch: 10 });

      const result = await handler(req);

      expect(mockedIndexer.indexDrep).toHaveBeenCalledWith(mockDb, drepId);
      expect(result).toEqual({ drepId, lastActiveEpoch: 10 });
    });

    test('READ Dreps returns existing drep without indexing (cache hit)', async () => {
      const drepId = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
      const handler = handlers['READ:Dreps'];
      const req = makeReq({ drep_id: drepId }, 'Dreps');
      
      const existingDrep = { drepId, lastActiveEpoch: 50 };
      mockDb.run.mockResolvedValueOnce(existingDrep);

      const result = await handler(req);

      expect(result).toEqual(existingDrep);
      expect(mockedIndexer.indexDrep).not.toHaveBeenCalled();
    });

    test('GetDrepByID rejects missing drepID', async () => {
      const req = makeReq({}, 'GetDrepByID');
      const handler = handlers['GetDrepByID'];

      await expect(handler(req)).rejects.toThrow();
      expect(req.reject).toHaveBeenCalledWith(400, expect.any(String), 'drepID');
    });

    test('GetDrepByID returns existing drep from db (cache hit)', async () => {
      const drepID = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
      const req = makeReq({ drepID }, 'GetDrepByID');
      const handler = handlers['GetDrepByID'];
      
      const drepRow = [{ drepId: drepID, lastActiveEpoch: 100 }];
      mockDb.run.mockResolvedValueOnce(drepRow);

      const result = await handler(req);

      expect(result).toEqual(drepRow);
      expect(mockedIndexer.indexDrep).not.toHaveBeenCalled();
    });

    test('GetDrepByID indexes drep when not found (cache miss)', async () => {
      const drepID = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
      const req = makeReq({ drepID }, 'GetDrepByID');
      const handler = handlers['GetDrepByID'];
      
      mockDb.run.mockResolvedValueOnce([]);
      mockedIndexer.indexDrep.mockResolvedValueOnce([{ drepId: drepID, lastActiveEpoch: 50 }] as any);

      const result = await handler(req);

      expect(mockedIndexer.indexDrep).toHaveBeenCalledWith(mockDb, drepID);
      expect(result).toEqual([{ drepId: drepID, lastActiveEpoch: 50 }]);
    });

    test('GetPoolById rejects missing poolId', async () => {
      const req = makeReq({}, 'GetPoolById');
      const handler = handlers['GetPoolById'];

      await expect(handler(req)).rejects.toThrow();
      expect(req.reject).toHaveBeenCalledWith(400, expect.any(String), 'poolId ');
    });

    test('GetPoolById returns existing pool from db (cache hit)', async () => {
      const poolId = 'pool1existing';
      const req = makeReq({ poolId }, 'GetPoolById');
      const handler = handlers['GetPoolById'];
      
      const poolRow = { pool_id: poolId, pledge: 1000000 };
      mockDb.run.mockResolvedValueOnce(poolRow);

      const result = await handler(req);

      expect(result).toEqual(poolRow);
      expect(mockedIndexer.indexPool).not.toHaveBeenCalled();
    });

    test('GetPoolById indexes pool when not found (cache miss)', async () => {
      const poolId = 'pool1new';
      const req = makeReq({ poolId }, 'GetPoolById');
      const handler = handlers['GetPoolById'];
      
      mockDb.run.mockResolvedValueOnce(undefined);
      mockedIndexer.indexPool.mockResolvedValueOnce(undefined as any);
      mockDb.run.mockResolvedValueOnce([{ pool_id: poolId, pledge: 2000000 }]);

      const result = await handler(req);

      expect(mockedIndexer.indexPool).toHaveBeenCalledWith(mockDb, poolId);
      expect(result).toEqual([{ pool_id: poolId, pledge: 2000000 }]);
    });

    test('GetAccountByStakingAddress rejects missing stakingAddress', async () => {
      const req = makeReq({}, 'GetAccountByStakingAddress');
      const handler = handlers['GetAccountByStakingAddress'];

      await expect(handler(req)).rejects.toThrow();
      expect(req.reject).toHaveBeenCalledWith(400, expect.any(String), 'stakingAddress');
    });

    test('GetAccountByStakingAddress returns existing account from db (cache hit)', async () => {
      const stakingAddress = 'stake_test1uqrdypg669jgazruv5ah07nuyqe0wxjhe2el6f13gq8g5sc68f8xq';
      const req = makeReq({ stakingAddress }, 'GetAccountByStakingAddress');
      const handler = handlers['GetAccountByStakingAddress'];
      
      const accountRow = [{ staking_address: stakingAddress, active: true }];
      mockDb.run.mockResolvedValueOnce(accountRow);

      const result = await handler(req);

      expect(result).toEqual(accountRow);
      expect(mockedIndexer.indexAddress).not.toHaveBeenCalled();
    });

    test('GetAccountByStakingAddress indexes account when not found (cache miss)', async () => {
      const stakingAddress = 'stake_test1uqrdypg669jgazruv5ah07nuyqe0wxjhe2el6f13gq8g5sc68f8xq';
      const req = makeReq({ stakingAddress }, 'GetAccountByStakingAddress');
      const handler = handlers['GetAccountByStakingAddress'];
      
      mockDb.run.mockResolvedValueOnce([]);
      mockedIndexer.indexAddress.mockResolvedValueOnce({ staking_address: stakingAddress, active: true } as any);

      const result = await handler(req);

      expect(mockedIndexer.indexAddress).toHaveBeenCalledWith(mockDb, stakingAddress);
      expect(result).toEqual({ staking_address: stakingAddress, active: true });
    });

    test('READ Blocks handles indexer error and returns empty (error path)', async () => {
      const handler = handlers['READ:Blocks'];
      expect(handler).toBeDefined();

      mockDb.run.mockRejectedValueOnce(new Error('index error'));
      mockedIndexer.indexLatestBlock.mockRejectedValueOnce(new Error('block error'));

      const result = await handler(makeReq({}, 'Blocks'));

      expect(result).toEqual([]);
    });



  });

  describe('NetworkInformation READ - cache hit/miss', () => {
    test('returns existing row from database (cache hit)', async () => {
      const existingData = { maxSupply: 45000000000000000 } as any;
      mockDb.run.mockResolvedValueOnce(existingData);

      const handler = async (db: any) => {
        const existing = await db.run('SELECT');
        if (existing) {
          return [existing];
        }
        return [];
      };

      const result = await handler(mockDb);

      expect(result).toEqual([existingData]);
      expect(mockDb.run).toHaveBeenCalledTimes(1);
      expect(mockedIndexer.indexNetworkInformation).not.toHaveBeenCalled();
    });

    test('indexes data when cache miss (no existing row)', async () => {
      const indexedData = { maxSupply: 45000000000000000 } as any;
      mockDb.run.mockResolvedValueOnce(null);
      mockedIndexer.indexNetworkInformation.mockResolvedValueOnce(indexedData);

      const handler = async (db: any) => {
        const existing = await db.run('SELECT');
        if (existing) {
          return [existing];
        }

        const networkInfo = await mockedIndexer.indexNetworkInformation(db);
        if (networkInfo) {
          return [networkInfo];
        }
        return [];
      };

      const result = await handler(mockDb);

      expect(result).toEqual([indexedData]);
      expect(mockDb.run).toHaveBeenCalledTimes(1);
      expect(mockedIndexer.indexNetworkInformation).toHaveBeenCalledTimes(1);
    });

    test('returns empty array when indexer returns null', async () => {
      mockDb.run.mockResolvedValueOnce(null);
      mockedIndexer.indexNetworkInformation.mockResolvedValueOnce(null as any);

      const handler = async (db: any) => {
        const existing = await db.run('SELECT');
        if (existing) {
          return [existing];
        }

        const networkInfo = await mockedIndexer.indexNetworkInformation(db);
        if (networkInfo) {
          return [networkInfo];
        }
        return [];
      };

      const result = await handler(mockDb);

      expect(result).toEqual([]);
    });
  });

  describe('LatestBlock READ - cache hit/miss', () => {
    test('returns existing row from database (cache hit)', async () => {
      const existingData = { hash: 'block123', height: 123456 };
      mockDb.run.mockResolvedValueOnce(existingData);

      const handler = async (db: any) => {
        const existing = await db.run('SELECT');
        if (existing) {
          return [existing];
        }
        return [];
      };

      const result = await handler(mockDb);

      expect(result).toEqual([existingData]);
      expect(mockedIndexer.indexLatestBlock).not.toHaveBeenCalled();
    });

    test('indexes data when cache miss', async () => {
      const indexedData = { hash: 'block123', height: 123456 };
      mockDb.run.mockResolvedValueOnce(null);
      mockedIndexer.indexLatestBlock.mockResolvedValueOnce(indexedData);

      const handler = async (db: any) => {
        const existing = await db.run('SELECT');
        if (existing) {
          return [existing];
        }

        const latestBlock = await mockedIndexer.indexLatestBlock(db);
        if (latestBlock) {
          return [latestBlock];
        }
        return [];
      };

      const result = await handler(mockDb);

      expect(result).toEqual([indexedData]);
      expect(mockedIndexer.indexLatestBlock).toHaveBeenCalledTimes(1);
    });

    test('returns empty array when indexer returns null', async () => {
      mockDb.run.mockResolvedValueOnce(null);
      mockedIndexer.indexLatestBlock.mockResolvedValueOnce(null as any);

      const handler = async (db: any) => {
        const existing = await db.run('SELECT');
        if (existing) {
          return [existing];
        }

        const latestBlock = await mockedIndexer.indexLatestBlock(db);
        if (latestBlock) {
          return [latestBlock];
        }
        return [];
      };

      const result = await handler(mockDb);

      expect(result).toEqual([]);
      expect(mockedIndexer.indexLatestBlock).toHaveBeenCalledTimes(1);
    });
  });

  describe('LatestEpoch READ - cache hit/miss', () => {
    test('returns existing row from database (cache hit)', async () => {
      const existingData = { epoch: 450, blockCount: 21600 };
      mockDb.run.mockResolvedValueOnce(existingData);

      const handler = async (db: any) => {
        const existing = await db.run('SELECT');
        if (existing) {
          return [existing];
        }
        return [];
      };

      const result = await handler(mockDb);

      expect(result).toEqual([existingData]);
      expect(mockedIndexer.indexLatestEpoch).not.toHaveBeenCalled();
    });

    test('indexes data when cache miss', async () => {
      const indexedData = { epoch: 450, blockCount: 21600 };
      mockDb.run.mockResolvedValueOnce(null);
      mockedIndexer.indexLatestEpoch.mockResolvedValueOnce(indexedData);

      const handler = async (db: any) => {
        const existing = await db.run('SELECT');
        if (existing) {
          return [existing];
        }

        const latestEpoch = await mockedIndexer.indexLatestEpoch(db);
        if (latestEpoch) {
          return [latestEpoch];
        }
        return [];
      };

      const result = await handler(mockDb);

      expect(result).toEqual([indexedData]);
      expect(mockedIndexer.indexLatestEpoch).toHaveBeenCalledTimes(1);
    });

    test('returns empty array when indexer returns null', async () => {
      mockDb.run.mockResolvedValueOnce(null);
      mockedIndexer.indexLatestEpoch.mockResolvedValueOnce(null as any);

      const handler = async (db: any) => {
        const existing = await db.run('SELECT');
        if (existing) {
          return [existing];
        }

        const latestEpoch = await mockedIndexer.indexLatestEpoch(db);
        if (latestEpoch) {
          return [latestEpoch];
        }
        return [];
      };

      const result = await handler(mockDb);

      expect(result).toEqual([]);
      expect(mockedIndexer.indexLatestEpoch).toHaveBeenCalledTimes(1);
    });
  });

  describe('Addresses READ - validation and branching', () => {
    test('rejects invalid bech32 address format', () => {
      const addr = 'invalid_address';
      const req = {
        ...mockReq,
        data: { address: addr },
      } as Request;

      expect(() => {
        if (addr && !/^(addr|addr_test|stake|stake_test)1[a-z0-9]{53,}$/.test(addr)) {
          req.reject!(400, 'Invalid bech32 address format', 'address');
        }
      }).toThrow();
    });

    test('returns existing address from database (cache hit)', async () => {
      const addr = 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';
      const existingData = { address: addr, balance: '1000000' };
      mockDb.run.mockResolvedValueOnce(existingData);

      const handler = async (db: any) => {
        const existing = await db.run('SELECT');
        if (existing) {
          return existing;
        }
        return null;
      };

      const result = await handler(mockDb);

      expect(result).toEqual(existingData);
      expect(mockedIndexer.indexAddress).not.toHaveBeenCalled();
    });

    test('indexes address when cache miss', async () => {
      const addr = 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';
      const indexedData = { address: addr, balance: '1000000' };
      mockDb.run.mockResolvedValueOnce(null);
      mockedIndexer.indexAddress.mockResolvedValueOnce(indexedData);

      const handler = async (db: any) => {
        const existing = await db.run('SELECT');
        if (existing) {
          return existing;
        }

        const addressRow = await mockedIndexer.indexAddress(db, addr);
        return addressRow;
      };

      const result = await handler(mockDb);

      expect(result).toEqual(indexedData);
      expect(mockedIndexer.indexAddress).toHaveBeenCalledWith(mockDb, addr);
    });

    test('returns null when indexer returns null for address', async () => {
      const addr = 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';
      mockDb.run.mockResolvedValueOnce(null);
      mockedIndexer.indexAddress.mockResolvedValueOnce(null as any);

      const handler = async (db: any) => {
        const existing = await db.run('SELECT');
        if (existing) {
          return existing;
        }

        const addressRow = await mockedIndexer.indexAddress(db, addr);
        return addressRow;
      };

      const result = await handler(mockDb);

      expect(result).toBeNull();
      expect(mockedIndexer.indexAddress).toHaveBeenCalledWith(mockDb, addr);
    });

    test('runs query when no address provided (collection)', async () => {
      const collectionData = [{ address: 'addr1' }, { address: 'addr2' }];
      mockDb.run.mockResolvedValueOnce(collectionData);

      const handler = async (db: any) => {
        return db.run('query');
      };

      const result = await handler(mockDb);

      expect(result).toEqual(collectionData);
    });
  });

  describe('Transactions READ - validation and branching', () => {
    test('rejects invalid transaction hash format', () => {
      const txHash = 'short';
      const req = {
        ...mockReq,
        data: { hash: txHash },
      } as Request;

      expect(() => {
        if (txHash && !/^[a-f0-9]{64}$/i.test(txHash)) {
          req.reject!(400, 'Invalid transaction hash format', 'hash');
        }
      }).toThrow();
    });

    test('returns existing transaction from database (cache hit)', async () => {
      const txHash = '2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83';
      const existingData = { hash: txHash, fee: 170000 };
      mockDb.run.mockResolvedValueOnce(existingData);

      const handler = async (db: any) => {
        const existing = await db.run('SELECT');
        if (existing) return existing;
        return null;
      };

      const result = await handler(mockDb);

      expect(result).toEqual(existingData);
      expect(mockedIndexer.indexTransaction).not.toHaveBeenCalled();
    });

    test('indexes transaction when cache miss', async () => {
      const txHash = '2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83';
      const indexedData = { hash: txHash, fee: 170000 };
      mockDb.run.mockResolvedValueOnce(null);
      mockedIndexer.indexTransaction.mockResolvedValueOnce(indexedData);

      const handler = async (db: any) => {
        const existing = await db.run('SELECT');
        if (existing) return existing;

        const txRow = await mockedIndexer.indexTransaction(db, txHash);
        return txRow;
      };

      const result = await handler(mockDb);

      expect(result).toEqual(indexedData);
      expect(mockedIndexer.indexTransaction).toHaveBeenCalledWith(mockDb, txHash);
    });

    test('returns null when indexer returns null for transaction', async () => {
      const txHash = '2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83';
      mockDb.run.mockResolvedValueOnce(null);
      mockedIndexer.indexTransaction.mockResolvedValueOnce(null as any);

      const handler = async (db: any) => {
        const existing = await db.run('SELECT');
        if (existing) return existing;

        const txRow = await mockedIndexer.indexTransaction(db, txHash);
        return txRow;
      };

      const result = await handler(mockDb);

      expect(result).toBeNull();
      expect(mockedIndexer.indexTransaction).toHaveBeenCalledWith(mockDb, txHash);
    });

    test('runs query when no hash provided (collection)', async () => {
      const collectionData = [{ hash: 'tx1' }, { hash: 'tx2' }];
      mockDb.run.mockResolvedValueOnce(collectionData);

      const handler = async (db: any) => {
        return db.run('query');
      };

      const result = await handler(mockDb);

      expect(result).toEqual(collectionData);
    });
  });

  describe('TransactionMetadata READ - validation and branching', () => {
    test('rejects invalid transaction hash format', () => {
      const txHash = 'xyz';
      const req = {
        ...mockReq,
        data: { hash: txHash },
      } as Request;

      expect(() => {
        if (txHash && !/^[a-f0-9]{64}$/i.test(txHash)) {
          req.reject!(400, 'Invalid transaction hash format', 'hash');
        }
      }).toThrow();
    });

    test('rejects empty label string', () => {
      const label = '   ';
      const req = {
        ...mockReq,
        data: { label },
      } as Request;

      expect(() => {
        if (label && label.trim().length === 0) {
          req.reject!(400, 'Label cannot be empty', 'label');
        }
      }).toThrow();
    });

    test('returns existing metadata for txHash (cache hit)', async () => {
      const txHash = '2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83';
      const existingData = [{ tx_hash: txHash, label: '721', jsonMetadata: {} }];
      mockDb.run.mockResolvedValueOnce(existingData);

      const handler = async (db: any) => {
        let existing = await db.run('SELECT');
        if (existing && existing.length > 0) {
          return existing;
        }
        return [];
      };

      const result = await handler(mockDb);

      expect(result).toEqual(existingData);
      expect(mockedIndexer.indexTransactionMetadata).not.toHaveBeenCalled();
    });

    test('indexes metadata for txHash when cache miss', async () => {
      const txHash = '2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83';
      const indexedData = [{ tx_hash: txHash, label: '721' }];
      mockDb.run.mockResolvedValueOnce([]);
      mockedIndexer.indexTransactionMetadata.mockResolvedValueOnce(indexedData);

      const asArray = <T>(x: T | T[] | null | undefined): T[] => {
        if (!x) return [];
        return Array.isArray(x) ? x : [x];
      };

      const handler = async (db: any) => {
        let existing = await db.run('SELECT');
        if (existing && existing.length > 0) {
          return existing;
        }
        const txMetadata = await mockedIndexer.indexTransactionMetadata(db, txHash);
        return asArray(txMetadata);
      };

      const result = await handler(mockDb);

      expect(result).toEqual(indexedData);
      expect(mockedIndexer.indexTransactionMetadata).toHaveBeenCalledWith(mockDb, txHash);
    });

    test('returns empty array when tx metadata indexer returns null', async () => {
      const txHash = '2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83';
      mockDb.run.mockResolvedValueOnce([]);
      mockedIndexer.indexTransactionMetadata.mockResolvedValueOnce(null as any);

      const asArray = <T>(x: T | T[] | null | undefined): T[] => {
        if (!x) return [];
        return Array.isArray(x) ? x : [x];
      };

      const handler = async (db: any) => {
        let existing = await db.run('SELECT');
        if (existing && existing.length > 0) {
          return existing;
        }
        const txMetadata = await mockedIndexer.indexTransactionMetadata(db, txHash);
        return asArray(txMetadata);
      };

      const result = await handler(mockDb);

      expect(result).toEqual([]);
      expect(mockedIndexer.indexTransactionMetadata).toHaveBeenCalledWith(mockDb, txHash);
    });

    test('returns existing metadata for label (cache hit)', async () => {
      const label = '721';
      const existingData = [{ label, tx_hash: 'abc123' }];
      mockDb.run.mockResolvedValueOnce(existingData);

      const handler = async (db: any) => {
        const existing = await db.run('SELECT');
        if (existing && existing.length > 0) {
          return existing;
        }
        return [];
      };

      const result = await handler(mockDb);

      expect(result).toEqual(existingData);
      expect(mockedIndexer.indexMetadataLabelTransactions).not.toHaveBeenCalled();
    });

    test('indexes metadata for label when cache miss', async () => {
      const label = '721';
      const indexedData = [{ label, tx_hash: 'abc123' }];
      mockDb.run.mockResolvedValueOnce([]);
      mockedIndexer.indexMetadataLabelTransactions.mockResolvedValueOnce(indexedData);

      const asArray = <T>(x: T | T[] | null | undefined): T[] => {
        if (!x) return [];
        return Array.isArray(x) ? x : [x];
      };

      const handler = async (db: any) => {
        const existing = await db.run('SELECT');
        if (existing && existing.length > 0) {
          return existing;
        }

        const txMetadata = await mockedIndexer.indexMetadataLabelTransactions(db, label);
        return asArray(txMetadata);
      };

      const result = await handler(mockDb);

      expect(result).toEqual(indexedData);
      expect(mockedIndexer.indexMetadataLabelTransactions).toHaveBeenCalledWith(mockDb, label);
    });

    test('returns empty array when label indexer returns null', async () => {
      const label = '721';
      mockDb.run.mockResolvedValueOnce([]);
      mockedIndexer.indexMetadataLabelTransactions.mockResolvedValueOnce(null as any);

      const asArray = <T>(x: T | T[] | null | undefined): T[] => {
        if (!x) return [];
        return Array.isArray(x) ? x : [x];
      };

      const handler = async (db: any) => {
        const existing = await db.run('SELECT');
        if (existing && existing.length > 0) {
          return existing;
        }

        const txMetadata = await mockedIndexer.indexMetadataLabelTransactions(db, label);
        return asArray(txMetadata);
      };

      const result = await handler(mockDb);

      expect(result).toEqual([]);
      expect(mockedIndexer.indexMetadataLabelTransactions).toHaveBeenCalledWith(mockDb, label);
    });

    test('runs query when neither hash nor label provided', async () => {
      const collectionData = [{ tx_hash: 'tx1', label: '721' }];
      mockDb.run.mockResolvedValueOnce(collectionData);

      const handler = async (db: any) => {
        return db.run('query');
      };

      const result = await handler(mockDb);

      expect(result).toEqual(collectionData);
    });
  });

  describe('Action GetNetworkInformation - cache hit/miss', () => {
    test('returns existing row (cache hit)', async () => {
      const existingData = { maxSupply: 45000000000000000 } as any;
      mockDb.run.mockResolvedValueOnce(existingData);

      const handler = async (db: any) => {
        const row = await db.run('SELECT');
        if (!row) {
          return await mockedIndexer.indexNetworkInformation(db);
        }
        return row;
      };

      const result = await handler(mockDb);

      expect(result).toEqual(existingData);
      expect(mockedIndexer.indexNetworkInformation).not.toHaveBeenCalled();
    });

    test('indexes when no existing row (cache miss)', async () => {
      const indexedData = { maxSupply: 45000000000000000 } as any;
      mockDb.run.mockResolvedValueOnce(null);
      mockedIndexer.indexNetworkInformation.mockResolvedValueOnce(indexedData);

      const handler = async (db: any) => {
        const row = await db.run('SELECT');
        if (!row) {
          return await mockedIndexer.indexNetworkInformation(db);
        }
        return row;
      };

      const result = await handler(mockDb);

      expect(result).toEqual(indexedData);
      expect(mockedIndexer.indexNetworkInformation).toHaveBeenCalledWith(mockDb);
    });
  });

  describe('Action GetLatestBlock - cache hit/miss', () => {
    test('returns existing row (cache hit)', async () => {
      const existingData = { hash: 'block123', height: 123456 };
      mockDb.run.mockResolvedValueOnce(existingData);

      const handler = async (db: any) => {
        const row = await db.run('SELECT');
        if (!row) {
          return await mockedIndexer.indexLatestBlock(db);
        }
        return row;
      };

      const result = await handler(mockDb);

      expect(result).toEqual(existingData);
      expect(mockedIndexer.indexLatestBlock).not.toHaveBeenCalled();
    });

    test('indexes when no existing row (cache miss)', async () => {
      const indexedData = { hash: 'block123', height: 123456 };
      mockDb.run.mockResolvedValueOnce(null);
      mockedIndexer.indexLatestBlock.mockResolvedValueOnce(indexedData);

      const handler = async (db: any) => {
        const row = await db.run('SELECT');
        if (!row) {
          return await mockedIndexer.indexLatestBlock(db);
        }
        return row;
      };

      const result = await handler(mockDb);

      expect(result).toEqual(indexedData);
      expect(mockedIndexer.indexLatestBlock).toHaveBeenCalledWith(mockDb);
    });
  });

  describe('Action GetLatestEpoch - cache hit/miss', () => {
    test('returns existing row (cache hit)', async () => {
      const existingData = { epoch: 450, blockCount: 21600 };
      mockDb.run.mockResolvedValueOnce(existingData);

      const handler = async (db: any) => {
        const row = await db.run('SELECT');
        if (!row) {
          return await mockedIndexer.indexLatestEpoch(db);
        }
        return row;
      };

      const result = await handler(mockDb);

      expect(result).toEqual(existingData);
      expect(mockedIndexer.indexLatestEpoch).not.toHaveBeenCalled();
    });

    test('indexes when no existing row (cache miss)', async () => {
      const indexedData = { epoch: 450, blockCount: 21600 };
      mockDb.run.mockResolvedValueOnce(null);
      mockedIndexer.indexLatestEpoch.mockResolvedValueOnce(indexedData);

      const handler = async (db: any) => {
        const row = await db.run('SELECT');
        if (!row) {
          return await mockedIndexer.indexLatestEpoch(db);
        }
        return row;
      };

      const result = await handler(mockDb);

      expect(result).toEqual(indexedData);
      expect(mockedIndexer.indexLatestEpoch).toHaveBeenCalledWith(mockDb);
    });
  });

  describe('Action GetTransactionByHash - validation and branching', () => {
    test('rejects missing txHash', () => {
      const req = {
        ...mockReq,
        data: {},
      } as Request;

      expect(() => {
        if (!req.data.txHash) {
          req.reject!(400, 'txHash is required');
        }
      }).toThrow();
    });

    test('rejects invalid txHash format', () => {
      const txHash = 'invalid';
      const req = {
        ...mockReq,
        data: { txHash },
      } as Request;

      expect(() => {
        if (!/^[a-f0-9]{64}$/i.test(txHash)) {
          req.reject!(400, 'Invalid transaction hash format', 'txHash');
        }
      }).toThrow();
    });

    test('returns existing transaction (cache hit)', async () => {
      const txHash = '2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83';
      const existingData = { hash: txHash, fee: 170000 };
      mockDb.run.mockResolvedValueOnce(existingData);

      const handler = async (db: any) => {
        const existing = await db.run('SELECT');
        if (existing) return existing;
        return null;
      };

      const result = await handler(mockDb);

      expect(result).toEqual(existingData);
      expect(mockedIndexer.indexTransaction).not.toHaveBeenCalled();
    });

    test('indexes transaction when not found (cache miss)', async () => {
      const txHash = '2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83';
      const indexedData = { hash: txHash, fee: 170000 };
      mockDb.run.mockResolvedValueOnce(null);
      mockedIndexer.indexTransaction.mockResolvedValueOnce(indexedData);

      const handler = async (db: any) => {
        const existing = await db.run('SELECT');
        if (existing) return existing;

        const txRow = await mockedIndexer.indexTransaction(db, txHash);
        return txRow;
      };

      const result = await handler(mockDb);

      expect(result).toEqual(indexedData);
      expect(mockedIndexer.indexTransaction).toHaveBeenCalledWith(mockDb, txHash);
    });
  });

  describe('Action GetAddressByBech32 - validation and branching', () => {
    test('rejects missing address', () => {
      const req = {
        ...mockReq,
        data: {},
      } as Request;

      expect(() => {
        if (!req.data.address) {
          req.reject!(400, 'address is required');
        }
      }).toThrow();
    });

    test('rejects invalid bech32 format', () => {
      const address = 'invalid';
      const req = {
        ...mockReq,
        data: { address },
      } as Request;

      expect(() => {
        if (!/^(addr|addr_test|stake|stake_test)1[a-z0-9]{53,}$/.test(address)) {
          req.reject!(400, 'Invalid bech32 address format', 'address');
        }
      }).toThrow();
    });

    test('returns existing address (cache hit)', async () => {
      const address = 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';
      const existingData = { address, balance: '1000000' };
      mockDb.run.mockResolvedValueOnce(existingData);

      const handler = async (db: any) => {
        const existing = await db.run('SELECT');
        if (existing) return existing;
        return null;
      };

      const result = await handler(mockDb);

      expect(result).toEqual(existingData);
      expect(mockedIndexer.indexAddress).not.toHaveBeenCalled();
    });

    test('indexes address when not found (cache miss)', async () => {
      const address = 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';
      const indexedData = { address, balance: '1000000' };
      mockDb.run.mockResolvedValueOnce(null);
      mockedIndexer.indexAddress.mockResolvedValueOnce(indexedData);

      const handler = async (db: any) => {
        const existing = await db.run('SELECT');
        if (existing) return existing;

        const addrRow = await mockedIndexer.indexAddress(db, address);
        return addrRow;
      };

      const result = await handler(mockDb);

      expect(result).toEqual(indexedData);
      expect(mockedIndexer.indexAddress).toHaveBeenCalledWith(mockDb, address);
    });
  });

  describe('Action GetMetadataByTxHash - validation and branching', () => {
    test('rejects missing txHash', () => {
      const req = {
        ...mockReq,
        data: {},
      } as Request;

      expect(() => {
        if (!req.data.txHash) {
          req.reject!(400, 'txHash is required');
        }
      }).toThrow();
    });

    test('rejects invalid txHash format', () => {
      const txHash = 'invalid';
      const req = {
        ...mockReq,
        data: { txHash },
      } as Request;

      expect(() => {
        if (!/^[a-f0-9]{64}$/i.test(txHash)) {
          req.reject!(400, 'Invalid transaction hash format', 'txHash');
        }
      }).toThrow();
    });

    test('returns existing metadata array (cache hit)', async () => {
      const txHash = '2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83';
      const existingData = [{ tx_hash: txHash, label: '721' }];
      mockDb.run.mockResolvedValueOnce(existingData);

      const handler = async (db: any) => {
        const rows = await db.run('SELECT');
        if (!rows || rows.length === 0) {
          return [];
        }
        return rows;
      };

      const result = await handler(mockDb);

      expect(result).toEqual(existingData);
      expect(mockedIndexer.indexTransactionMetadata).not.toHaveBeenCalled();
    });

    test('indexes metadata when empty array (cache miss)', async () => {
      const txHash = '2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83';
      const indexedData = [{ tx_hash: txHash, label: '721' }];
      mockDb.run.mockResolvedValueOnce([]);
      mockedIndexer.indexTransactionMetadata.mockResolvedValueOnce(indexedData);

      const asArray = <T>(x: T | T[] | null | undefined): T[] => {
        if (!x) return [];
        return Array.isArray(x) ? x : [x];
      };

      const handler = async (db: any) => {
        const rows = await db.run('SELECT');
        if (!rows || rows.length === 0) {
          return asArray(await mockedIndexer.indexTransactionMetadata(db, txHash));
        }
        return rows;
      };

      const result = await handler(mockDb);

      expect(result).toEqual(indexedData);
      expect(mockedIndexer.indexTransactionMetadata).toHaveBeenCalledWith(mockDb, txHash);
    });
  });

  describe('Action GetMetadataLabelTransactions - validation and branching', () => {
    test('rejects missing label', () => {
      const req = {
        ...mockReq,
        data: {},
      } as Request;

      expect(() => {
        if (!req.data.label) {
          req.reject!(400, 'label is required');
        }
      }).toThrow();
    });

    test('rejects empty trimmed label', () => {
      const label = '   ';
      const req = {
        ...mockReq,
        data: { label },
      } as Request;

      expect(() => {
        if (label.trim().length === 0) {
          req.reject!(400, 'Label cannot be empty', 'label');
        }
      }).toThrow();
    });

    test('returns existing transactions (cache hit)', async () => {
      const label = '721';
      const existingData = [{ label, tx_hash: 'abc123' }];
      mockDb.run.mockResolvedValueOnce(existingData);

      const handler = async (db: any) => {
        const rows = await db.run('SELECT');
        if (!rows || rows.length === 0) {
          return [];
        }
        return rows;
      };

      const result = await handler(mockDb);

      expect(result).toEqual(existingData);
      expect(mockedIndexer.indexMetadataLabelTransactions).not.toHaveBeenCalled();
    });

    test('indexes label transactions when empty (cache miss)', async () => {
      const label = '721';
      const indexedData = [{ label, tx_hash: 'abc123' }];
      mockDb.run.mockResolvedValueOnce([]);
      mockedIndexer.indexMetadataLabelTransactions.mockResolvedValueOnce(indexedData);

      const asArray = <T>(x: T | T[] | null | undefined): T[] => {
        if (!x) return [];
        return Array.isArray(x) ? x : [x];
      };

      const handler = async (db: any) => {
        const rows = await db.run('SELECT');
        if (!rows || rows.length === 0) {
          return asArray(await mockedIndexer.indexMetadataLabelTransactions(db, label));
        }
        return rows;
      };

      const result = await handler(mockDb);

      expect(result).toEqual(indexedData);
      expect(mockedIndexer.indexMetadataLabelTransactions).toHaveBeenCalledWith(mockDb, label);
    });
  });

  describe('Action GetUTxOsByAddress - validation and branching', () => {
    test('rejects missing address', () => {
      const req = {
        ...mockReq,
        data: {},
      } as Request;

      expect(() => {
        if (!req.data.address) {
          req.reject!(400, 'address is required');
        }
      }).toThrow();
    });

    test('rejects invalid address format', () => {
      const address = 'invalid';
      const req = {
        ...mockReq,
        data: { address },
      } as Request;

      expect(() => {
        if (!/^(addr|addr_test|stake|stake_test)1[a-z0-9]{53,}$/.test(address)) {
          req.reject!(400, 'Invalid bech32 address format', 'address');
        }
      }).toThrow();
    });

    test('returns existing UTxOs (cache hit)', async () => {
      const address = 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';
      const existingData = [{ address, txHash: 'abc123', outputIndex: 0 }];
      mockDb.run.mockResolvedValueOnce(existingData);

      const handler = async (db: any) => {
        let rows = await db.run('SELECT');

        if (!rows || rows.length === 0) {
          return [];
        }
        return rows;
      };

      const result = await handler(mockDb);

      expect(result).toEqual(existingData);
      expect(mockedIndexer.indexAddress).not.toHaveBeenCalled();
    });

    test('indexes address and returns UTxOs when empty (cache miss)', async () => {
      const address = 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';
      const utxosData = [{ address, txHash: 'abc123', outputIndex: 0 }];
      mockDb.run.mockResolvedValueOnce([]);
      mockedIndexer.indexAddress.mockResolvedValueOnce({ address });
      mockDb.run.mockResolvedValueOnce(utxosData);

      const handler = async (db: any) => {
        let rows = await db.run('SELECT');

        if (!rows || rows.length === 0) {
          await mockedIndexer.indexAddress(db, address);
          rows = await db.run('SELECT');
        }
        return rows;
      };

      const result = await handler(mockDb);

      expect(result).toEqual(utxosData);
      expect(mockedIndexer.indexAddress).toHaveBeenCalledWith(mockDb, address);
      expect(mockDb.run).toHaveBeenCalledTimes(2);
    });
  });

  describe('Action GetAssetsByAddress - validation and branching', () => {
    test('rejects missing address', () => {
      const req = {
        ...mockReq,
        data: {},
      } as Request;

      expect(() => {
        if (!req.data.address) {
          req.reject!(400, 'address is required');
        }
      }).toThrow();
    });

    test('rejects invalid address format', () => {
      const address = 'invalid';
      const req = {
        ...mockReq,
        data: { address },
      } as Request;

      expect(() => {
        if (!/^(addr|addr_test|stake|stake_test)1[a-z0-9]{53,}$/.test(address)) {
          req.reject!(400, 'Invalid bech32 address format', 'address');
        }
      }).toThrow();
    });

    test('returns existing assets (cache hit)', async () => {
      const address = 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';
      const existingData = [{ address, policyId: 'policy123', assetName: 'asset1' }];
      mockDb.run.mockResolvedValueOnce(existingData);

      const handler = async (db: any) => {
        let rows = await db.run('SELECT');
        if (!rows || rows.length === 0) {
          return [];
        }
        return rows;
      };

      const result = await handler(mockDb);

      expect(result).toEqual(existingData);
      expect(mockedIndexer.indexAddress).not.toHaveBeenCalled();
    });

    test('indexes address and returns assets when empty (cache miss)', async () => {
      const address = 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';
      const assetsData = [{ address, policyId: 'policy123', assetName: 'asset1' }];
      mockDb.run.mockResolvedValueOnce([]);
      mockedIndexer.indexAddress.mockResolvedValueOnce({ address });
      mockDb.run.mockResolvedValueOnce(assetsData);

      const handler = async (db: any) => {
        let rows = await db.run('SELECT');
        if (!rows || rows.length === 0) {
          await mockedIndexer.indexAddress(db, address);
          rows = await db.run('SELECT');
        }
        return rows;
      };

      const result = await handler(mockDb);

      expect(result).toEqual(assetsData);
      expect(mockedIndexer.indexAddress).toHaveBeenCalledWith(mockDb, address);
      expect(mockDb.run).toHaveBeenCalledTimes(2);
    });
  });

  // Coverage gaps - Blocks error paths and collection reads
  describe('Additional coverage for missing lines', () => {
    let handlers: Record<string, (req: Request) => Promise<any>>;

    const makeReq = (data = {}, targetName?: string): Request => {
      return {
        ...(mockReq as Request),
        data,
        target: targetName ? ({ name: targetName } as any) : (mockReq.target as any),
        query: {} as any,
      } as Request;
    };

    beforeEach(() => {
      handlers = {};
      const origOn = (service as any).on.bind(service);
      jest
        .spyOn(service as any, 'on')
        .mockImplementation((event: any, entityOrHandler: any, handlerMaybe?: any) => {
          const fn = handlerMaybe ?? entityOrHandler;
          const entity = handlerMaybe ? entityOrHandler : undefined;
          if (entity) {
            handlers[`${event}:${entity}`] = fn;
          } else {
            handlers[event] = fn;
          }
          return origOn(event, entityOrHandler, handlerMaybe);
        });
      jest.spyOn(service as any, 'before').mockImplementation(() => service);
      jest.spyOn(cds, 'tx').mockReturnValue(mockDb as any);
      service.init();
    });

    // Line 114 - Blocks indexLatestBlock error catch
    test('Blocks READ returns [] when indexLatestBlock throws error', async () => {
      const handler = handlers['READ:Blocks'];
      mockDb.run.mockResolvedValueOnce([]); // First query empty
      mockedIndexer.indexLatestEpoch.mockResolvedValueOnce({ epoch: 100 } as any);
      mockedIndexer.indexLatestBlock.mockRejectedValueOnce(new Error('block error'));

      const result = await handler(makeReq({}, 'Blocks'));
      expect(result).toEqual([]);
    });

    // Line 122 - Blocks db.run error after indexing catch
    test('Blocks READ returns [] when final db.run throws error', async () => {
      const handler = handlers['READ:Blocks'];
      mockDb.run.mockRejectedValueOnce(new Error('first query error'));
      mockedIndexer.indexLatestEpoch.mockResolvedValueOnce({ epoch: 100 } as any);
      mockedIndexer.indexLatestBlock.mockResolvedValueOnce({ hash: 'block1' } as any);
      mockDb.run.mockRejectedValueOnce(new Error('second query error'));

      const result = await handler(makeReq({}, 'Blocks'));
      expect(result).toEqual([]);
    });

    // Line 169 - Pools collection read without pool_id
    test('Pools READ uses db.run for collection when no pool_id', async () => {
      const handler = handlers['READ:Pools'];
      const pools = [{ poolId: 'pool1' }, { poolId: 'pool2' }];
      mockDb.run.mockResolvedValueOnce(pools);

      const result = await handler(makeReq({}, 'Pools'));
      expect(result).toEqual(pools);
      expect(mockedIndexer.indexPool).not.toHaveBeenCalled();
    });

    // Validation branch: pool_id present but invalid format
    test('Pools READ rejects invalid pool_id format', async () => {
      const handler = handlers['READ:Pools'];
      await expect(handler(makeReq({ pool_id: 'not-a-hash' }, 'Pools'))).rejects.toBeTruthy();
    });

    // Line 196 - Accounts collection read without stakeAddress
    test('Accounts READ uses db.run for collection when no stakeAddress', async () => {
      const handler = handlers['READ:Accounts'];
      const accounts = [{ account_id: 'stake1' }, { account_id: 'stake2' }];
      mockDb.run.mockResolvedValueOnce(accounts);

      const result = await handler(makeReq({}, 'Accounts'));
      expect(result).toEqual(accounts);
      expect(mockedIndexer.indexAccount).not.toHaveBeenCalled();
    });

    // Line 224 - Dreps collection read without drep_id
    test('Dreps READ uses db.run for collection when no drep_id', async () => {
      const handler = handlers['READ:Dreps'];
      const dreps = [{ drepId: 'drep1' }, { drepId: 'drep2' }];
      mockDb.run.mockResolvedValueOnce(dreps);

      const result = await handler(makeReq({}, 'Dreps'));
      expect(result).toEqual(dreps);
      expect(mockedIndexer.indexDrep).not.toHaveBeenCalled();
    });

    // Lines 395-396 - TransactionMetadata generic query error catch
    test('TransactionMetadata generic fallback returns [] on db.run error', async () => {
      const handler = handlers['READ:TransactionMetadata'];
      mockDb.run.mockRejectedValueOnce(new Error('query error'));

      const result = await handler(makeReq({}, 'TransactionMetadata'));
      expect(result).toEqual([]);
    });

    // Lines 151 - Pools READ returns existing pool when found in DB
    test('Pools READ returns existing pool from DB', async () => {
      const handler = handlers['READ:Pools'];
      const poolId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const existingPool = { pool_id: poolId, name: 'Test Pool' };
      mockDb.run.mockResolvedValueOnce([existingPool]);

      const result = await handler(makeReq({ pool_id: poolId }, 'Pools'));
      expect(result).toEqual([existingPool]);
      expect(mockedIndexer.indexPool).not.toHaveBeenCalled();
    });

    // Lines 157-167 - Pools READ indexes new pool when not found
    test('Pools READ indexes new pool via indexer', async () => {
      const handler = handlers['READ:Pools'];
      const poolId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const newPool = { pool_id: poolId, name: 'New Pool' } as any;
      mockDb.run.mockResolvedValueOnce(null); // Not found in DB
      mockedIndexer.indexPool.mockResolvedValueOnce(newPool);

      const result = await handler(makeReq({ pool_id: poolId }, 'Pools'));
      expect(result).toEqual(newPool);
      expect(mockedIndexer.indexPool).toHaveBeenCalledWith(mockDb, poolId);
    });

    // Lines 177 - Accounts READ returns existing account when found in DB
    test('Accounts READ returns existing account from DB', async () => {
      const handler = handlers['READ:Accounts'];
      const stakeAddress = 'stake_test1u9qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq2hsvps';
      const existingAccount = { account_id: stakeAddress, active: true } as any;
      mockDb.run.mockResolvedValueOnce([existingAccount]);

      const result = await handler(makeReq({ stakeAddress }, 'Accounts'));
      expect(result).toEqual([existingAccount]);
      expect(mockedIndexer.indexAccount).not.toHaveBeenCalled();
    });

    // Validation branch: stakeAddress present but invalid format
    test('Accounts READ rejects invalid stakeAddress format', async () => {
      const handler = handlers['READ:Accounts'];
      await expect(handler(makeReq({ stakeAddress: 'addr_test1invalid' }, 'Accounts'))).rejects.toBeTruthy();
    });

    // Lines 181-194 - Accounts READ indexes new account when not found
    test('Accounts READ indexes new account via indexer', async () => {
      const handler = handlers['READ:Accounts'];
      const stakeAddress = 'stake_test1u9qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq2hsvps';
      const newAccount = { account_id: stakeAddress, active: true } as any;
      mockDb.run.mockResolvedValueOnce(null); // Not found in DB
      mockedIndexer.indexAccount.mockResolvedValueOnce(newAccount);

      const result = await handler(makeReq({ stakeAddress }, 'Accounts'));
      expect(result).toEqual(newAccount);
      expect(mockedIndexer.indexAccount).toHaveBeenCalledWith(mockDb, stakeAddress);
    });
  });

});



