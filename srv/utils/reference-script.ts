import { blake2b_224 } from '@harmoniclabs/crypto';
import { Cbor, CborBytes } from '@harmoniclabs/cbor';
import { Script, type NativeScript } from '@harmoniclabs/cardano-ledger-ts';

/** Script language of a reference script as the entities expose it. */
export type ReferenceScriptType = 'native' | 'plutusV1' | 'plutusV2' | 'plutusV3';

/** Hash, ledger byte size and type of a reference script; `cbor` holds the Plutus script bytes when known. */
export interface ReferenceScriptInfo {
  hash: string;
  size: number;
  type: ReferenceScriptType;
  cbor: string | null;
}

const LANGUAGE_TAG: Record<ReferenceScriptType, number> = { native: 0, plutusV1: 1, plutusV2: 2, plutusV3: 3 };

// Maps provider spellings such as `plutus:v3`, `PlutusScriptV3`, `timelock` or `SimpleScript`.
// Null when unknown.
export function normalizeScriptType(raw: unknown): ReferenceScriptType | null {
  if (typeof raw !== 'string') return null;
  const m = /^(?:plutus:?(?:script)?v?)([1-3])$/i.exec(raw.replace(/\s+/g, ''));
  if (m) return `plutusV${m[1]}` as ReferenceScriptType;
  return /^(native|timelock|multisig|simplescript)/i.test(raw) ? 'native' : null;
}

/** Ledger script hash: blake2b-224 over the language tag byte followed by the script bytes. */
export function referenceScriptHash(type: ReferenceScriptType, bytes: Uint8Array): string {
  const tagged = Uint8Array.from(Buffer.concat([Buffer.from([LANGUAGE_TAG[type]]), Buffer.from(bytes)]));
  return Buffer.from(blake2b_224(tagged)).toString('hex');
}

// Ledger-charged size: the compiler's script bytestring for Plutus, the CBOR for native scripts.
export function referenceScriptSize(script: Script): number {
  if (script.type === 'NativeScript') return script.bytes.length;
  const n = script.bytes.length;
  // definite-length CBOR bytestring header
  const header = n < 24 ? 1 : n < 0x100 ? 2 : n < 0x10000 ? 3 : 5;
  return n + header;
}

// Empty script of the given ledger size, so the fee counts a reference script known by size only.
// Never a witness, never serialized. Its hash matches no real script.
export function sizePlaceholderScript(size: number): Script {
  for (let n = Math.max(0, size - 5); n <= size; n++) {
    const header = n < 24 ? 1 : n < 0x100 ? 2 : n < 0x10000 ? 3 : 5;
    if (n + header === size) return Script.plutusV3(new Uint8Array(n));
  }
  return Script.plutusV3(new Uint8Array(Math.max(0, size - 1)));
}

/** Hash, size and type of an Ogmios `script` object (`{ language, cbor }`); null without one. */
export function ogmiosReferenceScript(script: unknown): ReferenceScriptInfo | null {
  const s = script as { language?: string; cbor?: string } | null | undefined;
  const type = normalizeScriptType(s?.language);
  if (!type || typeof s?.cbor !== 'string' || s.cbor.length === 0) return null;
  const bytes = Buffer.from(s.cbor, 'hex');
  return { hash: referenceScriptHash(type, bytes), size: bytes.length, type, cbor: type === 'native' ? null : s.cbor };
}

/** cardano-cli `referenceScript` of a UTxO dump: `{ script: TextEnvelope | native JSON, scriptLanguage }`. */
interface CliReferenceScript {
  script?: { type?: string; cborHex?: string } | Record<string, unknown> | null;
  scriptLanguage?: string;
}

// cardano-cli's Plutus `cborHex` wraps the script once more than the ledger does.
// The ledger hashes and charges the inner bytes. A native script is given as JSON.
export function cliReferenceScript(ref: unknown): ReferenceScriptInfo | null {
  const r = ref as CliReferenceScript | null | undefined;
  const script = r?.script;
  if (!script || typeof script !== 'object') return null;
  const envelope = script as { type?: string; cborHex?: string };
  const type = normalizeScriptType(envelope.type) ?? normalizeScriptType(r?.scriptLanguage);
  try {
    if (type && type !== 'native' && typeof envelope.cborHex === 'string') {
      const outer = Cbor.parse(Buffer.from(envelope.cborHex, 'hex'));
      if (!(outer instanceof CborBytes)) return null;
      const inner = Buffer.from(outer.bytes);
      return { hash: referenceScriptHash(type, inner), size: inner.length, type, cbor: inner.toString('hex') };
    }
    if (type === 'native' || r?.scriptLanguage?.startsWith('SimpleScript')) {
      // cardano-cli prints a native script as JSON.
      const native = Script.native(script as NativeScript);
      return { hash: native.hash.toString(), size: native.bytes.length, type: 'native', cbor: null };
    }
  } catch {
    return null;
  }
  return null;
}
