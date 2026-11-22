/**
 * Int64 and Decimal leave a service as text, whether the row was read from the database or built by
 * a handler. The cases run the real service models; the handlers stand in for the real ones.
 */

import cds from '@sap/cds';
import fs from 'fs';
import path from 'path';
import { answerNumbersAsText, numbersAsText } from '../../srv/utils/result-numbers';

const SRV = path.resolve(__dirname, '../../srv');
const SERVICE_FILES = fs.readdirSync(SRV).filter(f => f.endsWith('-service.cds')).map(f => f.replace(/\.cds$/, ''));

type Definitions = Record<string, { returns: never; elements: never }>;
let definitions: Definitions;
const services = new Map<string, cds.Service>();

beforeAll(async () => {
  const csn = await cds.load(SERVICE_FILES.map(f => path.join(SRV, `${f}.cds`)));
  const model = cds.linked(cds.compile.for.nodejs(csn as never) as never);
  definitions = model.definitions as unknown as Definitions;
  for (const name of ['CardanoODataService', 'CardanoIndexerService']) {
    const srv = new cds.ApplicationService(name, model as never);
    await srv.init();
    answerNumbersAsText(srv);
    services.set(name, srv);
  }
});

const returnsOf = (operation: string) => definitions[operation].returns;

describe('numbersAsText', () => {
  it('renders an Int64 number as text and leaves an Integer alone', () => {
    const block = { hash: 'ab', height: 4881918, slot: 128679788, size: 637 };
    expect(numbersAsText(returnsOf('CardanoODataService.GetBlockByHash'), block))
      .toEqual({ hash: 'ab', height: 4881918, slot: '128679788', size: 637 });
  });

  it('renders a Decimal with the digits of its scale', () => {
    const pool = { poolId: 'pool1', liveSaturation: 0.75, margin: 0.05, pledge: 5000000, liveStake: 12n };
    expect(numbersAsText(returnsOf('CardanoODataService.GetPoolById'), pool))
      .toEqual({ poolId: 'pool1', liveSaturation: '0.7500', margin: '0.0500', pledge: '5000000', liveStake: '12' });
    expect(numbersAsText(definitions['CardanoODataService.LedgerProtocolParameters'], { priceStep: 0.0000721, minFeeA: 44 }))
      .toEqual({ priceStep: '0.0000721000', minFeeA: 44 });
  });

  it('keeps text, null and unknown keys as they are', () => {
    const block = { hash: 'ab', slot: '128679788', epoch_epoch: null, '@odata.context': 'x', extra: 5 };
    expect(numbersAsText(returnsOf('CardanoODataService.GetBlockByHash'), block)).toBe(block);
  });

  it('walks rows, nested structures and keeps $count', () => {
    const rows = Object.assign([{ hash: 'a', index: 0, lovelace: 2000000 }, { hash: 'b', index: 1, lovelace: '3' }], { $count: 2 });
    const text = numbersAsText(returnsOf('CardanoODataService.GetUTxOsByAddress'), rows) as typeof rows;
    expect(text).toEqual(Object.assign([{ hash: 'a', index: 0, lovelace: '2000000' }, { hash: 'b', index: 1, lovelace: '3' }], { $count: 2 }));
    expect(text.$count).toBe(2);
    expect(text[1]).toBe(rows[1]);

    const status = { running: true, copyPrune: { status: 'running', referenced: 7, kept: 1, deleted: 0 } };
    expect(numbersAsText(returnsOf('CardanoIndexerService.getStatus'), status))
      .toEqual({ running: true, copyPrune: { status: 'running', referenced: '7', kept: '1', deleted: '0' } });
  });

  it('never changes the value it was given', () => {
    const progress = { status: 'running', referenced: 7, kept: 1, deleted: 0 };
    const status = { running: true, copyPrune: progress };
    numbersAsText(returnsOf('CardanoIndexerService.getStatus'), status);
    progress.referenced += 1;
    expect(progress.referenced).toBe(8);
    expect(status.copyPrune).toBe(progress);
  });
});

describe('answerNumbersAsText: through the service', () => {
  it('an operation answers a row its handler built with Int64 as text', async () => {
    const srv = services.get('CardanoODataService')!;
    srv.on('GetBlockByHash', () => ({ hash: 'ab', height: 5, slot: 128679788 }));
    expect(await srv.send('GetBlockByHash', { hash: 'a'.repeat(64) })).toEqual({ hash: 'ab', height: 5, slot: '128679788' });
  });

  it('a list operation answers every row the same way', async () => {
    const srv = services.get('CardanoODataService')!;
    srv.on('GetAssetHistory', () => [{ txHash: 'a', blockTime: 1795335788 }, { txHash: 'b', blockTime: '1795335789' }]);
    expect(await srv.send('GetAssetHistory', { unit: 'a'.repeat(56) }))
      .toEqual([{ txHash: 'a', blockTime: '1795335788' }, { txHash: 'b', blockTime: '1795335789' }]);
  });

  it('an entity read answers a row its handler built with Decimal as text', async () => {
    const srv = services.get('CardanoODataService')!;
    // ahead of CAP's own read handler, which needs a database
    srv.prepend(() => srv.on('READ', 'LedgerProtocolParameters', () => ({ network: 'preview', epoch: 1489, a0: 0.3, minFeeA: 44 })));
    expect(await srv.read('LedgerProtocolParameters'))
      .toEqual({ network: 'preview', epoch: 1489, a0: '0.3000000000', minFeeA: 44 });
  });

  it('a status counter another task keeps counting in stays a number there', async () => {
    const srv = services.get('CardanoIndexerService')!;
    const progress = { status: 'running', referenced: 7, kept: 1, deleted: 0 };
    srv.on('getStatus', () => ({ running: true, copyPrune: progress }));
    const answer = await srv.send('getStatus') as { copyPrune: Record<string, unknown> };
    expect(answer.copyPrune).toEqual({ status: 'running', referenced: '7', kept: '1', deleted: '0' });
    expect(progress.referenced).toBe(7);
  });
});

describe('every service implementation', () => {
  it.each(SERVICE_FILES)('%s renders its numbers as text', (file) => {
    const source = fs.readFileSync(path.join(SRV, `${file}.ts`), 'utf8');
    expect(source).toMatch(/module\.exports = \(srv: cds\.Service\) => \{\r?\n {2}answerNumbersAsText\(srv\);/);
  });
});
