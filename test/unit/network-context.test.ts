/**
 * Validators check addresses against the network of the app context, or before it exists against
 * the configured one, so a valid address is never answered as invalid during a slow start.
 */
import { getActiveNetwork, setActiveNetwork } from '../../srv/utils/network-context';
import { isValidBech32Address } from '../../srv/utils/validators';

const ADDR = 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';
const NETWORK = process.env.NETWORK;
afterEach(() => {
  setActiveNetwork(null);
  if (NETWORK === undefined) delete process.env.NETWORK; else process.env.NETWORK = NETWORK;
});

describe('getActiveNetwork', () => {
  it('takes the configured network before the app context exists', () => {
    process.env.NETWORK = 'preview';
    expect(getActiveNetwork()).toBe('preview');
    expect(isValidBech32Address(ADDR)).toBe(true);
  });

  it('prefers the network of the app context', () => {
    process.env.NETWORK = 'preview';
    setActiveNetwork('mainnet');
    expect(getActiveNetwork()).toBe('mainnet');
    expect(isValidBech32Address(ADDR)).toBe(false);
  });

  it('knows no network for an unknown name', () => {
    process.env.NETWORK = 'devnet';
    expect(getActiveNetwork()).toBeNull();
  });
});
