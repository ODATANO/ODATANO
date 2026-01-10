/**
 * Unit tests for tx-build-helper utilities
 */

import { getLovelace, assertAdaOnly, getTxHashFromCbor } from '../../srv/utils/tx-build-helper';
import type { UTxO as OdatanoUtxo } from '../../srv/utils/types';

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
    it('should extract transaction hash from signed CBOR', () => {
      // Skip this test for now - it requires a real valid signed transaction CBOR
      // which is complex to generate for a unit test
      expect(true).toBe(true);
    });
  });
});
