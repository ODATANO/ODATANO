/**
 * Read guard: reads on the large tables pass only when an index answers them. The queries are
 * parsed from OData URLs, so the CQN has the shape the adapter hands the service.
 */
import cds from '@sap/cds';
import path from 'node:path';
import { GUARDED_ENTITIES, guardLargeReads, indexColumnLists, keyColumns, unindexedReason } from '../../srv/utils/read-guard';
import { ERROR_CODES } from '../../srv/utils/error-codes';

type Def = Parameters<typeof keyColumns>[0];
// cds.odata is not in the published typings; the parser turns an OData URL into the adapter's CQN
const odata = (cds as unknown as { odata: { parse: (url: string) => unknown } }).odata;
const defOf = (name: string) => (cds.model as unknown as { definitions: Record<string, Def> }).definitions[`odatano.cardano.${name}`];

const reasonFor = (url: string): string | null => {
  const query = odata.parse(url) as { SELECT: Parameters<typeof unindexedReason>[1] & { from: { ref: Array<{ id?: string } | string> } } };
  const head = query.SELECT.from.ref[0];
  const name = typeof head === 'string' ? head : String(head.id);
  return unindexedReason(name, query.SELECT, defOf(name));
};

beforeAll(async () => {
  (cds as unknown as { model: unknown }).model = cds.linked(cds.compile.for.nodejs(await cds.load(path.join(__dirname, '..', '..', 'srv'))) as never);
});

describe('index columns', () => {
  it('expands association keys to their foreign keys in table order', () => {
    expect(keyColumns(defOf('TransactionMetadata'))).toEqual(['id', 'tx_hash']);
    expect(keyColumns(defOf('LedgerUTxOAssets'))).toEqual(['utxo_txHash', 'utxo_outputIndex', 'unit']);
    expect(keyColumns(defOf('Assets'))).toEqual(['validFrom', 'unit']);
    expect(keyColumns(defOf('TransactionInputAssets'))).toEqual(['input_txSeq', 'input_inputIndex', 'unit']);
  });

  it('reads the secondary indexes without their sort direction', () => {
    expect(indexColumnLists('AssetHistory', defOf('AssetHistory'))).toContainEqual(['unit', 'blockheight']);
  });

  it('knows every guarded entity in the model', () => {
    for (const name of GUARDED_ENTITIES) expect(keyColumns(defOf(name)).length).toBeGreaterThan(0);
  });
});

describe('reads that pass', () => {
  it.each([
    '/PoolEpochSnapshots?$filter=poolId eq \'pool1x\'&$orderby=epoch desc',
    '/DrepEpochSnapshots?$filter=drepId eq \'drep1x\'&$orderby=epoch desc',
    '/EpochLedgerSnapshots?$filter=epoch eq 316',
    '/AccountEpochSnapshots?$top=1',
    '/TransactionCertificates?$filter=poolId eq \'pool1x\'',
    '/TransactionWithdrawals?$filter=tx_hash eq \'ab\'',
    '/TransactionRedeemers?$filter=tx_hash eq \'ab\'',
    '/TransactionDatums?$top=1',
    '/LedgerUTxOs?$filter=address eq \'addr_test1x\' and spentTxHash eq null',
    '/LedgerAddressAssets?$filter=unit eq \'ab\'',
    '/Transactions(\'ab\')?$expand=inputs,outputs,metadata',
    '/Blocks(\'ab\')',
    '/Transactions(\'ab\')/outputs',
    '/Blocks?$orderby=height desc&$top=1',
    '/Blocks?$filter=time ge 2025-01-01T00:00:00Z&$orderby=time&$top=1',
    '/Blocks?$filter=slot ge 100&$orderby=slot&$top=1',
    '/TransactionMetadata?$filter=id eq 674&$orderby=txSeq',
    '/AssetHistory?$filter=unit eq \'ab\'&$orderby=blockTime desc',
    '/Transactions?$filter=blockHash eq \'ab\'&$count=true',
    '/TransactionOutputAssets?$filter=output_txSeq eq 5',
    '/Blocks/$count?$filter=slot ge 0',
    '/PoolEpochSnapshots?$filter=epoch eq 316&$orderby=liveStake desc&$count=true',
    '/AccountEpochSnapshots?$filter=stakeAddress eq \'stake_test1x\'&$orderby=epoch desc',
    '/LedgerAccounts(\'stake_test1x\')',
  ])('%s', (url) => {
    expect(reasonFor(url)).toBeNull();
  });
});

