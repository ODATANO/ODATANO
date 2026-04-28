/**
 * Unit tests for ExtractPaymentKeyHash decoding logic
 *
 * Exercises the pure bech32 decoding that the handler runs after
 * isValidBech32Address passes. No cds / no backend.
 */

import { bech32 } from 'bech32';
import { TEST_FIXTURES } from '../integration/test-fixtures';

const BECH32_MAX = 2000;

function extract(address: string): string {
  const decoded = bech32.decode(address, BECH32_MAX);
  const bytes = Buffer.from(bech32.fromWords(decoded.words));
  return bytes.slice(1, 29).toString('hex');
}

describe('ExtractPaymentKeyHash (bech32 decoding)', () => {

  it('returns a 56-char lowercase hex string', () => {
    const hash = extract(TEST_FIXTURES.addressWithFunds);
    expect(hash).toMatch(/^[0-9a-f]{56}$/);
  });

  it('is deterministic — same address returns same hash', () => {
    const a = extract(TEST_FIXTURES.addressWithFunds);
    const b = extract(TEST_FIXTURES.addressWithFunds);
    expect(a).toBe(b);
  });

  it('different addresses produce different payment hashes', () => {
    const a = extract(TEST_FIXTURES.addressWithFunds);
    const b = extract(TEST_FIXTURES.emptyAddress);
    expect(a).not.toBe(b);
  });

  it('base (57-byte) address returns the payment part, not the stake part', () => {
    const baseAddr = TEST_FIXTURES.addressWithAssets;
    const paymentHash = extract(baseAddr);

    const decoded = bech32.decode(baseAddr, BECH32_MAX);
    const bytes = Buffer.from(bech32.fromWords(decoded.words));
    const stakeHash = bytes.slice(29, 57).toString('hex');

    expect(bytes.length).toBe(57);
    expect(paymentHash).not.toBe(stakeHash);
    expect(paymentHash).toBe(bytes.slice(1, 29).toString('hex'));
  });

  it('enterprise (29-byte) address returns the 28-byte credential', () => {
    const enterpriseAddr = TEST_FIXTURES.addressWithFunds;
    const decoded = bech32.decode(enterpriseAddr, BECH32_MAX);
    const bytes = Buffer.from(bech32.fromWords(decoded.words));
    expect(bytes.length).toBe(29);
    expect(extract(enterpriseAddr)).toBe(bytes.slice(1, 29).toString('hex'));
  });

  it('throws on malformed bech32 input', () => {
    expect(() => extract('not-an-address')).toThrow();
  });
});
