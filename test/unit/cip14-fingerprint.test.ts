import { computeCip14Fingerprint } from '../../srv/utils/mappers';

/**
 * CIP-14 Asset Fingerprint Tests
 * Test vectors from: https://github.com/cardano-foundation/CIPs/blob/master/CIP-0014/README.md
 */
describe('CIP-14 Asset Fingerprint', () => {

  // ==========================================================================
  // Official CIP-14 test vectors
  // ==========================================================================

  it('should compute fingerprint for policyId only (empty asset name) - vector 1', () => {
    const result = computeCip14Fingerprint(
      '7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc373',
      ''
    );
    expect(result).toBe('asset1rjklcrnsdzqp65wjgrg55sy9723kw09mlgvlc3');
  });

  it('should compute fingerprint for policyId only (empty asset name) - vector 2', () => {
    const result = computeCip14Fingerprint(
      '7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc37e',
      ''
    );
    expect(result).toBe('asset1nl0puwxmhas8fawxp8nx4e2q3wekg969n2auw3');
  });

  it('should compute fingerprint for policyId only (empty asset name) - vector 3', () => {
    const result = computeCip14Fingerprint(
      '1e349c9bdea19fd6c147626a5260bc44b71635f398b67c59881df209',
      ''
    );
    expect(result).toBe('asset1uyuxku60yqe57nusqzjx38aan3f2wq6s93f6ea');
  });

  it('should compute fingerprint for policyId + asset name (PATATE) - vector 4', () => {
    const result = computeCip14Fingerprint(
      '7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc373',
      '504154415445'
    );
    expect(result).toBe('asset13n25uv0yaf5kus35fm2k86cqy60z58d9xmde92');
  });

  it('should compute fingerprint for policyId + asset name (PATATE) - vector 5', () => {
    const result = computeCip14Fingerprint(
      '1e349c9bdea19fd6c147626a5260bc44b71635f398b67c59881df209',
      '504154415445'
    );
    expect(result).toBe('asset1hv4p5tv2a837mzqrst04d0dcptdjmluqvdx9k3');
  });

  it('should compute fingerprint with long asset name - vector 6', () => {
    const result = computeCip14Fingerprint(
      '1e349c9bdea19fd6c147626a5260bc44b71635f398b67c59881df209',
      '7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc373'
    );
    expect(result).toBe('asset1aqrdypg669jgazruv5ah07nuyqe0wxjhe2el6f');
  });

  it('should compute fingerprint with long asset name - vector 7', () => {
    const result = computeCip14Fingerprint(
      '7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc373',
      '1e349c9bdea19fd6c147626a5260bc44b71635f398b67c59881df209'
    );
    expect(result).toBe('asset17jd78wukhtrnmjh3fngzasxm8rck0l2r4hhyyt');
  });

  it('should compute fingerprint with 32-byte zero asset name - vector 8', () => {
    const result = computeCip14Fingerprint(
      '7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc373',
      '0000000000000000000000000000000000000000000000000000000000000000'
    );
    expect(result).toBe('asset1pkpwyknlvul7az0xx8czhl60pyel45rpje4z8w');
  });

  // ==========================================================================
  // Output format validation
  // ==========================================================================

  it('should always start with "asset1" prefix', () => {
    const result = computeCip14Fingerprint(
      '7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc373',
      '504154415445'
    );
    expect(result).toMatch(/^asset1/);
  });

  it('should produce a fingerprint of 44 characters or fewer', () => {
    const result = computeCip14Fingerprint(
      '7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc373',
      '504154415445'
    );
    expect(result.length).toBeLessThanOrEqual(44);
  });

  // ==========================================================================
  // Determinism
  // ==========================================================================

  it('should produce identical fingerprints for same inputs', () => {
    const a = computeCip14Fingerprint(
      '7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc373',
      '504154415445'
    );
    const b = computeCip14Fingerprint(
      '7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc373',
      '504154415445'
    );
    expect(a).toBe(b);
  });

  it('should produce different fingerprints for different policyIds with same assetName', () => {
    const a = computeCip14Fingerprint(
      '7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc373',
      '504154415445'
    );
    const b = computeCip14Fingerprint(
      '1e349c9bdea19fd6c147626a5260bc44b71635f398b67c59881df209',
      '504154415445'
    );
    expect(a).not.toBe(b);
  });
});
