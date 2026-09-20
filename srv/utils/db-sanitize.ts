import cds from '@sap/cds';

/**
 * Last line of defence before writes to PostgreSQL.
 *
 * PostgreSQL cannot store U+0000 in `text`, and @cap-js/postgres passes bulk
 * INSERT/UPSERT rows as one JSON document whose parser rejects the escape
 * sequence for NUL ("unsupported Unicode escape sequence"). A single decoded
 * string with a NUL character therefore fails the whole write — a crawled block
 * or a lazily indexed request alike. Mappers avoid producing such strings (see
 * decodeAssetName); installDbSanitizer() guarantees it for every row this plugin
 * writes, whatever the source (provider JSON such as Koios' asset_name_ascii or
 * pool metadata included), by hooking the database service once per process.
 */

/** Remove U+0000 from every string value of the row (nested plain objects included). Returns the same row when nothing changed. */
export function stripNulStrings<T>(row: T): T {
  if (typeof row === 'string') return (row.includes('\u0000') ? row.replaceAll('\u0000', '') : row) as T;
  if (row === null || typeof row !== 'object' || Buffer.isBuffer(row)) return row;
  if (Array.isArray(row)) {
    let out: unknown[] | null = null;
    for (let i = 0; i < row.length; i++) {
      const v = stripNulStrings(row[i]);
      if (v !== row[i]) { out ??= [...row]; out[i] = v; }
    }
    return (out ?? row) as T;
  }
  let out: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
    const nv = stripNulStrings(v);
    if (nv !== v) { out ??= { ...(row as Record<string, unknown>) }; out[k] = nv; }
  }
  return (out ?? row) as T;
}

/** Sanitise a row array for the database; cheap when nothing needs changing. */
export function sanitizeRows<T>(rows: T[]): T[] {
  let out: T[] | null = null;
  for (let i = 0; i < rows.length; i++) {
    const r = stripNulStrings(rows[i]);
    if (r !== rows[i]) { out ??= [...rows]; out[i] = r; }
  }
  return out ?? rows;
}

/** Only this plugin's entities are rewritten — a consumer's own data is never touched. */
const OWN_NAMESPACE = 'odatano.cardano.';

interface CqnWrite {
  INSERT?: { entries?: unknown[] };
  UPSERT?: { entries?: unknown[] };
  UPDATE?: { data?: Record<string, unknown> };
}

/** The slice of a db-service request the sanitizer looks at (structural, so tests can fake it). */
export interface DbWriteRequest {
  query?: unknown;
  target?: { name?: string } | null;
}

/**
 * `before` handler for the database service: strips U+0000 from the rows of an
 * INSERT / UPSERT / UPDATE against one of this plugin's entities, in place.
 */
export function sanitizeDbRequest(req: DbWriteRequest): void {
  if (!req.target?.name?.startsWith(OWN_NAMESPACE)) return;
  const q = req.query as CqnWrite | undefined;
  if (!q || typeof q !== 'object') return;
  const ins = q.INSERT;
  if (ins && Array.isArray(ins.entries)) ins.entries = sanitizeRows(ins.entries);
  const ups = q.UPSERT;
  if (ups && Array.isArray(ups.entries)) ups.entries = sanitizeRows(ups.entries);
  const upd = q.UPDATE;
  if (upd?.data && typeof upd.data === 'object') upd.data = stripNulStrings(upd.data);
}

interface HookableService {
  before(event: string | string[], handler: (req: DbWriteRequest) => void): unknown;
}

const installed = new WeakSet<object>();

/**
 * Hook the sanitizer into the database service (idempotent per service instance).
 * Called from the app-context bootstrap; a missing/unconnected db is a no-op so
 * unit tests and early programmatic initialize() calls never fail here.
 * @returns true when the hook was installed by this call
 */
export function installDbSanitizer(db: HookableService | undefined = cds.db as unknown as HookableService | undefined): boolean {
  if (!db || typeof db.before !== 'function' || installed.has(db)) return false;
  db.before(['CREATE', 'UPSERT', 'UPDATE'], sanitizeDbRequest);
  installed.add(db);
  return true;
}
