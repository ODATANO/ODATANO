// Refuses reads on the large tables that no index can answer, so a client cannot make the
// database scan a whole table. Keyed reads, navigations and expands go by key and pass.
import cds from '@sap/cds';
import type { Request } from '@sap/cds';
import { BackendError } from './errors';
import { ERROR_CODES } from './error-codes';
import { DB_INDEXES } from './db-indexes';

/** Entities of the read service whose tables grow with the chain. */
export const GUARDED_ENTITIES: readonly string[] = Object.freeze([
  'Blocks', 'Transactions', 'TransactionInputs', 'TransactionOutputs', 'TransactionInputAssets',
  'TransactionOutputAssets', 'TransactionMetadata', 'TransactionCertificates', 'TransactionWithdrawals',
  'TransactionRedeemers', 'TransactionDatums', 'AssetHistory', 'Assets',
  'LedgerUTxOs', 'LedgerUTxOAssets', 'LedgerAddresses', 'LedgerAddressAssets', 'LedgerAccounts',
  'AccountEpochSnapshots', 'PoolEpochSnapshots', 'DrepEpochSnapshots',
]);

// One row per block: counting a slot or height range reads only the index, and stays fast.
const RANGE_COUNTS: ReadonlySet<string> = new Set(['Blocks']);

const DB_NAMESPACE = 'odatano.cardano';

type Token = { ref?: unknown[]; val?: unknown; func?: string; xpr?: Token[]; list?: Token[]; SELECT?: unknown } | string;
type OrderTerm = { ref?: unknown[]; implicit?: boolean; func?: string; xpr?: unknown };
type Select = {
  from?: { ref?: unknown[] };
  where?: Token[];
  orderBy?: OrderTerm[];
  search?: unknown;
  groupBy?: unknown[];
  having?: unknown;
  count?: boolean;
  columns?: Array<{ func?: string; as?: string }>;
};
type EntityDef = { elements?: Record<string, { key?: boolean; isAssociation?: boolean; keys?: Array<{ ref: string[] }>; '@cds.valid.from'?: boolean }> };

const lower = (s: string) => s.toLowerCase();

