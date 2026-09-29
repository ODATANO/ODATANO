/**
 * Bulk rows on PostgreSQL (srv/utils/pg-inline-json.ts): rendered through the real
 * @cap-js/postgres renderer, so a driver that changes how it ships `.entries()` fails here.
 */
import cds from '@sap/cds';
import { Readable } from 'stream';
import { installPostgresInlineJson, isInlineRowStream } from '../../srv/utils/pg-inline-json';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PostgresService = require('@cap-js/postgres/lib/PostgresService');

function service() {
  const csn = cds.compile.to.csn(`namespace t; entity Rows { key ID: Integer; note: String; }`);
  cds.model = cds.linked(csn);
  return new PostgresService('db', cds.model, { kind: 'postgres', credentials: {} });
}

describe('installPostgresInlineJson', () => {
  it('sends an UPSERT row list as one JSON text parameter, without the COPY buffer; installs once', async () => {
    expect(installPostgresInlineJson()).toBe(true);
    expect(installPostgresInlineJson()).toBe(true); // idempotent
    const srv = service();
    const { UPSERT } = cds.ql;
    const { sql, entries } = srv.cqn2sql(UPSERT.into('t.Rows').entries([{ ID: 1, note: 'a' }, { ID: 2, note: 'b' }]));
    expect(isInlineRowStream(entries[0][0])).toBe(true);

    const prepared = await srv._prepareStreams({ text: sql, name: 'x', _streams: 0 }, entries[0]);

    expect(prepared.text).toBe(sql); // no "$$PARAMETER_BUFFER$$" subselect
    expect(prepared.text).not.toContain('PARAMETER_BUFFER');
    expect(typeof prepared.values[0]).toBe('string');
    expect(JSON.parse(prepared.values[0])).toEqual([
      expect.objectContaining({ ID: 1, note: 'a' }),
      expect.objectContaining({ ID: 2, note: 'b' }),
    ]);
  });

  it('leaves a caller-provided stream (media) on the driver path', () => {
    expect(isInlineRowStream(Readable.from(['x']))).toBe(false);
    expect(isInlineRowStream('[]')).toBe(false);
  });
});
