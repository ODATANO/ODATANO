/**
 * Unit tests for DeriveScriptAddress derivation logic
 *
 * Exercises the pure pieces: applyScriptParameters → Script.fromCbor(..).hash →
 * scriptHashToEnterpriseAddress. The integration tests cover the handler wiring.
 */

// Mock cds logger + utils (mappers.ts / tx-build-helper.ts import cds)
vi.mock('@sap/cds', () => {
  const cdsMock = {
  log: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  utils: {
    uuid: vi.fn(() => 'test-uuid-1234'),
  },
};
  return { default: cdsMock, ...cdsMock };
});

import { Script } from '@harmoniclabs/cardano-ledger-ts';
import { applyScriptParameters } from '../../srv/utils/tx-build-helper';
import { scriptHashToEnterpriseAddress } from '../../srv/utils/mappers';
import { TEST_FIXTURES } from '../integration/test-fixtures';

const SCRIPT = TEST_FIXTURES.validPlutusScript;

function hashOf(hex: string): string {
  return Script.fromCbor(Buffer.from(hex, 'hex')).hash.toString();
}

describe('DeriveScriptAddress (derivation logic)', () => {

  it('returns a 56-char hex hash for an unparameterized script', () => {
    const hash = hashOf(SCRIPT);
    expect(hash).toMatch(/^[0-9a-f]{56}$/);
  });

  it('produces an addr_test1 bech32 for preview network', () => {
    const addr = scriptHashToEnterpriseAddress(hashOf(SCRIPT), 'preview');
    expect(addr).toMatch(/^addr_test1/);
  });

  it('produces an addr_test1 bech32 for preprod network', () => {
    const addr = scriptHashToEnterpriseAddress(hashOf(SCRIPT), 'preprod');
    expect(addr).toMatch(/^addr_test1/);
  });

  it('produces an addr1 bech32 for mainnet network', () => {
    const addr = scriptHashToEnterpriseAddress(hashOf(SCRIPT), 'mainnet');
    expect(addr).toMatch(/^addr1/);
    expect(addr).not.toMatch(/^addr_test/);
  });

  it('is deterministic — same inputs produce same hash and address', () => {
    const a = hashOf(SCRIPT);
    const b = hashOf(SCRIPT);
    expect(a).toBe(b);
    expect(scriptHashToEnterpriseAddress(a, 'preview'))
      .toBe(scriptHashToEnterpriseAddress(b, 'preview'));
  });

  it('different networks yield different bech32 addresses for the same script hash', () => {
    const h = hashOf(SCRIPT);
    const addrMain = scriptHashToEnterpriseAddress(h, 'mainnet');
    const addrPrev = scriptHashToEnterpriseAddress(h, 'preview');
    expect(addrMain).not.toBe(addrPrev);
  });

  it('applyScriptParameters changes the resulting script hash', () => {
    const unparamHash = hashOf(SCRIPT);
    const paramApplied = applyScriptParameters(SCRIPT, [{ int: 42 }]);
    const paramHash = hashOf(paramApplied);
    expect(paramHash).toMatch(/^[0-9a-f]{56}$/);
    expect(paramHash).not.toBe(unparamHash);
  });

  it('different parameters produce different hashes', () => {
    const h42 = hashOf(applyScriptParameters(SCRIPT, [{ int: 42 }]));
    const h99 = hashOf(applyScriptParameters(SCRIPT, [{ int: 99 }]));
    expect(h42).not.toBe(h99);
  });

  it('throws on malformed (non-hex) script input', () => {
    expect(() => Script.fromCbor(Buffer.from('not-hex-!', 'hex'))).toThrow();
  });

  it('throws on empty params array via applyScriptParameters', () => {
    expect(() => applyScriptParameters(SCRIPT, [])).toThrow();
  });
});
