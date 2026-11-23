import type { Request } from '@sap/cds';

/** The parent of a navigation read such as `Transactions('h')/inputs`: its entity, its keys, the navigation. */
export interface NavigationRead {
  parent: string;
  keys: Record<string, unknown>;
  nav: string;
  /** Keys of the navigation step, as in `Accounts('s')/Address('a')`; null for a plain collection. */
  navKeys: Record<string, unknown> | null;
  /** Segments of the path: 2 for `Parent(k)/nav`, more when it goes further. */
  depth: number;
  /** Name of every segment after the parent; `steps[0]` is `nav`. */
  steps: string[];
}

type Segment = { id?: unknown; where?: unknown[] } | string;

const nameOf = (segment: Segment): string | null =>
  typeof segment === 'string' ? segment : typeof segment?.id === 'string' ? segment.id : null;

const refOf = (req: Pick<Request, 'query'>): unknown[] | undefined => {
  const ref = (req.query as { SELECT?: { from?: { ref?: unknown[] } } } | undefined)?.SELECT?.from?.ref;
  return Array.isArray(ref) ? ref : undefined;
};

/** The keys of a key segment, `ref = val` joined by `and`; null for any other predicate. */
function segmentKeys(segment: Segment): Record<string, unknown> | null {
  if (typeof segment !== 'object' || !Array.isArray(segment.where)) return null;
  const keys: Record<string, unknown> = {};
  const where = segment.where;
  for (let i = 0; i < where.length; i += 4) {
    const left = where[i] as { ref?: unknown[] } | undefined;
    const right = where[i + 2] as { val?: unknown } | undefined;
    if (where[i + 1] !== '=' || !left?.ref || left.ref.length !== 1 || !right || !('val' in right)) return null;
    if (i + 3 < where.length && where[i + 3] !== 'and') return null;
    keys[String(left.ref[0])] = right.val;
  }
  return keys;
}

/** The parent of `req` when it reads through a navigation, else null. */
export function navigationOf(req: Pick<Request, 'query'>): NavigationRead | null {
  const ref = refOf(req);
  if (!ref || ref.length < 2) return null;
  const head = ref[0] as Segment;
  const step = ref[1] as Segment;
  if (typeof head !== 'object' || typeof head.id !== 'string') return null;
  const nav = nameOf(step);
  const keys = segmentKeys(head);
  if (!nav || !keys) return null;
  const steps = ref.slice(1).map((s) => nameOf(s as Segment) ?? '');
  return { parent: head.id.slice(head.id.lastIndexOf('.') + 1), keys, nav, navKeys: typeof step === 'string' ? null : segmentKeys(step), depth: ref.length, steps };
}

// The key `field` of a keyed read. The OData adapter puts it into req.data; a query built with
// cds.ql in the same process carries it only in its key segment.
export function readKey(req: Pick<Request, 'query' | 'data'>, field: string): unknown {
  const fromData = (req.data as Record<string, unknown> | undefined)?.[field];
  if (fromData !== undefined) return fromData;
  const ref = refOf(req);
  return ref?.length === 1 ? segmentKeys(ref[0] as Segment)?.[field] : undefined;
}
