import cds from '@sap/cds';

/** Kind of the connected database; '' before it connects. */
export function connectedDbKind(): string {
  return (cds.db as { kind?: string } | undefined)?.kind ?? '';
}

/** Kind the configuration names, known before the database connects. */
export function configuredDbKind(): string {
  const db = (cds.env.requires as { db?: { kind?: unknown } } | undefined)?.db;
  return typeof db?.kind === 'string' ? db.kind : '';
}

/** Dialect of the hand-written bulk statements. */
export type BulkSqlKind = 'postgres' | 'sqlite';

/** The bulk dialect of `kind`; null for a database the statements are not written for. */
export function bulkSqlKind(kind: string = connectedDbKind()): BulkSqlKind | null {
  if (kind === 'postgres') return 'postgres';
  if (kind === 'sqlite' || kind === 'better-sqlite') return 'sqlite';
  return null;
}

/** A column of a JSON fill record and its PostgreSQL type. */
export type FillColumn = [column: string, pgType: string];

export interface JsonFillSpec {
  table: string;
  /** Key columns, matched between the table row `t` and the record `v`. */
  keys: FillColumn[];
  /** Further columns the records carry. */
  values: FillColumn[];
  /** SET list; refers to the table as `t` and to the record as `v`. */
  set: string;
  /** Extra condition on `t`. */
  where?: string;
}

// One UPDATE that joins a JSON array of records on the key, bound as the single parameter.
// The record fields are the column names in lower case.
export function jsonFillUpdate(kind: BulkSqlKind, spec: JsonFillSpec): string {
  const columns = [...spec.keys, ...spec.values];
  const extra = spec.where ? ` AND ${spec.where}` : '';
  if (kind === 'postgres') {
    const record = columns.map(([c, type]) => `${c.toLowerCase()} ${type}`).join(', ');
    const match = spec.keys.map(([c]) => `t.${c} = v.${c.toLowerCase()}`).join(' AND ');
    return `UPDATE ${spec.table} AS t SET ${spec.set} FROM json_to_recordset($1::json) AS v(${record}) WHERE ${match}${extra}`;
  }
  const record = columns.map(([c]) => `json_extract(value, '$.${c.toLowerCase()}') AS ${c}`).join(', ');
  const match = spec.keys.map(([c]) => `t.${c} = v.${c}`).join(' AND ');
  return `UPDATE ${spec.table} AS t SET ${spec.set} FROM (SELECT ${record} FROM json_each(?)) AS v WHERE ${match}${extra}`;
}
