// JSON with exact big integers at any nesting depth. The native parser and writer go first; their
// reviver and replacer walks recurse per level and overflow the stack on deep metadata. A loop
// with its own stack then takes over, so the result never depends on the depth.
import type { JSONValue } from './types';

// Node 22 reviver context and `JSON.rawJSON`, which the ES2022 lib typings do not know yet
interface NativeJson {
  parse(text: string, reviver: (this: unknown, key: string, value: unknown, context?: { source?: string }) => unknown): unknown;
  rawJSON(text: string): object;
}
const native = JSON as unknown as NativeJson;

/** The Ogmios client's rule: an integer literal longer than 15 characters is read as bigint. */
const isBigLiteral = (src: string): boolean => src.length > 15 && /^-?\d+$/.test(src);

type Frame =
  | { kind: 'array'; value: unknown[]; i: number }
  | { kind: 'object'; value: Record<string, unknown>; keys: string[]; i: number; wrote: boolean };

/** Scalar text of a value, or undefined for what JSON leaves out (undefined, functions, symbols). */
function scalar(v: unknown): string | undefined {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string': return JSON.stringify(v);
    case 'number': return Number.isFinite(v) ? String(v) : 'null';
    case 'bigint': return v.toString();
    case 'boolean': return v ? 'true' : 'false';
    default: return undefined;
  }
}

// only objects are asked for toJSON; a bigint keeps its digits even with a toJSON polyfill
function withToJson(v: unknown, key: string): unknown {
  if (typeof v !== 'object' || v === null) return v;
  const toJSON = (v as { toJSON?: unknown }).toJSON;
  const r = typeof toJSON === 'function' ? toJSON.call(v, key) : v;
  // a boxed primitive is written as the primitive, as JSON.stringify does
  return r instanceof Number || r instanceof String || r instanceof Boolean || r instanceof BigInt ? r.valueOf() : r;
}

// a boxed BigInt is unboxed here, before the writer rejects it as a bigint
function replaceBigInt(this: unknown, _key: string, value: unknown): unknown {
  const v = value instanceof BigInt ? value.valueOf() : value;
  return typeof v === 'bigint' ? native.rawJSON(v.toString()) : v;
}

/** JSON.stringify without a replacer. Big integers are written as plain digits. */
export function stringifyJson(root: unknown): string {
  // a toJSON on BigInt.prototype (a common polyfill) would quote the digits before the replacer sees them
  if (!('toJSON' in BigInt.prototype)) {
    try {
      const text = JSON.stringify(root, replaceBigInt);
      if (text === undefined) throw new TypeError('undefined has no JSON text');
      return text;
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
    }
  }
  return stringifyJsonLoop(root);
}

function stringifyJsonLoop(root: unknown): string {
  let out = '';
  const stack: Frame[] = [];
  const open = new Set<object>(); // containers on the current path, to refuse cycles like JSON.stringify

  // writes a value; containers are pushed and written by the loop
  const emit = (v: unknown, inArray: boolean): boolean => {
    if (typeof v === 'object' && v !== null) {
      if (open.has(v)) throw new TypeError('Converting circular structure to JSON');
      open.add(v);
      if (Array.isArray(v)) { out += '['; stack.push({ kind: 'array', value: v, i: 0 }); }
      else { out += '{'; stack.push({ kind: 'object', value: v as Record<string, unknown>, keys: Object.keys(v), i: 0, wrote: false }); }
      return true;
    }
    const s = scalar(v);
    if (s === undefined) {
      if (!inArray) return false;
      out += 'null';
      return true;
    }
    out += s;
    return true;
  };

  if (!emit(withToJson(root, ''), false)) throw new TypeError('undefined has no JSON text');

  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (top.kind === 'array') {
      if (top.i >= top.value.length) { out += ']'; open.delete(top.value); stack.pop(); continue; }
      if (top.i > 0) out += ',';
      const i = top.i++;
      emit(withToJson(top.value[i], String(i)), true);
    } else {
      if (top.i >= top.keys.length) { out += '}'; open.delete(top.value); stack.pop(); continue; }
      const key = top.keys[top.i++];
      const v = withToJson(top.value[key], key);
      if ((typeof v !== 'object' || v === null) && scalar(v) === undefined) continue;
      out += (top.wrote ? ',' : '') + JSON.stringify(key) + ':';
      top.wrote = true;
      emit(v, false);
    }
  }
  return out;
}