describe('reads that would scan the table', () => {
  it.each([
    ['/TransactionMetadata?$filter=label eq \'674\'', 'label is not indexed'],
    ['/TransactionOutputAssets?$filter=unit eq \'ab\'', 'unit is not indexed'],
    ['/TransactionOutputAssets?$filter=output_outputIndex eq 0', 'output_outputindex is not indexed'],
    ['/Transactions?$count=true', '$count needs a $filter'],
    ['/Transactions/$count', '$count needs a $filter'],
    ['/Transactions?$filter=fees gt 0', 'fees is not indexed'],
    ['/Transactions?$orderby=fees desc&$top=10', '$orderby on fees'],
    ['/Blocks?$filter=height gt 100&$orderby=size', '$orderby on size'],
    ['/Blocks?$filter=contains(hash,\'ab\')', 'function contains'],
    ['/Transactions?$search=abc', '$search'],
    ['/TransactionOutputs/$count?$filter=txSeq gt 0', '$count needs an eq $filter'],
    ['/Transactions?$filter=blockHash ne \'ab\'&$count=true', '$count needs an eq $filter'],
    ['/AccountEpochSnapshots/$count', '$count needs a $filter'],
    ['/AccountEpochSnapshots?$filter=epoch ge 500&$count=true', '$count needs an eq $filter'],
    ['/LedgerAccounts?$orderby=controlledAmount desc&$top=10', '$orderby on controlledamount'],
    ['/PoolEpochSnapshots?$apply=aggregate(liveStake with sum as total)', '$apply'],
    ['/TransactionOutputs?$apply=aggregate(lovelace with sum as total)', '$apply'],
  ])('%s', (url, reason) => {
    expect(reasonFor(url)).toContain(reason);
  });
});

describe('guardLargeReads', () => {
  type Handler = (req: unknown) => void;
  const register = () => {
    const before: Handler[] = [];
    const srv = { prepend: (fn: () => void) => fn(), before: (_e: string, h: Handler) => before.push(h) };
    guardLargeReads(srv as never);
    return before[0];
  };
  const reqFor = (url: string, target: string, http: unknown = {}) => ({ query: odata.parse(url), target: { name: `CardanoODataService.${target}` }, context: { http } });

  it('refuses with 400 ODATANO_QUERY_NOT_INDEXED and names the indexed fields', () => {
    const guard = register();
    try {
      guard(reqFor('/TransactionMetadata?$filter=label eq \'674\'', 'TransactionMetadata'));
      throw new Error('no refusal');
    } catch (err) {
      expect(err).toMatchObject({ statusCode: 400, code: ERROR_CODES.QUERY_NOT_INDEXED });
      expect((err as Error).message).toContain('indexed: id, tx_hash');
    }
  });

  it('passes an indexed read and an unguarded entity', () => {
    const guard = register();
    expect(() => guard(reqFor('/TransactionMetadata?$filter=id eq 674', 'TransactionMetadata'))).not.toThrow();
    expect(() => guard(reqFor('/Pools?$count=true', 'Pools'))).not.toThrow();
  });

  it('leaves in-process reads without an HTTP request alone', () => {
    const guard = register();
    expect(() => guard(reqFor('/Transactions?$count=true', 'Transactions', null))).not.toThrow();
  });
});
