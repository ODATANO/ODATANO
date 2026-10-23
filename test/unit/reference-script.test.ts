/**
 * Reference-script helpers: provider type spelling, ledger hash and size, the Ogmios script object,
 * the cardano-cli dump envelope and the size placeholder the fee relies on.
 */
import { Cbor, CborBytes } from '@harmoniclabs/cbor';
import { Script } from '@harmoniclabs/cardano-ledger-ts';
import {
  normalizeScriptType, referenceScriptHash, referenceScriptSize, ogmiosReferenceScript, cliReferenceScript, sizePlaceholderScript,
} from '../../srv/utils/reference-script';

// compiled Plutus V3 script as a compiler emits it (bytestring-wrapped flat UPLC), 86 bytes
const PLUTUS_V3 = '585401010029800aba2aba1aab9eaab9dab9a4888896600264653001300600198031803800cc0180092225980099b8748000c01cdd500144c9289bae30093008375400516401830060013003375400d149a26cac8009';
const PLUTUS_V3_HASH = 'def68337867cb4f1f95b6b811fedbfcdd7780d10a95cc072077088ea';
// native script of preview UTxO d51ecfd4…#0 (atLeast 1 of one key); db-sync reports bfa7584b…
const NATIVE_CBOR = '830301818200581cc1baff904af9856e688bd19fc0cdb723c34a3cef8e1caf42f8ef265d';
const NATIVE_HASH = 'bfa7584bb6fca4ba58a9b7a5acb7ed046b0bfeab1c737651c447dc5c';
const NATIVE_JSON = { type: 'atLeast', required: 1, scripts: [{ type: 'sig', keyHash: 'c1baff904af9856e688bd19fc0cdb723c34a3cef8e1caf42f8ef265d' }] };
const doubleWrapped = (hex: string): string => Buffer.from(Cbor.encode(new CborBytes(Buffer.from(hex, 'hex')))).toString('hex');

describe('normalizeScriptType', () => {
  it.each([
    ['plutus:v1', 'plutusV1'], ['plutus:v3', 'plutusV3'], ['plutusV2', 'plutusV2'], ['PlutusScriptV3', 'plutusV3'],
    ['native', 'native'], ['timelock', 'native'], ['multisig', 'native'], ['SimpleScriptLanguage', 'native'],
  ])('maps %s to %s', (raw, expected) => {
    expect(normalizeScriptType(raw)).toBe(expected);
  });

  it('returns null for unknown and non-string input', () => {
    expect(normalizeScriptType('plutus:v9')).toBeNull();
    expect(normalizeScriptType(undefined)).toBeNull();
    expect(normalizeScriptType(3)).toBeNull();
  });
});

describe('referenceScriptHash / referenceScriptSize', () => {
  it('hashes with the language tag and matches the ledger hash', () => {
    expect(referenceScriptHash('plutusV3', Buffer.from(PLUTUS_V3, 'hex'))).toBe(PLUTUS_V3_HASH);
    expect(referenceScriptHash('native', Buffer.from(NATIVE_CBOR, 'hex'))).toBe(NATIVE_HASH);
  });

  it('sizes a Plutus script as its wrapped bytestring and a native script as its CBOR', () => {
    expect(referenceScriptSize(Script.fromCbor(Buffer.from(PLUTUS_V3, 'hex')))).toBe(86);
    expect(referenceScriptSize(Script.native(NATIVE_JSON as never))).toBe(NATIVE_CBOR.length / 2);
  });
});

describe('ogmiosReferenceScript', () => {
  it('returns hash, size, type and the Plutus bytes', () => {
    expect(ogmiosReferenceScript({ language: 'plutus:v3', cbor: PLUTUS_V3 })).toEqual({ hash: PLUTUS_V3_HASH, size: 86, type: 'plutusV3', cbor: PLUTUS_V3 });
  });

  it('carries no bytes for a native script and null without a usable script', () => {
    expect(ogmiosReferenceScript({ language: 'native', json: {}, cbor: NATIVE_CBOR })).toEqual({ hash: NATIVE_HASH, size: 36, type: 'native', cbor: null });
    expect(ogmiosReferenceScript(undefined)).toBeNull();
    expect(ogmiosReferenceScript({ language: 'native', json: {} })).toBeNull();
    expect(ogmiosReferenceScript({ language: 'plutus:v9', cbor: PLUTUS_V3 })).toBeNull();
  });
});

describe('cliReferenceScript', () => {
  it('unwraps the TextEnvelope once and hashes the inner script bytes', () => {
    const ref = cliReferenceScript({
      script: { type: 'PlutusScriptV3', description: '', cborHex: doubleWrapped(PLUTUS_V3) },
      scriptLanguage: 'PlutusScriptLanguage PlutusScriptV3',
    });
    expect(ref).toEqual({ hash: PLUTUS_V3_HASH, size: 86, type: 'plutusV3', cbor: PLUTUS_V3 });
  });

  it('hashes a native script given as JSON', () => {
    expect(cliReferenceScript({ script: NATIVE_JSON, scriptLanguage: 'SimpleScriptLanguage' })).toEqual({ hash: NATIVE_HASH, size: 36, type: 'native', cbor: null });
  });

  it('returns null for absent, malformed or unknown scripts', () => {
    expect(cliReferenceScript(null)).toBeNull();
    expect(cliReferenceScript({ script: null })).toBeNull();
    expect(cliReferenceScript({ script: { type: 'PlutusScriptV3', cborHex: 'zz' } })).toBeNull();
    expect(cliReferenceScript({ script: { type: 'PlutusScriptV3', cborHex: '00' } })).toBeNull();
    expect(cliReferenceScript({ script: { type: 'Mystery', cborHex: doubleWrapped(PLUTUS_V3) } })).toBeNull();
  });
});

describe('sizePlaceholderScript', () => {
  it.each([1, 23, 24, 86, 255, 256, 2_000, 16_384, 65_535, 65_536, 100_000])('yields a script the ledger sizes at %i bytes', (size) => {
    expect(referenceScriptSize(sizePlaceholderScript(size))).toBe(size);
  });
});
