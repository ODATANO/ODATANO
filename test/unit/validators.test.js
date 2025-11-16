const { isTxHash, isPolicyId, isBech32Address } = require('../../srv/utils/validators');

describe('validators', () => {
  test('isTxHash valid/invalid', () => {
    expect(isTxHash('a'.repeat(64))).toBe(true);
    expect(isTxHash('zzz')).toBe(false);
  });

  test('isPolicyId valid/invalid', () => {
    expect(isPolicyId('a'.repeat(56))).toBe(true);
    expect(isPolicyId('123')).toBe(false);
  });

  test('isBech32Address detection', () => {
    expect(isBech32Address('addr_test1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq')).toBe(true);
    expect(isBech32Address('notaddr')).toBe(false);
  });
});