function reviveBigInt(this: unknown, _key: string, value: unknown, context?: { source?: string }): unknown {
  return typeof value === 'number' && context?.source !== undefined && isBigLiteral(context.source)
    ? BigInt(context.source)
    : value;
}

/** JSON.parse with long integer literals as bigint. No key rewrite and no field-specific rule. */
export function parseJson(text: string): JSONValue {
  try {
    return native.parse(text, reviveBigInt) as JSONValue;
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    return parseJsonLoop(text);
  }
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
// JSON.parse checks the string body, including raw control characters
const STRING = /"(?:[^"\\]|\\.)*"/y;
const SPACE = /[ \t\n\r]*/y;

type Open =
  | { kind: 'array'; value: unknown[] }
  | { kind: 'object'; value: Record<string, unknown>; key: string | null };

function parseJsonLoop(text: string): JSONValue {
  let pos = 0;
  const fail = (what: string): never => { throw new SyntaxError(`${what} in JSON at position ${pos}`); };
  const skip = (): void => { SPACE.lastIndex = pos; SPACE.exec(text); pos = SPACE.lastIndex; };
  const match = (re: RegExp): string | null => {
    re.lastIndex = pos;
    const m = re.exec(text);
    if (!m) return null;
    pos = re.lastIndex;
    return m[0];
  };

  const stack: Open[] = [];
  let result: unknown;
  let done = false;

  const put = (v: unknown): void => {
    const top = stack[stack.length - 1];
    if (!top) { result = v; done = true; return; }
    if (top.kind === 'array') top.value.push(v);
    else {
      // an own property, as JSON.parse makes it, even for the key "__proto__"
      if (top.key === '__proto__') Object.defineProperty(top.value, top.key, { value: v, writable: true, enumerable: true, configurable: true });
      else top.value[top.key as string] = v;
      top.key = null;
    }
  };

  // after a value inside a container: a comma or the closing bracket
  const close = (): void => {
    while (stack.length > 0) {
      skip();
      const top = stack[stack.length - 1];
      const c = text[pos];
      if (c === ',') { pos++; return; }
      if ((top.kind === 'array' && c === ']') || (top.kind === 'object' && c === '}')) {
        pos++;
        stack.pop();
        put(top.value);
        continue;
      }
      fail(`Unexpected ${c === undefined ? 'end' : `token ${c}`}`);
    }
  };

  while (!done) {
    skip();
    const top = stack[stack.length - 1];
    if (top?.kind === 'object' && top.key === null) {
      const k = match(STRING) ?? fail('Expected property name');
      skip();
      if (text[pos] !== ':') fail('Expected colon');
      pos++;
      top.key = JSON.parse(k) as string;
      continue;
    }

    const c = text[pos];
    if (c === '[' || c === '{') {
      pos++;
      skip();
      const empty = text[pos] === (c === '[' ? ']' : '}');
      if (empty) { pos++; put(c === '[' ? [] : {}); }
      else { stack.push(c === '[' ? { kind: 'array', value: [] } : { kind: 'object', value: {}, key: null }); continue; }
    } else if (c === '"') {
      put(JSON.parse(match(STRING) ?? fail('Bad string')));
    } else if (text.startsWith('true', pos)) { pos += 4; put(true); }
    else if (text.startsWith('false', pos)) { pos += 5; put(false); }
    else if (text.startsWith('null', pos)) { pos += 4; put(null); }
    else {
      const n = match(NUMBER) ?? fail(`Unexpected ${c === undefined ? 'end' : `token ${c}`}`);
      put(isBigLiteral(n) ? BigInt(n) : Number(n));
    }
    if (!done) close();
  }

  skip();
  if (pos < text.length) fail(`Unexpected token ${text[pos]}`);
  return result as JSONValue;
}
