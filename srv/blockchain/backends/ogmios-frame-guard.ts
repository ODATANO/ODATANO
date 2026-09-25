/**
 * Guard for Ogmios chain-sync frames the client's `safeJSON.parse` cannot handle: it recurses per
 * nesting level, so a deeply nested native script overflows the stack inside an un-awaited socket
 * handler and ends the process. On RangeError fall back to iterative `JSON.parse` (big ints as strings).
 */
import { safeJSON } from '@cardano-ogmios/client';
import cds from '@sap/cds';

const logger = cds.log('OgmiosFrameGuard');

/** A frame the guard could not turn into an object at all. */
export interface UnparseableFrame {
  /** Block height, when it could be read off the raw text; null when even that failed. */
  height: number | null;
  /** Block id (hash), when readable. */
  id: string | null;
  reason: string;
  bytes: number;
}

/**
 * Wrap integers outside the safe double range in JSON strings so plain `JSON.parse` cannot
 * round them. One linear pass, no recursion; digits inside strings, floats and exponents
 * are left alone.
 */
export function widenBigIntegers(text: string): string {
  const SAFE_DIGITS = String(Number.MAX_SAFE_INTEGER).length; // 16
  let out = '';
  let last = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }

    // a number literal starts here only after a structural character
    if (c !== '-' && (c < '0' || c > '9')) continue;
    const prev = text[i - 1];
    if (prev !== ':' && prev !== ',' && prev !== '[' && prev !== ' ' && prev !== '\n' && prev !== '\t' && prev !== '\r') continue;

    let j = i;
    if (text[j] === '-') j++;
    const digitsFrom = j;
    while (j < text.length && text[j] >= '0' && text[j] <= '9') j++;
    const digits = j - digitsFrom;
    if (digits === 0) continue;

    // a fraction or exponent means it was never an exact integer — leave it alone
    const after = text[j];
    if (after === '.' || after === 'e' || after === 'E') { i = j; continue; }

    if (digits >= SAFE_DIGITS) {
      const literal = text.slice(i, j);
      if (!Number.isSafeInteger(Number(literal))) {
        out += text.slice(last, i) + '"' + literal + '"';
        last = j;
      }
    }
    i = j - 1;
  }

  return last === 0 ? text : out + text.slice(last);
}

/** Block height/id from the front of an unparseable frame, to name the block in logs and `lastError`. */
function readBlockHeader(text: string): { height: number | null; id: string | null } {
  const head = text.slice(0, 4096);
  const id = /"id"\s*:\s*"([0-9a-fA-F]{64})"/.exec(head);
  const height = /"height"\s*:\s*(\d{1,15})/.exec(head);
  return { height: height ? Number(height[1]) : null, id: id ? id[1] : null };
}

let installed = false;
const reporters = new Set<(frame: UnparseableFrame) => void>();

/**
 * Wrap `safeJSON.parse` once per process and register a report callback; returns its
 * unregister function. The parser is shared by every open chain-sync socket and cannot tell
 * which one a frame came from, so an unusable frame goes to every registered callback.
 * After a reported frame the stream stalls (the client drops non-nextBlock responses),
 * so the caller decides what happens next.
 */
export function installOgmiosFrameGuard(onUnparseableFrame: (frame: UnparseableFrame) => void): () => void {
  reporters.add(onUnparseableFrame);
  const unregister = (): void => { reporters.delete(onUnparseableFrame); };
  if (installed) return unregister;

  const original = safeJSON.parse.bind(safeJSON);
  installed = true; // only once the original is safely in hand

  safeJSON.parse = (raw: unknown): unknown => {
    try {
      return original(raw as never);
    } catch (err) {
      if (!(err instanceof RangeError)) throw err; // a genuine syntax error stays a syntax error

      const text = String(raw);
      const where = readBlockHeader(text);
      try {
        const parsed = JSON.parse(widenBigIntegers(text));
        logger.warn(
          `chain-sync frame too deeply nested for the client's parser (block ${where.height ?? '?'} ` +
          `${where.id ?? ''}, ${text.length} bytes) — parsed without it. Integers beyond 2^53 are ` +
          `strings on this path; the chain-sync mapper stringifies them anyway.`
        );
        return parsed;
      } catch (fallbackErr) {
        const reason = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        logger.error(
          `chain-sync frame unparseable (block ${where.height ?? '?'} ${where.id ?? ''}, ` +
          `${text.length} bytes): ${reason}`
        );
        const frame = { ...where, reason, bytes: text.length };
        for (const r of [...reporters]) {
          try { r(frame); } catch (cbErr) { logger.error('frame guard report callback failed:', cbErr); }
        }
        // Never throw: this runs in an async socket handler nobody awaits, so a throw
        // becomes an unhandled rejection and ends the process.
        return {};
      }
    }
  };
  return unregister;
}

/** Tests only — drop the wrapper so each case starts from the untouched client. */
export function resetOgmiosFrameGuardForTests(originalParse?: typeof safeJSON.parse): void {
  if (originalParse) safeJSON.parse = originalParse;
  installed = false;
  reporters.clear();
}
