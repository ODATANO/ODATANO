import cds from '@sap/cds';
import type { Request } from '@sap/cds';

// CAP reads Int64 and Decimal from the database as text. A result a handler builds itself carries
// numbers, so one field would change its JSON type with its source. Here both end as the same text.

/** The parts of a linked model definition this module reads. */
interface Typed {
  items?: Typed;
  elements?: Record<string, Typed | undefined>;
  _target?: Typed;
  scale?: number;
  returns?: Typed;
  actions?: Record<string, Typed | undefined>;
}

/** Text of an Int64 or Decimal value, in the form the database returns it. */
function numberText(def: Typed, value: number | bigint): string {
  const scale = def instanceof cds.builtin.classes.Decimal ? def.scale : undefined;
  if (scale === undefined) return String(value);
  return typeof value === 'bigint' ? (scale ? `${value}.${'0'.repeat(scale)}` : String(value)) : value.toFixed(scale);
}

/** `value` with every Int64 and Decimal number as text; `value` itself when it holds none. */
export function numbersAsText(def: Typed | undefined, value: unknown): unknown {
  if (!def || value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    // a to-many association has no `items`: its rows are rows of the target
    const of = def.items ?? def;
    let copy: unknown[] | undefined;
    value.forEach((item, i) => {
      const text = numbersAsText(of, item);
      // Object.assign keeps what CAP adds to a result array, such as $count
      if (text !== item) (copy ??= Object.assign([], value))[i] = text;
    });
    return copy ?? value;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    const { Int64, Decimal } = cds.builtin.classes;
    return def instanceof Int64 || def instanceof Decimal ? numberText(def, value) : value;
  }
  if (typeof value !== 'object') return value;
  const elements = (def._target ?? def).elements;
  if (!elements) return value;
  let copy: Record<string, unknown> | undefined;
  for (const [name, item] of Object.entries(value)) {
    const text = numbersAsText(elements[name], item);
    if (text !== item) (copy ??= { ...value })[name] = text;
  }
  return copy ?? value;
}

// Answers reads and operations of `srv` with Int64 and Decimal as text. The result is replaced,
// never changed in place: a handler may answer with an object that other code keeps counting in.
export function answerNumbersAsText(srv: cds.Service): void {
  srv.after('*', (_results: unknown, req: Request) => {
    const target = req.target as Typed | undefined;
    const operations = (target?.actions ?? srv.actions) as Record<string, Typed | undefined> | undefined;
    const def = req.event === 'READ' ? target : operations?.[req.event]?.returns;
    const text = numbersAsText(def, req.results);
    if (text !== req.results) req.reply(text);
  });
}
