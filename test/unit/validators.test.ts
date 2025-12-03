import { isTxHash, isPolicyId, isBech32Address } from '../../srv/utils/validators';

describe('validators', () => {
  test('isTxHash valid/invalid', () => {
    // Valid 64-character hex string (Blake2b256)
    expect(isTxHash('1932fa826ee085666c012b7e464562e455309b33637af2929a9c1cdd00842c2a')).toBe(true);
    expect(isTxHash('testhash')).toBe(false);
  });

  test('isPolicyId valid/invalid', () => {
    // Valid 56-character hex string (Blake2b224)
    expect(isPolicyId('def68337867cb4f1f95b6b811fedbfcdd7780d10a95cc072077088ea')).toBe(true);
    expect(isPolicyId('123')).toBe(false);
  });

  test('isBech32Address detection', () => {
    expect(isBech32Address('addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8')).toBe(true);
    expect(isBech32Address('notaddr')).toBe(false);
  });
});
