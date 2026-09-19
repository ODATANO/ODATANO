// Value conversion for migrate-sqlite-to-postgres (SQLite row -> CAP insert).
// Integers are read as BigInt: exact for Integer64, converted for the small
// types. A Decimal or Integer64 that SQLite holds as a REAL at or beyond 2^53
// is copied as the integer that double represents (the chain constants stored
// this way, such as the 45e15 lovelace max supply, are exactly representable);
// digits SQLite already rounded at write time cannot be recovered.
const SMALL_INTS = new Set(['cds.Integer', 'cds.Int32', 'cds.Int16', 'cds.UInt8']);
const BIG_INTS = new Set(['cds.Integer64', 'cds.Int64']);
const MAX_EXACT_REAL = 2 ** 53;

function largeRealAsInteger(v, column) {
    if (!Number.isFinite(v) || !Number.isInteger(v)) throw new Error(`${column}: ${v} is not an integral value`);
    return BigInt(v).toString();
}

export function convertValue(el, v, column = '?') {
    if (v === null || v === undefined) return null;
    const type = el?.type;
    if (type === 'cds.Boolean') return v === 1n || v === 1 || v === true || v === '1' || v === 'true';
    if (SMALL_INTS.has(type)) {
        const n = typeof v === 'bigint' ? Number(v) : typeof v === 'string' && v !== '' ? Number(v) : v;
        if (typeof n === 'number' && !Number.isSafeInteger(n)) throw new Error(`${column}: ${String(v)} is not a safe integer for ${type}`);
        return n;
    }
    if (BIG_INTS.has(type)) {
        if (typeof v === 'number' && !Number.isSafeInteger(v)) return largeRealAsInteger(v, column);
        return typeof v === 'bigint' || typeof v === 'number' ? String(v) : v;
    }
    if (type === 'cds.Decimal') {
        if (typeof v === 'bigint') return String(v);
        if (typeof v === 'number' && Math.abs(v) >= MAX_EXACT_REAL) return largeRealAsInteger(v, column);
        return v;
    }
    if (type === 'cds.Double') return typeof v === 'bigint' ? Number(v) : v;
    if (typeof v === 'bigint') return String(v);
    return v;
}

/** One SQLite row as CAP insert data; columns the model no longer knows are dropped. */
export function convertRow(def, row) {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
        const el = def.elements?.[k];
        if (!el) continue;
        out[k] = convertValue(el, v, `${def.name}.${k}`);
    }
    return out;
}
