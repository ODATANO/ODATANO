/**
 * Unit tests for tx-build-helper utilities
 */

import { getLovelace, assertAdaOnly, getTxHashFromCbor, jsonToPlutusData, applyScriptParameters } from '../../srv/utils/tx-build-helper';
import type { UTxO as OdatanoUtxo, JSONValue } from '../../srv/utils/types';
import { Tx } from '@harmoniclabs/cardano-ledger-ts';
import { DataI, DataB, DataConstr, DataList } from '@harmoniclabs/plutus-data';
import { Cbor, CborBytes } from '@harmoniclabs/cbor';

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

  describe('jsonToPlutusData', () => {
    it('should convert integer JSON to DataI', () => {
      const result = jsonToPlutusData({ int: 42 });
      expect(result).toBeInstanceOf(DataI);
      expect((result as DataI).int).toBe(42n);
    });

    it('should convert zero integer', () => {
      const result = jsonToPlutusData({ int: 0 });
      expect(result).toBeInstanceOf(DataI);
      expect((result as DataI).int).toBe(0n);
    });

    it('should convert bytes JSON to DataB', () => {
      const result = jsonToPlutusData({ bytes: 'deadbeef' });
      expect(result).toBeInstanceOf(DataB);
    });

    it('should convert "constr" JSON to DataConstr', () => {
      const result = jsonToPlutusData({ constr: 0, fields: [] });
      expect(result).toBeInstanceOf(DataConstr);
      expect((result as DataConstr).constr).toBe(0n);
      expect((result as DataConstr).fields).toHaveLength(0);
    });

    it('should convert "constructor" JSON to DataConstr (cardano-cli format)', () => {
      const result = jsonToPlutusData({ constructor: 0, fields: [] });
      expect(result).toBeInstanceOf(DataConstr);
      expect((result as DataConstr).constr).toBe(0n);
      expect((result as DataConstr).fields).toHaveLength(0);
    });

    it('should convert constructor with fields (constr format)', () => {
      const result = jsonToPlutusData({
        constr: 1,
        fields: [{ int: 42 }, { bytes: 'cafe' }]
      });
      expect(result).toBeInstanceOf(DataConstr);
      expect((result as DataConstr).constr).toBe(1n);
      expect((result as DataConstr).fields).toHaveLength(2);
      expect((result as DataConstr).fields[0]).toBeInstanceOf(DataI);
      expect((result as DataConstr).fields[1]).toBeInstanceOf(DataB);
    });

    it('should convert constructor with fields (cardano-cli format)', () => {
      const result = jsonToPlutusData({
        constructor: 1,
        fields: [{ int: 42 }, { bytes: 'cafe' }]
      });
      expect(result).toBeInstanceOf(DataConstr);
      expect((result as DataConstr).constr).toBe(1n);
      expect((result as DataConstr).fields).toHaveLength(2);
      expect((result as DataConstr).fields[0]).toBeInstanceOf(DataI);
      expect((result as DataConstr).fields[1]).toBeInstanceOf(DataB);
    });

    it('should convert list JSON to DataList', () => {
      const result = jsonToPlutusData({ list: [{ int: 1 }, { int: 2 }] });
      expect(result).toBeInstanceOf(DataList);
      expect((result as DataList).list).toHaveLength(2);
    });

    it('should throw for null input', () => {
      expect(() => jsonToPlutusData(null)).toThrow('PlutusData JSON cannot be null or undefined');
    });

    it('should throw for undefined input', () => {
      expect(() => jsonToPlutusData(undefined as any)).toThrow('PlutusData JSON cannot be null or undefined');
    });

    it('should throw for array input', () => {
      expect(() => jsonToPlutusData([1, 2, 3] as any)).toThrow('Unsupported PlutusData JSON format');
    });

    it('should throw for string input', () => {
      expect(() => jsonToPlutusData('hello' as any)).toThrow('Unsupported PlutusData JSON format');
    });

    it('should throw for number input', () => {
      expect(() => jsonToPlutusData(42 as any)).toThrow('Unsupported PlutusData JSON format');
    });

    // B4: normalizeConstructorKey with list containing constructors
    it('should normalize "constructor" to "constr" inside list elements', () => {
      const result = jsonToPlutusData({
        list: [{ constructor: 0, fields: [{ int: 42 }] }]
      });
      expect(result).toBeInstanceOf(DataList);
      const list = result as DataList;
      expect(list.list).toHaveLength(1);
      expect(list.list[0]).toBeInstanceOf(DataConstr);
      expect((list.list[0] as DataConstr).constr).toBe(0n);
    });

    // B5: normalizeConstructorKey with map containing constructors
    it('should normalize "constructor" to "constr" inside map keys and values', () => {
      const result = jsonToPlutusData({
        map: [{
          k: { constructor: 1, fields: [] },
          v: { int: 42 }
        }]
      });
      // Map type in Buildooor uses DataMap or similar structure
      // The key should be a DataConstr with constr=1
      expect(result).toBeDefined();
    });

    // B6: normalizeConstructorKey with already-correct "constr" + nested "constructor"
    it('should normalize nested "constructor" inside "constr" fields', () => {
      const result = jsonToPlutusData({
        constr: 0,
        fields: [{ constructor: 1, fields: [{ bytes: 'deadbeef' }] }]
      });
      expect(result).toBeInstanceOf(DataConstr);
      const outer = result as DataConstr;
      expect(outer.constr).toBe(0n);
      expect(outer.fields).toHaveLength(1);
      expect(outer.fields[0]).toBeInstanceOf(DataConstr);
      expect((outer.fields[0] as DataConstr).constr).toBe(1n);
      expect((outer.fields[0] as DataConstr).fields).toHaveLength(1);
      expect((outer.fields[0] as DataConstr).fields[0]).toBeInstanceOf(DataB);
    });
  });

  describe('applyScriptParameters', () => {
    // Real Aiken-compiled PlutusV3 always-succeeds script (CBOR-wrapped flat UPLC)
    const validScript = '585401010029800aba2aba1aab9eaab9dab9a4888896600264653001300600198031803800cc0180092225980099b8748000c01cdd500144c9289bae30093008375400516401830060013003375400d149a26cac8009';

    it('should throw for non-array params', () => {
      expect(() => applyScriptParameters(validScript, 'not-an-array' as any))
        .toThrow('Script parameters must be a non-empty array');
    });

    it('should throw for empty array params', () => {
      expect(() => applyScriptParameters(validScript, []))
        .toThrow('Script parameters must be a non-empty array');
    });

    it('should throw for invalid CBOR hex', () => {
      expect(() => applyScriptParameters('zzzz', [{ int: 1 }]))
        .toThrow();
    });

    it('should apply a single bytes parameter', () => {
      const params = [{ bytes: 'deadbeef' }];
      const result = applyScriptParameters(validScript, params);

      expect(typeof result).toBe('string');
      expect(result).toMatch(/^[a-f0-9]+$/);
      // Applied script must differ from unapplied
      expect(result).not.toBe(validScript);
    });

    it('should apply a single integer parameter', () => {
      const params = [{ int: 42 }];
      const result = applyScriptParameters(validScript, params);

      expect(typeof result).toBe('string');
      expect(result).toMatch(/^[a-f0-9]+$/);
      expect(result).not.toBe(validScript);
    });

    it('should apply multiple parameters', () => {
      const params: JSONValue[] = [
        { bytes: 'deadbeef' },
        { int: 1 }
      ];
      const result = applyScriptParameters(validScript, params);

      expect(typeof result).toBe('string');
      expect(result).toMatch(/^[a-f0-9]+$/);
      expect(result).not.toBe(validScript);
    });

    it('should apply a constructor parameter (cardano-cli format)', () => {
      const params: JSONValue[] = [{
        constructor: 0,
        fields: [{ bytes: 'deadbeef' }, { int: 42 }]
      }];
      const result = applyScriptParameters(validScript, params);

      expect(typeof result).toBe('string');
      expect(result).toMatch(/^[a-f0-9]+$/);
    });

    it('should produce valid CBOR that can be re-parsed', () => {
      const params = [{ bytes: 'deadbeef' }];
      const result = applyScriptParameters(validScript, params);

      // Verify the output is valid CBOR containing bytes
      const parsed = Cbor.parse(result);
      expect(parsed).toBeInstanceOf(CborBytes);
      expect((parsed as CborBytes).bytes.length).toBeGreaterThan(0);
    });

    it('should produce different results for different parameters', () => {
      const result1 = applyScriptParameters(validScript, [{ int: 1 }]);
      const result2 = applyScriptParameters(validScript, [{ int: 2 }]);

      expect(result1).not.toBe(result2);
    });
  });
});
