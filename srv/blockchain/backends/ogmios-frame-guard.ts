// The Ogmios client's `safeJSON.parse` recurses per nesting level and refuses a "__proto__" key.
// Either throw lands in a socket handler and ends the process, so such frames are parsed here.
import { safeJSON } from '@cardano-ogmios/client';
import cds from '@sap/cds';
import { parseJson } from '../../utils/deep-json';

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

/** Block height/id from the front of an unparseable frame, to name the block in logs and `lastError`. */
function readBlockHeader(text: string): { height: number | null; id: string | null } {
  const head = text.slice(0, 4096);
  const id = /"id"\s*:\s*"([0-9a-fA-F]{64})"/.exec(head);
  const height = /"height"\s*:\s*(\d{1,15})/.exec(head);
  return { height: height ? Number(height[1]) : null, id: id ? id[1] : null };
}

let installed = false;
const reporters = new Set<(frame: UnparseableFrame) => void>();

// Why the client's parser gave up, or null for a genuine syntax error. json-bigint throws a plain
// object named SyntaxError for a "__proto__" key; the client only rewrites the "constructor" case.
function fallbackReason(err: unknown): string | null {
  if (err instanceof RangeError) return "too deeply nested for the client's parser";
  const e = err as { name?: unknown; message?: unknown } | null;
  if (e?.name === 'SyntaxError' && typeof e.message === 'string' && e.message.includes('forbidden prototype')) {
    return 'carries a "__proto__" key the client\'s parser refuses';
  }
  return null;
}

// Wraps `safeJSON.parse` once per process and returns an unregister function. The parser is shared
// by all chain-sync sockets, so an unusable frame goes to every callback. That stream then stalls.
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
      const why = fallbackReason(err);
      if (why === null) throw err; // a genuine syntax error stays a syntax error

      const text = String(raw);
      const where = readBlockHeader(text);
      try {
        // Without the client's bigint pass (it recurses too), so short integers stay numbers here.
        // Every reader of a quantity stringifies it, so the two shapes are read the same way.
        const parsed = parseJson(text);
        logger.warn(
          `chain-sync frame ${why} (block ${where.height ?? '?'} ${where.id ?? ''}, ${text.length} bytes), ` +
          'parsed without it.'
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

/** Tests only: drop the wrapper so each case starts from the untouched client. */
export function resetOgmiosFrameGuardForTests(originalParse?: typeof safeJSON.parse): void {
  if (originalParse) safeJSON.parse = originalParse;
  installed = false;
  reporters.clear();
}
