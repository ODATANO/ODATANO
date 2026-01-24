/**
 * Unit tests for tx-build-helper utilities
 */

import { getLovelace, assertAdaOnly, getTxHashFromCbor } from '../../srv/utils/tx-build-helper';
import type { UTxO as OdatanoUtxo } from '../../srv/utils/types';
import { Tx } from '@harmoniclabs/cardano-ledger-ts';

jest.mock('@harmoniclabs/cardano-ledger-ts', () => ({
  Tx: {
    fromCbor: jest.fn()
  }
}));

describe('tx-build-helper utilities', () => {
  describe('getLovelace', () => {
    it('should extract lovelace amount from UTxO', () => {
      const utxo: OdatanoUtxo = {
        txHash: 'abc123',
        outputIndex: 0,
        address: 'addr_test1...',
        amount: [
          { unit: 'lovelace', quantity: '5000000' },
        ],
      };

      const lovelace = getLovelace(utxo);
      expect(lovelace).toBe(5000000n);
    });

    it('should return 0 if no lovelace found', () => {
      const utxo: OdatanoUtxo = {
        txHash: 'abc123',
        outputIndex: 0,
        address: 'addr_test1...',
        amount: [
          { unit: 'someasset', quantity: '100' },
        ],
      };

      const lovelace = getLovelace(utxo);
      expect(lovelace).toBe(0n);
    });
  });

  describe('assertAdaOnly', () => {
    it('should not throw for ADA-only UTxO', () => {
      const utxo: OdatanoUtxo = {
        txHash: 'abc123',
        outputIndex: 0,
        address: 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8',
        amount: [
          { unit: 'lovelace', quantity: '5000000' },
        ],
      };

      expect(() => assertAdaOnly(utxo)).not.toThrow();
    });

    it('should throw for UTxO with non-ADA assets', () => {
      const utxo: OdatanoUtxo = {
        txHash: 'def456',
        outputIndex: 1,
        address: 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8',
        amount: [
          { unit: 'lovelace', quantity: '5000000' },
          { unit: 'policy1asset1', quantity: '100' },
        ],
      };

      expect(() => assertAdaOnly(utxo)).toThrow('contains non-ADA assets');
    });

    it('should not throw for UTxO with zero-quantity non-ADA assets', () => {
      const utxo: OdatanoUtxo = {
        txHash: 'ghi789',
        outputIndex: 2,
        address: 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8',
        amount: [
          { unit: 'lovelace', quantity: '5000000' },
          { unit: 'policy1asset1', quantity: '0' },
        ],
      };

      expect(() => assertAdaOnly(utxo)).not.toThrow();
    });
  });

  describe('getTxHashFromCbor', () => {
    // Valid signed transaction CBOR from testnet (minimal ADA transfer)
    const validSignedTxCbor = '84a400818258203b40265111d8bb3c3c608d95b3a0bf83461ace32d79336579a1939b3aad1c0b700018182583900b0b59f4c9e9d7d4d6a0e3b5a9e1f2c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f7a8b91a001e84800282a1581c3b40265111d8bb3c3c608d95b3a0bf83461ace32d79336579a1939b3a14474657374193039021a0002b5690319138fa100818258203b40265111d8bb3c3c608d95b3a0bf83461ace32d79336579a1939b3aad1c0b75840deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeeff5f6';
    const mockedTx = Tx as jest.Mocked<typeof Tx>;

    afterEach(() => {
      jest.resetAllMocks();
    });

    it('should throw for empty string input', () => {
      expect(() => getTxHashFromCbor('')).toThrow('Invalid input: signedTxCbor must be a non-empty string');
    });

    it('should throw for null input', () => {
      expect(() => getTxHashFromCbor(null as any)).toThrow('Invalid input: signedTxCbor must be a non-empty string');
    });

    it('should throw for undefined input', () => {
      expect(() => getTxHashFromCbor(undefined as any)).toThrow('Invalid input: signedTxCbor must be a non-empty string');
    });

    it('should throw for non-string input', () => {
      expect(() => getTxHashFromCbor(12345 as any)).toThrow('Invalid input: signedTxCbor must be a non-empty string');
    });

    it('should throw for non-hex string', () => {
      expect(() => getTxHashFromCbor('not-a-hex-string!')).toThrow('Invalid input: signedTxCbor must be a valid hex string');
    });

    it('should throw for string with non-hex characters', () => {
      expect(() => getTxHashFromCbor('abcdefgh12345678')).toThrow('Invalid input: signedTxCbor must be a valid hex string');
    });

    it('should throw for malformed CBOR (valid hex but invalid structure)', () => {
      mockedTx.fromCbor.mockImplementation(() => {
        throw new Error('CBOR decode error');
      });
      expect(() => getTxHashFromCbor('deadbeef')).toThrow('Failed to parse transaction CBOR');
    });

    it('should throw for truncated CBOR', () => {
      mockedTx.fromCbor.mockImplementation(() => {
        throw new Error('Unexpected end of CBOR');
      });
      const truncated = validSignedTxCbor.substring(0, 100);
      expect(() => getTxHashFromCbor(truncated)).toThrow('Failed to parse transaction CBOR');
    });

    it('should return 64-character hex hash for valid signed transaction', () => {
      const expectedHash = 'a'.repeat(64);
      mockedTx.fromCbor.mockReturnValue({ hash: { toString: () => expectedHash } } as any);

      const hash = getTxHashFromCbor(validSignedTxCbor);
      expect(typeof hash).toBe('string');
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should accept uppercase hex characters', () => {
      mockedTx.fromCbor.mockImplementation(() => {
        throw new Error('CBOR decode error');
      });
      const upperCaseCbor = 'DEADBEEF';
      expect(() => getTxHashFromCbor(upperCaseCbor)).toThrow('Failed to parse transaction CBOR');
    });

    it('should accept mixed case hex characters', () => {
      mockedTx.fromCbor.mockImplementation(() => {
        throw new Error('CBOR decode error');
      });
      const mixedCaseCbor = 'DeAdBeEf1234';
      expect(() => getTxHashFromCbor(mixedCaseCbor)).toThrow('Failed to parse transaction CBOR');
    });
  });

  describe('getTxHashFromCbor (mocked)', () => {
    const mockedTx = Tx as jest.Mocked<typeof Tx>;

    afterEach(() => {
      jest.resetAllMocks();
    });

    it('should throw when tx.hash is undefined', () => {
      mockedTx.fromCbor.mockReturnValue({ body: {}, witnesses: {} } as any);

      expect(() => getTxHashFromCbor('aabbccdd'))
        .toThrow('Failed to extract transaction hash from CBOR');
    });

    it('should throw when tx.hash is null', () => {
      mockedTx.fromCbor.mockReturnValue({ hash: null } as any);

      expect(() => getTxHashFromCbor('aabbccdd'))
        .toThrow('Failed to extract transaction hash from CBOR');
    });

    it('should return hash.toString() when tx.hash exists', () => {
      const mockHash = { toString: () => 'abc123def456'.padEnd(64, '0') };
      mockedTx.fromCbor.mockReturnValue({ hash: mockHash } as any);

      const result = getTxHashFromCbor('aabbccdd');
      expect(result).toBe('abc123def456'.padEnd(64, '0'));
    });

    it('should throw when Tx.fromCbor throws', () => {
      mockedTx.fromCbor.mockImplementation(() => {
        throw new Error('CBOR decode error');
      });

      expect(() => getTxHashFromCbor('aabbccdd'))
        .toThrow('Failed to parse transaction CBOR');
    });
  });
});
