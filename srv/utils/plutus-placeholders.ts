import { TransactionValidationError } from './errors';
import type { JSONValue } from './types';

/**
 * PlutusData-JSON input-index placeholder `__INPUT_IDX:<64-hex txHash>#<outputIndex>__`; must be the
 * entire `int` field value. Hash case-insensitive, normalized to lowercase at the use site.
 */
export const INPUT_IDX_REGEX = /^__INPUT_IDX:([0-9a-fA-F]{64})#(\d+)__$/;

/** Reference-input index placeholder `__REF_IDX:<64-hex txHash>#<outputIndex>__`, same rules as INPUT_IDX_REGEX. */
export const REF_IDX_REGEX = /^__REF_IDX:([0-9a-fA-F]{64})#(\d+)__$/;

/** Withdrawal index placeholder `__WDRL_IDX:<56-hex credential hash>__`, same rules as INPUT_IDX_REGEX. */
export const WDRL_IDX_REGEX = /^__WDRL_IDX:([0-9a-fA-F]{56})__$/;

/** Minimal UTxO reference shape used by the placeholder resolver. */
export interface InputRef {
  txHash: string;
  outputIndex: number;
}

/** Credential of a reward account, as the ledger orders withdrawals. */
export interface WithdrawalCredential {
  credentialHash: string;
  isScript: boolean;
}

export interface ResolveContext {
  /** Inputs in their final, post-sort order; the array index is the resolved placeholder value. */
  sortedInputs: InputRef[];
  /** All reference inputs in ledger order; absent where the build does not support `__REF_IDX__`. */
  sortedReferenceInputs?: InputRef[];
  /** Withdrawal credential hashes in ledger order; absent where the build does not support `__WDRL_IDX__`. */
  sortedWithdrawals?: string[];
}

const MAX_WALK_DEPTH = 64;

/**
 * Replicates Buildooor's input sort (ledger CBOR-set order): txHash bytes, then outputIndex asc.
 * The ledger orders reference inputs the same way.
 */
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

/** Ledger order of withdrawals: script credentials before key credentials, then hash bytes. */
export function sortWithdrawalsLikeLedger<T extends WithdrawalCredential>(entries: T[]): T[] {
  const copy = entries.slice();
  copy.sort((a, b) => {
    if (a.isScript !== b.isScript) return a.isScript ? -1 : 1;
    return Buffer.compare(Buffer.from(a.credentialHash, 'hex'), Buffer.from(b.credentialHash, 'hex'));
  });
  return copy;
}

/**
 * Replaces `{int: "__INPUT_IDX:…__"}`, `{int: "__REF_IDX:…__"}` and `{int: "__WDRL_IDX:…__"}` leaves with
 * the position in the matching list. Only `int` fields are inspected (`bytes` may legitimately contain
 * `__`); an unknown ref throws TransactionValidationError.
 */
export function resolveIndexPlaceholders(node: JSONValue, ctx: ResolveContext): JSONValue {
  return walk(node, ctx, 0);
}

function positionOf(value: string, ctx: ResolveContext): number | undefined {
  const input = INPUT_IDX_REGEX.exec(value);
  if (input) {
    const txHash = input[1].toLowerCase(); // input refs are validated lowercase
    const outputIndex = Number(input[2]);
    const pos = ctx.sortedInputs.findIndex(ref => ref.txHash === txHash && ref.outputIndex === outputIndex);
    if (pos === -1) {
      throw new TransactionValidationError(
        `Placeholder "${value}" references input ${txHash}#${outputIndex} that is not in the final transaction input set`
      );
    }
    return pos;
  }

  const ref = REF_IDX_REGEX.exec(value);
  if (ref) {
    if (!ctx.sortedReferenceInputs) {
      throw new TransactionValidationError(`Placeholder "${value}" is supported by BuildPlutusTransaction only`);
    }
    const txHash = ref[1].toLowerCase();
    const outputIndex = Number(ref[2]);
    const pos = ctx.sortedReferenceInputs.findIndex(r => r.txHash === txHash && r.outputIndex === outputIndex);
    if (pos === -1) {
      throw new TransactionValidationError(
        `Placeholder "${value}" references ${txHash}#${outputIndex}, which is not a reference input of the transaction`
      );
    }
    return pos;
  }

  const wdrl = WDRL_IDX_REGEX.exec(value);
  if (wdrl) {
    if (!ctx.sortedWithdrawals) {
      throw new TransactionValidationError(`Placeholder "${value}" is supported by BuildPlutusTransaction only`);
    }
    const credentialHash = wdrl[1].toLowerCase();
    const pos = ctx.sortedWithdrawals.indexOf(credentialHash);
    if (pos === -1) {
      throw new TransactionValidationError(
        `Placeholder "${value}" references credential ${credentialHash}, which has no withdrawal in the transaction`
      );
    }
    return pos;
  }
  return undefined;
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
      const pos = positionOf(value, ctx);
      if (pos !== undefined) {
        out[key] = pos;
        continue;
      }
    }
    out[key] = walk(value, ctx, depth + 1);
  }
  return out;
}
