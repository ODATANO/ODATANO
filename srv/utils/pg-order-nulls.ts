/**
 * ORDER BY on PostgreSQL: no NULLS clause for NOT NULL columns.
 *
 * @cap-js/postgres renders every ordering term with an explicit null placement,
 * `ASC NULLS FIRST` and `DESC NULLS LAST`, to give SQLite's and HANA's null
 * order on Postgres too. A Postgres btree index is `ASC NULLS LAST` (read
 * backwards `DESC NULLS FIRST`), the opposite placement, so the planner
 * cannot use an index for such an ORDER BY and sorts the whole table before
 * the LIMIT. CAP orders every `$top` read by the entity key, so on the hosted
 * box `Blocks?$top=1` took 0.8 to 7.6 s over 2M rows in NIGHTGATE and every
 * `$top` on a large ODATANO table sorted the same way (measured 2026-09-23,
 * `ORDER BY "$b".ID ASC NULLS FIRST LIMIT 1`, parallel seq scan + top-N sort).
 *
 * A key column, a `not null` column and a temporal `@cds.valid.from` column
 * (part of the persisted primary key, NOT NULL, but neither `key` nor
 * `notNull` in the linked model) hold no NULL, so the placement is
 * meaningless there and is dropped; the plain `ASC` / `DESC` then matches the
 * primary key and the secondary indexes. Nullable columns keep the clause (the
 * semantics stay SQLite's); an explicit `nulls` on the term is always kept.
 * Installed once at start on the Postgres renderer class; a driver without the
 * hook (or no Postgres driver at all) leaves everything as it is, with a
 * warning when the deployment runs on Postgres.
 */
import cds from '@sap/cds';

const logger = cds.log('PgOrderNulls');
const INSTALLED = Symbol.for('odatano.pgOrderNulls');

interface OrderTerm { nulls?: string; element?: { key?: boolean; notNull?: boolean; '@cds.valid.from'?: boolean } }
type OrderByFn = (this: unknown, orderBy: OrderTerm[], ...rest: unknown[]) => string[];

/** Strips the null placement from the rendered terms whose column cannot be NULL. */
export function stripNullsForNotNull(orderBy: OrderTerm[], rendered: string[]): string[] {
  return rendered.map((sql, i) => {
    const c = orderBy[i];
    if (!c || c.nulls) return sql;
    const el = c.element;
    if (el && (el.key === true || el.notNull === true || el['@cds.valid.from'] === true)) return sql.replace(/ NULLS (FIRST|LAST)$/, '');
    return sql;
  });
}

/** Wraps the driver's `_orderBy` once; returns false when the driver or the hook is missing. */
export function installPostgresOrderNulls(): boolean {
  let PostgresService: { CQN2SQL?: { prototype: Record<string | symbol, unknown> } };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    PostgresService = require('@cap-js/postgres/lib/PostgresService');
  } catch (err) {
    // No Postgres driver in this deployment, or a driver that no longer exposes
    // the module: silent unless the database IS Postgres.
    const dbKind = String(((cds.env?.requires as Record<string, { kind?: string }> | undefined)?.db)?.kind ?? '');
    if (dbKind === 'postgres') logger.warn(`@cap-js/postgres/lib/PostgresService not loadable, ORDER BY keeps the NULLS clause: ${String((err as Error)?.message ?? err)}`);
    return false;
  }
  const proto = PostgresService.CQN2SQL?.prototype;
  const orig = proto?._orderBy as OrderByFn | undefined;
  if (!proto || typeof orig !== 'function') {
    logger.warn('@cap-js/postgres has no _orderBy hook; ORDER BY keeps the NULLS clause (indexes will not serve ordered reads)');
    return false;
  }
  if (proto[INSTALLED]) return true;
  proto._orderBy = function (this: unknown, orderBy: OrderTerm[], ...rest: unknown[]): string[] {
    return stripNullsForNotNull(orderBy, orig.call(this, orderBy, ...rest));
  };
  proto[INSTALLED] = true;
  logger.info('ORDER BY on Postgres: NULLS clause dropped for key and NOT NULL columns');
  return true;
}
