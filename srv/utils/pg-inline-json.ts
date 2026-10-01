/**
 * Bulk INSERT/UPSERT on PostgreSQL: send the rows as one text parameter.
 * @cap-js/postgres turns every `.entries()` row list into a stream and ships it through a
 * per-transaction temp table (`CREATE TEMP TABLE` + `COPY`), three round trips per write plus a
 * table created and dropped per transaction. Row lists built from in-memory arrays are drained
 * into a string instead; streams a caller passes in (media) keep the driver's path.
 */
import cds from '@sap/cds';
import { Readable } from 'stream';

const logger = cds.log('PgInlineJson');
const INSTALLED = Symbol.for('odatano.pgInlineJson');

type PrepareStreams = (this: unknown, query: unknown, values: unknown) => unknown;

/** A JSON row stream the CAP renderer built from an array (it keeps the array as `_raw`). */
export function isInlineRowStream(v: unknown): v is Readable & { _raw: unknown[] } {
  return v instanceof Readable && Array.isArray((v as { _raw?: unknown })._raw);
}

const dbKind = (): string => String(((cds.env?.requires as Record<string, { kind?: string }> | undefined)?.db)?.kind ?? '');

async function drain(stream: Readable): Promise<string> {
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(Buffer.isBuffer(part) ? part : Buffer.from(String(part)));
  return Buffer.concat(parts).toString('utf8');
}

/** Wraps the driver's `_prepareStreams` once; returns false when the driver or the hook is missing. */
export function installPostgresInlineJson(): boolean {
  let PostgresService: { prototype: Record<string | symbol, unknown> };
  try {
    PostgresService = require('@cap-js/postgres/lib/PostgresService');
  } catch (err) {
    if (dbKind() === 'postgres') logger.warn(`@cap-js/postgres/lib/PostgresService not loadable, bulk writes keep the COPY buffer: ${String((err as Error)?.message ?? err)}`);
    return false;
  }
  const proto = PostgresService?.prototype;
  const orig = proto?._prepareStreams as PrepareStreams | undefined;
  if (!proto || typeof orig !== 'function') {
    logger.warn('@cap-js/postgres has no _prepareStreams hook; bulk writes keep the COPY buffer');
    return false;
  }
  if (proto[INSTALLED]) return true;
  proto._prepareStreams = function (this: unknown, query: unknown, values: unknown): unknown {
    if (!Array.isArray(values) || !values.some(isInlineRowStream)) return orig.call(this, query, values);
    return (async () => {
      const inlined = await Promise.all(values.map(v => (isInlineRowStream(v) ? drain(v) : v)));
      return orig.call(this, query, inlined);
    })();
  };
  proto[INSTALLED] = true;
  if (dbKind() === 'postgres') logger.info('Bulk writes on Postgres: row lists sent inline, no COPY buffer');
  return true;
}
