/**
 * Guard against Ogmios chain-sync frames that the client's JSON parser cannot handle.
 *
 * `@cardano-ogmios/client` parses every WebSocket frame with `safeJSON.parse`, which is
 * `sanitize(JSONBig.parse(raw))`. Both halves recurse once per nesting level: the
 * `@cardanosolutions/json-bigint` parser is Crockford's recursive descent, and `sanitize`
 * walks the parsed tree recursively. A native script nests one JSON object per clause, and
 * nested clauses cost only a few bytes each in CBOR — so an ordinary-looking block can
 * expand into JSON that is ten thousand levels deep and exhaust the V8 stack.
 *
 * That is not a theoretical shape. Preprod block 5183974 carries a native script nested
 * 10 774 levels deep (`{"clause":"all","from":[ … ]}` down to a single signature clause).
 * The block is 43 kB on chain and 205 kB as a chain-sync frame.
 *
 * The crash is fatal rather than merely annoying, because of where the parse happens
 * (`ChainSynchronization/Client.js`):
 *
 *     socket.on('message', async (message) => {
 *       await responseHandler(util_1.safeJSON.parse(message));
 *     });
 *
 * `safeJSON.parse` throws synchronously inside an `async` handler that nobody awaits, so
 * the `RangeError` surfaces as an unhandled rejection and Node takes the process down. The
 * crawler's poison-block latch cannot help: it guards the persist path, and the server is
 * gone long before a block reaches it. Docker restarts, the crawler resumes at the same
 * block, and the loop repeats — 53 restarts in seven minutes on the hosted box.
 *
 * This guard wraps `safeJSON.parse` (a public export of the client package) so that the
 * fast path is untouched and only an overflowing frame takes the recovery route:
 *
 *  1. the original parser, so every ordinary frame keeps its exact BigInt handling;
 *  2. on `RangeError`, `widenBigIntegers()` rewrites integer literals that a double cannot
 *     hold into JSON strings, then plain `JSON.parse` — V8's parser is iterative, so depth
 *     is no longer a limit. `sanitize` is skipped, because it would overflow on the very
 *     same structure;
 *  3. if even that fails, the frame is reported to the caller and a sentinel is returned.
 *     The guard never throws, because throwing here is what kills the process.
 *
 * Measured against the real frame (node 22, 205 728 bytes, depth 10 774): json-bigint and
 * `JSON.parse` with a reviver both overflow — a reviver walk is recursive too — while plain
 * `JSON.parse` completes in 17 ms.
 *
 * Upstream: a recursive parser on untrusted chain data is a denial-of-service against every
 * consumer of the client, mainnet included. This guard is a local mitigation, not the cure.
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
 * Integers outside the safe double range, written into JSON strings so that plain
 * `JSON.parse` cannot round them. Runs as one linear pass with an explicit in-string state,
 * never recursing, so it is immune to the nesting that sent us here in the first place.
 *
 * Only numbers in value position are touched: digits inside strings (hashes, CBOR, asset
 * names) are skipped, and so are floats and exponents, which are doubles by nature and have
 * no exact integer to preserve.
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

/**
 * Block header fields out of a frame we could not parse. They sit near the front of a
 * chain-sync response and at shallow depth, so a narrow match finds them even when the
 * body is unusable — enough to name the offending block in a log line and in `lastError`.
 */
function readBlockHeader(text: string): { height: number | null; id: string | null } {
  const head = text.slice(0, 4096);
  const id = /"id"\s*:\s*"([0-9a-fA-F]{64})"/.exec(head);
  const height = /"height"\s*:\s*(\d{1,15})/.exec(head);
  return { height: height ? Number(height[1]) : null, id: id ? id[1] : null };
}

let installed = false;

/**
 * Wrap `safeJSON.parse` once per process. Idempotent: a second call only replaces the
 * report callback, so reopening the chain-sync stream never stacks wrappers.
 *
 * @param onUnparseableFrame called when a frame survives neither parser. The guard returns
 *        a sentinel instead of throwing, so the caller owns what happens next — the stream
 *        itself stalls, because the client drops anything that is not a nextBlock response.
 */
export function installOgmiosFrameGuard(onUnparseableFrame: (frame: UnparseableFrame) => void): void {
  report = onUnparseableFrame;
  if (installed) return;

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
        report({ ...where, reason, bytes: text.length });
        // Never throw: this runs in an async socket handler nobody awaits, so a throw
        // becomes an unhandled rejection and ends the process.
        return {};
      }
    }
  };
}

let report: (frame: UnparseableFrame) => void = () => { /* replaced on install */ };

/** Tests only — drop the wrapper so each case starts from the untouched client. */
export function resetOgmiosFrameGuardForTests(originalParse?: typeof safeJSON.parse): void {
  if (originalParse) safeJSON.parse = originalParse;
  installed = false;
  report = () => { /* noop */ };
}
