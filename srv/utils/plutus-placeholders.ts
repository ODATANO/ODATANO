import { TransactionValidationError } from './errors';
import type { JSONValue } from './types';

/**
 * PlutusData-JSON input-index placeholder `__INPUT_IDX:<64-hex txHash>#<outputIndex>__`; must be the
 * entire `int` field value. Hash case-insensitive, normalized to lowercase at the use site.
 */
export const INPUT_IDX_REGEX = /^__INPUT_IDX:([0-9a-fA-F]{64})#(\d+)__$/;

/** Minimal UTxO reference shape used by the placeholder resolver. */
export interface InputRef {
  txHash: string;
  outputIndex: number;
}

export interface ResolveContext {
  /** Inputs in their final, post-sort order; the array index is the resolved placeholder value. */
  sortedInputs: InputRef[];
}

const MAX_WALK_DEPTH = 64;

/** Replicates Buildooor's input sort (ledger CBOR-set order): txHash bytes, then outputIndex asc. */
export function sortInputsLikeBuildooor<T extends InputRef>(refs: T[]): T[] {
  const copy = refs.slice();
  copy.sort((a, b) => {
    const aBuf = Buffer.from(a.txHash, 'hex');
    const bBuf = Buffer.from(b.txHash, 'hex');
    const cmp = Buffer.compare(aBuf, bBuf);
    if (cmp !== 0) return cmp;
    return a.outputIndex - b.outputIndex;
  });
  return copy;
}

/**
 * Replaces `{int: "__INPUT_IDX:<hash>#<idx>__"}` leaves with the input's sorted position. Only `int`
 * fields are inspected (`bytes` may legitimately contain `__`); an unknown ref throws TransactionValidationError.
 */
export function resolveIndexPlaceholders(node: JSONValue, ctx: ResolveContext): JSONValue {
  return walk(node, ctx, 0);
}

function walk(node: JSONValue, ctx: ResolveContext, depth: number): JSONValue {
  if (depth > MAX_WALK_DEPTH) {
    throw new TransactionValidationError(`PlutusData placeholder walker exceeded max depth ${MAX_WALK_DEPTH}`);
  }
  if (node === null || typeof node !== 'object') return node;

  if (Array.isArray(node)) {
    return node.map(item => walk(item, ctx, depth + 1));
  }

  const out: Record<string, JSONValue> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'int' && typeof value === 'string') {
      const match = INPUT_IDX_REGEX.exec(value);
      if (match) {
        const [, rawTxHash, idxStr] = match;
        const txHash = rawTxHash.toLowerCase(); // input refs are validated lowercase
        const outputIndex = Number(idxStr);
        const pos = ctx.sortedInputs.findIndex(
          ref => ref.txHash === txHash && ref.outputIndex === outputIndex
        );
        if (pos === -1) {
          throw new TransactionValidationError(
            `Placeholder "${value}" references input ${txHash}#${outputIndex} that is not in the final transaction input set`
          );
        }
        out[key] = pos;
        continue;
      }
    }
    out[key] = walk(value, ctx, depth + 1);
  }
  return out;
}

