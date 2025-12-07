import { isTxHash, isPolicyId, isBech32Address } from '../../srv/utils/validators';

describe('validators', () => {
  test('isTxHash valid/invalid', () => {
    // test valid 64-character hex string
    expect(isTxHash('1932fa826ee085666c012b7e464562e455309b33637af2929a9c1cdd00842c2a')).toBe(true);
    expect(isTxHash('testhash')).toBe(false); // too short & invalid format
    expect(isTxHash('123')).toBe(false); // too short & invalid format
    expect(isTxHash('1932fa826ee085666c012b7e464562e455309b33637af2929a9c1cdd00842c2')).toBe(false); // 63 chars
    expect(isTxHash('1932fa826ee085666c012b7e464562e455309b33637af2929a9c1cdd00842c2aa')).toBe(false); // 65 chars
  });

  test('isPolicyId valid/invalid', () => {
    // test valid 56-character hex string 
    expect(isPolicyId('def68337867cb4f1f95b6b811fedbfcdd7780d10a95cc072077088ea')).toBe(true);
    expect(isPolicyId('123')).toBe(false); // too short & invalid format 
    expect(isPolicyId('testPolId')).toBe(false); // too short & invalid format
    expect(isPolicyId('def68337867cb4f1f95b6b811fedbfcdd7780d10a95cc072077088')).toBe(false); // 55 chars
    expect(isPolicyId('def68337867cb4f1f95b6b811fedbfcdd7780d10a95cc072077088eaa')).toBe(false); // 57 chars

  });

  test('isBech32Address detection', () => {
    expect(isBech32Address('addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8')).toBe(true);
    expect(isBech32Address('notaddr')).toBe(false); // invalid format
    expect(isBech32Address('addr1qxyz...')).toBe(false); // mainnet format (dots invalid)
    expect(isBech32Address('addr_test1q')).toBe(false); // too short
    expect(isBech32Address('addr_test1vru2u9xk3u8r7pa8pzp7yc57lvacsq3uk4h26z5j2sv59ms5p3hjf')).toBe(true); // another valid address
  });
});