/** Primary key columns in table order; a managed association key becomes its foreign key columns. */
export function keyColumns(entity: EntityDef | undefined): string[] {
  const elements = Object.entries(entity?.elements ?? {});
  // a temporal table's primary key starts with validFrom, which the model does not mark as key
  const out: string[] = elements.filter(([, el]) => el['@cds.valid.from']).map(([name]) => name);
  for (const [name, el] of elements) {
    if (!el.key) continue;
    if (el.isAssociation) { for (const fk of el.keys ?? []) { const col = `${name}_${fk.ref.join('_')}`; if (!out.includes(col)) out.push(col); } }
    else if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** Column lists of the primary key and of every secondary index on the table, lower case. */
export function indexColumnLists(entityName: string, entity: EntityDef | undefined): string[][] {
  const table = lower(`${DB_NAMESPACE}.${entityName}`.replace(/\./g, '_'));
  const lists = [keyColumns(entity).map(lower)];
  for (const spec of DB_INDEXES) {
    if (lower(spec.table) !== table) continue;
    lists.push(spec.columns.split(',').map(c => lower(c.trim().split(/\s+/)[0])));
  }
  return lists.filter(l => l.length > 0);
}

const columnOf = (ref: unknown[] | undefined): string | null =>
  Array.isArray(ref) && ref.every(r => typeof r === 'string') ? lower((ref as string[]).join('_')) : null;

// fixed: columns a top-level `and` sets equal to a value or null. narrowing: equal to a value,
// which leaves few rows. unsupported: the first construct no index serves.
interface WhereShape { columns: Set<string>; fixed: Set<string>; narrowing: Set<string>; unsupported: string | null }

/** The shape of a filter as the guard needs it. */
export function whereShape(where: Token[] | undefined): WhereShape {
  const shape: WhereShape = { columns: new Set(), fixed: new Set(), narrowing: new Set(), unsupported: null };
  const walk = (tokens: Token[]) => {
    for (const t of tokens) {
      if (typeof t === 'string') continue;
      if (t.func) shape.unsupported ??= `function ${t.func}`;
      else if (t.SELECT) shape.unsupported ??= 'subquery';
      else if (t.ref) {
        const col = columnOf(t.ref);
        if (col) shape.columns.add(col);
        else shape.unsupported ??= 'expression path';
      }
      if (t.xpr) walk(t.xpr);
      if (t.list) walk(t.list);
    }
  };
  walk(where ?? []);
  const tokens = where ?? [];
  const topLevelAnd = tokens.every(t => typeof t !== 'string' || !['or', 'not'].includes(lower(t)));
  if (topLevelAnd) {
    for (let i = 0; i + 2 < tokens.length; i++) {
      const [a, op, b] = [tokens[i], tokens[i + 1], tokens[i + 2]];
      if (op === 'is' && b === 'null' && typeof a === 'object' && a.ref) {
        const col = columnOf(a.ref);
        if (col) shape.fixed.add(col);
        continue;
      }
      if (op !== '=') continue;
      const left = typeof a === 'object' && a.ref && typeof b === 'object' && 'val' in b ? columnOf(a.ref) : null;
      const right = typeof b === 'object' && b.ref && typeof a === 'object' && 'val' in a ? columnOf(b.ref) : null;
      const col = left ?? right;
      const value = (typeof a === 'object' && 'val' in a ? a.val : typeof b === 'object' && 'val' in b ? b.val : null);
      if (col) shape.fixed.add(col);
      if (col && value !== null) shape.narrowing.add(col);
    }
  }
  return shape;
}

/** True when `column` sits right after a prefix of an index that the filter fixes. */
function reachable(column: string, lists: string[][], fixed: Set<string>): boolean {
  return lists.some(list => {
    const k = list.indexOf(column);
    return k >= 0 && list.slice(0, k).every(c => fixed.has(c));
  });
}

/** True when the sort columns continue an index after its fixed prefix, so the index delivers the order. */
function orderServed(order: string[], lists: string[][], fixed: Set<string>): boolean {
  return lists.some(list => {
    let k = 0;
    while (k < list.length && fixed.has(list[k]) && list[k] !== order[0]) k++;
    return order.every((c, i) => list[k + i] === c);
  });
}

/** The reason a read on `entityName` would scan its table, or null when an index answers it. */
export function unindexedReason(entityName: string, select: Select, entity: EntityDef | undefined): string | null {
  const ref = select.from?.ref;
  const head = ref?.[0] as { where?: unknown } | undefined;
  if ((ref?.length ?? 0) > 1 || (head && typeof head === 'object' && head.where)) return null;
  if (select.search) return '$search is not supported on this entity set';
  const aggregated = select.columns?.some(c => c.func && c.func !== 'count') ?? false;
  if (select.groupBy?.length || select.having || aggregated) return '$apply is not supported on this entity set';

  const lists = indexColumnLists(entityName, entity);
  const shape = whereShape(select.where);
  if (shape.unsupported) return `$filter uses a ${shape.unsupported}; filter with comparisons on indexed fields`;
  for (const col of shape.columns) {
    if (!reachable(col, lists, shape.fixed)) return `$filter on ${col} is not indexed`;
  }

  const counted = select.count === true || (select.columns?.some(c => c.func === 'count') ?? false);
  if (counted && !select.where?.length) return '$count needs a $filter on an indexed field';
  // a range on a large table counts every row in it
  if (counted && shape.narrowing.size === 0 && !RANGE_COUNTS.has(entityName)) return '$count needs an eq $filter on an indexed field';

  const order = (select.orderBy ?? []).filter(o => !o.implicit);
  if (order.some(o => !columnOf(o.ref))) return '$orderby supports plain fields only';
  const orderCols = order.map(o => columnOf(o.ref) as string);
  // after an equality on an indexed field few rows are left, so any order is cheap to sort
  if (orderCols.length && shape.narrowing.size === 0 && !orderServed(orderCols, lists, shape.fixed)) {
    return `$orderby on ${orderCols.join(', ')} needs an equality $filter or an index in that order`;
  }
  return null;
}

/** The fields a filter may start with on `entityName`; named in the refusal. */
export function filterableFields(entityName: string, entity: EntityDef | undefined): string[] {
  const firsts = indexColumnLists(entityName, entity).map(l => l[0]);
  return [...new Set(firsts)];
}

/** Registers the guard on the read service; refuses with 400 before any handler reads. */
export function guardLargeReads(srv: Pick<cds.Service, 'before' | 'prepend'>): void {
  const guarded = new Set(GUARDED_ENTITIES);
  srv.prepend(() => srv.before('READ', (req: Request) => {
    // in-process callers of a plugin host keep their queries; the guard covers HTTP requests
    if (!(req as unknown as { context?: { http?: unknown } }).context?.http) return;
    const name = req.target?.name?.split('.').pop();
    if (!name || !guarded.has(name)) return;
    const entity = cds.model?.definitions?.[`${DB_NAMESPACE}.${name}`] as EntityDef | undefined;
    const reason = unindexedReason(name, (req.query as { SELECT?: Select })?.SELECT ?? {}, entity);
    if (!reason) return;
    throw new BackendError(
      `${name}: ${reason} (indexed: ${filterableFields(name, entity).join(', ')})`,
      400,
      ERROR_CODES.QUERY_NOT_INDEXED,
    );
  }));
}
