/**
 * ExtractPaymentKeyHash answers with `decodeShelleyAddress(address).paymentCredential` when the
 * address has a key credential, and refuses a script credential or an address without one.
 */

import { bech32 } from 'bech32';
import { decodeShelleyAddress } from '../../srv/utils/mappers';
import { TEST_FIXTURES } from '../integration/test-fixtures';

const BECH32_MAX = 2000;

/** Testnet address of `type` (header high nibble) over the given credentials. */
function address(type: number, ...credentials: string[]): string {
  const bytes = Buffer.concat([Buffer.from([type << 4]), ...credentials.map(c => Buffer.from(c, 'hex'))]);
  return bech32.encode('addr_test', bech32.toWords(bytes), BECH32_MAX);
}

describe('ExtractPaymentKeyHash decoding', () => {
  it('returns the payment part of a base address, not the stake part', () => {
    const decoded = decodeShelleyAddress(TEST_FIXTURES.addressWithAssets);
    const bytes = Buffer.from(bech32.fromWords(bech32.decode(TEST_FIXTURES.addressWithAssets, BECH32_MAX).words));
    expect(decoded.paymentCredential).toBe(bytes.subarray(1, 29).toString('hex'));
    expect(decoded.paymentCredential).not.toBe(bytes.subarray(29, 57).toString('hex'));
    expect(decoded.isScript).toBe(false);
  });

  it('returns the credential of an enterprise key address', () => {
    expect(decodeShelleyAddress(address(6, 'ab'.repeat(28)))).toMatchObject({ paymentCredential: 'ab'.repeat(28), isScript: false });
  });

  it('marks a script payment credential, which the action refuses', () => {
    expect(decodeShelleyAddress(address(7, 'cd'.repeat(28)))).toMatchObject({ paymentCredential: 'cd'.repeat(28), isScript: true });
    expect(decodeShelleyAddress(address(1, 'cd'.repeat(28), 'ab'.repeat(28))).isScript).toBe(true);
  });

  it('has no payment credential for a reward address or malformed input', () => {
    expect(decodeShelleyAddress(TEST_FIXTURES.validStakeAddress).paymentCredential).toBeNull();
    expect(decodeShelleyAddress('not-an-address').paymentCredential).toBeNull();
  });
});
