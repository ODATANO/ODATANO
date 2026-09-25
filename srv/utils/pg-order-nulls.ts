/**
 * ORDER BY on PostgreSQL: drop the NULLS clause for columns that cannot be NULL.
 * @cap-js/postgres renders `ASC NULLS FIRST` / `DESC NULLS LAST`, the opposite of a btree index's
 * placement, so `$top` reads sorted the whole table; key, `not null` and `@cds.valid.from` columns are exempt.
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
    // No loadable Postgres driver: silent unless the database is Postgres.
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
