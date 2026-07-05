/**
 * Unit tests for tx-build-helper utilities
 */

import { getLovelace, assertAdaOnly, getTxHashFromCbor, extractTxCacheTargets, jsonToPlutusData, applyScriptParameters, mapBuilderError, inlineDatumToHex } from '../../srv/utils/tx-build-helper';
import type { UTxO as OdatanoUtxo, JSONValue } from '../../srv/utils/types';
import { DataI, DataB, DataConstr, DataList } from '@harmoniclabs/plutus-data';
import { Cbor, CborBytes, CborArray, CborMap, CborUInt, CborTag } from '@harmoniclabs/cbor';
import { Address } from '@harmoniclabs/cardano-ledger-ts';

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
    // Valid tx CBOR (minimal Conway ADA transfer, metadata-only aux_data). The hash is computed
    // from the raw CBOR body bytes (array index 0), so this also doubles as the regression fixture
    // for the harmoniclabs AuxiliaryData.fromCbor bug that rejected metadata-only aux_data (see new_error.md).
    const VALID_UNSIGNED_TX_CBOR = '84a400818258202db5788ec32bc0fdd0bc308b4787dba2d2dd4930bec4025360647fed6d35bccb010182a200583900d090525914fb9bcd35141eaff7b054b9ce105f154ebb73347ff9c7415318a7bcc399479a382e00ef73306801c4d8064df6cc20d2a5ca7189011a00989680a200581d60374610273097b313fade06a30e90c5fb2640074ca0744ce850b8f0a101821b000000023f09f49ca1581cdef68337867cb4f1f95b6b811fedbfcdd7780d10a95cc072077088eaa146546f6b656e4d1909c4021a000294c10f00a0f5f6';

    it('should throw for empty string input', () => {
      expect(() => getTxHashFromCbor('')).toThrow('Invalid input: txCbor must be a non-empty string');
    });

    it('should throw for null input', () => {
      expect(() => getTxHashFromCbor(null as any)).toThrow('Invalid input: txCbor must be a non-empty string');
    });

    it('should throw for undefined input', () => {
      expect(() => getTxHashFromCbor(undefined as any)).toThrow('Invalid input: txCbor must be a non-empty string');
    });

    it('should throw for non-string input', () => {
      expect(() => getTxHashFromCbor(12345 as any)).toThrow('Invalid input: txCbor must be a non-empty string');
    });

    it('should throw for non-hex string', () => {
      expect(() => getTxHashFromCbor('not-a-hex-string!')).toThrow('Invalid input: txCbor must be a valid hex string');
    });

    it('should throw for string with non-hex characters', () => {
      expect(() => getTxHashFromCbor('abcdefgh12345678')).toThrow('Invalid input: txCbor must be a valid hex string');
    });

    it('should throw a typed 400 (TX_PARSE_FAILED) for valid hex that is not a transaction', () => {
      const { TransactionValidationError } = require('../../srv/utils/errors');
      const { ERROR_CODES } = require('../../srv/utils/error-codes');
      try {
        getTxHashFromCbor('deadbeef'); // parses as CBOR garbage, not a tx array
        fail('expected throw');
      } catch (err: any) {
        // previously a plain Error → surfaced as 500 to the consumer
        expect(err).toBeInstanceOf(TransactionValidationError);
        expect(err.statusCode).toBe(400);
        expect(err.code).toBe(ERROR_CODES.TX_PARSE_FAILED);
      }
    });

    it('should throw for malformed CBOR (valid hex but invalid structure)', () => {
      expect(() => getTxHashFromCbor('deadbeef')).toThrow('Failed to parse transaction CBOR');
    });

    it('should return 64-character lowercase hex hash for valid transaction CBOR', () => {
      const hash = getTxHashFromCbor(VALID_UNSIGNED_TX_CBOR);
      expect(typeof hash).toBe('string');
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should be deterministic across repeated calls', () => {
      const hash1 = getTxHashFromCbor(VALID_UNSIGNED_TX_CBOR);
      const hash2 = getTxHashFromCbor(VALID_UNSIGNED_TX_CBOR);
      expect(hash1).toBe(hash2);
    });

    it('should accept uppercase hex by normalizing through Buffer.from', () => {
      const upperHash = getTxHashFromCbor(VALID_UNSIGNED_TX_CBOR.toUpperCase());
      const lowerHash = getTxHashFromCbor(VALID_UNSIGNED_TX_CBOR);
      expect(upperHash).toBe(lowerHash);
    });
  });

  describe('extractTxCacheTargets', () => {
    // Same minimal Conway ADA transfer as the getTxHashFromCbor fixture:
    // 1 input (…bccb#1), 2 map-form outputs (base + enterprise testnet address).
    const VALID_UNSIGNED_TX_CBOR = '84a400818258202db5788ec32bc0fdd0bc308b4787dba2d2dd4930bec4025360647fed6d35bccb010182a200583900d090525914fb9bcd35141eaff7b054b9ce105f154ebb73347ff9c7415318a7bcc399479a382e00ef73306801c4d8064df6cc20d2a5ca7189011a00989680a200581d60374610273097b313fade06a30e90c5fb2640074ca0744ce850b8f0a101821b000000023f09f49ca1581cdef68337867cb4f1f95b6b811fedbfcdd7780d10a95cc072077088eaa146546f6b656e4d1909c4021a000294c10f00a0f5f6';
    const TEST_ADDRESS = 'addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp';

    const inputRef = (txHash: string, index: number) =>
      new CborArray([new CborBytes(Buffer.from(txHash, 'hex')), new CborUInt(index)]);
    const mapOutput = (addressBytes: Uint8Array) =>
      new CborMap([{ k: new CborUInt(0), v: new CborBytes(addressBytes) }]);
    const txCborHex = (bodyEntries: Array<{ k: CborUInt; v: any }>) =>
      Buffer.from(Cbor.encode(new CborArray([new CborMap(bodyEntries), new CborMap([])]))).toString('hex');

    it('extracts input refs and distinct output addresses from a real Conway tx', () => {
      const targets = extractTxCacheTargets(VALID_UNSIGNED_TX_CBOR);
      expect(targets.inputs).toEqual([
        { txHash: '2db5788ec32bc0fdd0bc308b4787dba2d2dd4930bec4025360647fed6d35bccb', outputIndex: 1 }
      ]);
      expect(targets.outputAddresses.length).toBe(2);
      for (const addr of targets.outputAddresses) {
        expect(addr).toMatch(/^addr_test1/);
      }
      expect(new Set(targets.outputAddresses).size).toBe(2);
    });

    it('handles the Conway tag-258 input set and dedups repeated output addresses', () => {
      const addrBytes = Address.fromString(TEST_ADDRESS).toBuffer();
      const cbor = txCborHex([
        { k: new CborUInt(0), v: new CborTag(258, new CborArray([inputRef('ab'.repeat(32), 0), inputRef('cd'.repeat(32), 3)])) },
        { k: new CborUInt(1), v: new CborArray([mapOutput(addrBytes), mapOutput(addrBytes)]) },
      ]);
      const targets = extractTxCacheTargets(cbor);
      expect(targets.inputs).toEqual([
        { txHash: 'ab'.repeat(32), outputIndex: 0 },
        { txHash: 'cd'.repeat(32), outputIndex: 3 },
      ]);
      expect(targets.outputAddresses).toEqual([TEST_ADDRESS]);
    });

    it('handles legacy array-form outputs', () => {
      const addrBytes = Address.fromString(TEST_ADDRESS).toBuffer();
      const legacyOutput = new CborArray([new CborBytes(addrBytes), new CborUInt(1_000_000)]);
      const cbor = txCborHex([
        { k: new CborUInt(0), v: new CborArray([inputRef('ab'.repeat(32), 0)]) },
        { k: new CborUInt(1), v: new CborArray([legacyOutput]) },
      ]);
      expect(extractTxCacheTargets(cbor).outputAddresses).toEqual([TEST_ADDRESS]);
    });

    it('skips outputs whose address bytes cannot be decoded', () => {
      const cbor = txCborHex([
        { k: new CborUInt(0), v: new CborArray([inputRef('ab'.repeat(32), 0)]) },
        { k: new CborUInt(1), v: new CborArray([mapOutput(Uint8Array.from([0xff, 0x00]))]) },
      ]);
      const targets = extractTxCacheTargets(cbor);
      expect(targets.outputAddresses).toEqual([]);
      expect(targets.inputs.length).toBe(1); // inputs still extracted
    });

    it('throws a typed 400 for CBOR that is not a transaction', () => {
      const { TransactionValidationError } = require('../../srv/utils/errors');
      expect(() => extractTxCacheTargets('deadbeef')).toThrow(TransactionValidationError);
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

    // --- typed (native) parameters: { uplc, value } ---

    it('should treat a bare PlutusData object as { uplc: "data" } (byte-identical)', () => {
      const bare = applyScriptParameters(validScript, [{ bytes: 'deadbeef' }]);
      const typed = applyScriptParameters(validScript, [{ uplc: 'data', value: { bytes: 'deadbeef' } }]);
      expect(typed).toBe(bare);
    });

    it('should apply a NATIVE bytestring param distinctly from a Data-wrapped one', () => {
      const asData = applyScriptParameters(validScript, [{ uplc: 'data', value: { bytes: 'deadbeef' } }]);
      const asNative = applyScriptParameters(validScript, [{ uplc: 'bytes', value: 'deadbeef' }]);
      expect(asNative).toMatch(/^[a-f0-9]+$/);
      // native bytestring != Data-wrapped bytestring -> different applied script
      expect(asNative).not.toBe(asData);
    });

    it('should apply a NATIVE integer param distinctly from a Data-wrapped one', () => {
      const asData = applyScriptParameters(validScript, [{ uplc: 'data', value: { int: 42 } }]);
      const asNative = applyScriptParameters(validScript, [{ uplc: 'int', value: 42 }]);
      expect(asNative).not.toBe(asData);
    });

    it('should accept a numeric-string value for a native int param', () => {
      const fromNum = applyScriptParameters(validScript, [{ uplc: 'int', value: 7 }]);
      const fromStr = applyScriptParameters(validScript, [{ uplc: 'int', value: '7' }]);
      expect(fromStr).toBe(fromNum);
    });

    it('should apply native bool and unit params', () => {
      expect(applyScriptParameters(validScript, [{ uplc: 'bool', value: true }])).toMatch(/^[a-f0-9]+$/);
      expect(applyScriptParameters(validScript, [{ uplc: 'unit' }])).toMatch(/^[a-f0-9]+$/);
    });

    it('should apply mixed native + data params in order (e.g. Pebble: native VKH + Data TxOutRef)', () => {
      const params: JSONValue[] = [
        { uplc: 'bytes', value: 'aa'.repeat(28) },                                  // PubKeyHash -> native
        { uplc: 'data', value: { constructor: 0, fields: [{ bytes: 'bb'.repeat(32) }, { int: 0 }] } }, // TxOutRef -> Data
      ];
      const result = applyScriptParameters(validScript, params);
      expect(result).toMatch(/^[a-f0-9]+$/);
      expect(result).not.toBe(validScript);
    });

    it('should throw for an unknown uplc type', () => {
      expect(() => applyScriptParameters(validScript, [{ uplc: 'list', value: [] } as any]))
        .toThrow('Unknown script param uplc type');
    });

    it('should throw for a native bytes param with a non-hex value', () => {
      expect(() => applyScriptParameters(validScript, [{ uplc: 'bytes', value: 'nothex' } as any]))
        .toThrow('even-length hex string');
    });

    it('should throw for a native int param with a non-numeric value', () => {
      expect(() => applyScriptParameters(validScript, [{ uplc: 'int', value: 'abc' } as any]))
        .toThrow('non-integer');
    });

    it('should throw for a native bool param with a non-boolean value', () => {
      expect(() => applyScriptParameters(validScript, [{ uplc: 'bool', value: 'yes' } as any]))
        .toThrow('requires a boolean');
    });
  });

  describe('mapBuilderError', () => {
    it('should throw InsufficientFundsError for "not enough" messages', () => {
      expect(() => mapBuilderError(new Error('not enough lovelace'))).toThrow('Insufficient');
    });

    it('should surface the builder message instead of "required 0, available 0"', () => {
      expect(() => mapBuilderError(new Error('not enough lovelace; missing 3210000')))
        .toThrow('Insufficient lovelace: not enough lovelace; missing 3210000');
      expect(() => mapBuilderError(new Error('not enough lovelace')))
        .not.toThrow('required 0, available 0');
    });

    it('should append the build-flow context when provided', () => {
      expect(() => mapBuilderError(new Error('not enough lovelace'), undefined,
        '1 UTxO(s) with 5000000 lovelace reserved as collateral; 0 UTxO(s) with 0 lovelace remained for coin selection'))
        .toThrow(/not enough lovelace \(1 UTxO\(s\) with 5000000 lovelace reserved as collateral/);
    });

    it('should throw InsufficientFundsError for "insufficient" messages', () => {
      expect(() => mapBuilderError(new Error('insufficient funds for transaction'))).toThrow('Insufficient');
    });

    it('should throw InsufficientFundsError for "balance" messages', () => {
      expect(() => mapBuilderError(new Error('negative balance'))).toThrow('Insufficient');
    });

    it('should re-throw original error for non-funds errors', () => {
      const originalError = new Error('network timeout');
      expect(() => mapBuilderError(originalError)).toThrow(originalError);
    });

    it('should pass already-typed errors through unchanged (payload preserved)', () => {
      const { InsufficientFundsError, TransactionValidationError } = require('../../srv/utils/errors');
      // a typed InsufficientFundsError with REAL amounts — re-wrapping would zero them
      const typedFunds = new InsufficientFundsError('lovelace', 5_000_000n, 2_000_000n);
      try {
        mapBuilderError(typedFunds);
        fail('expected throw');
      } catch (err) {
        expect(err).toBe(typedFunds); // same instance, not a re-wrapped copy
      }

      // a validation error whose message merely CONTAINS a funds keyword
      const typedValidation = new TransactionValidationError('script consumed full balance budget');
      try {
        mapBuilderError(typedValidation);
        fail('expected throw');
      } catch (err) {
        expect(err).toBe(typedValidation);
      }
    });
  });

  describe('inlineDatumToHex', () => {
    it('returns null for null/undefined', () => {
      expect(inlineDatumToHex(null)).toBeNull();
      expect(inlineDatumToHex(undefined)).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(inlineDatumToHex('')).toBeNull();
      expect(inlineDatumToHex('   ')).toBeNull();
    });

    it('passes through hex CBOR string lowercased', () => {
      expect(inlineDatumToHex('19A6AA')).toBe('19a6aa');
      expect(inlineDatumToHex('d8799fff')).toBe('d8799fff');
    });

    it('returns null for non-hex string (defensive)', () => {
      expect(inlineDatumToHex('not-hex')).toBeNull();
      // odd-length hex is not valid CBOR
      expect(inlineDatumToHex('abc')).toBeNull();
    });

    it('extracts bytes from Koios _extended wrapper', () => {
      const wrapper = { bytes: '19a6aa', value: { int: 42 } };
      expect(inlineDatumToHex(wrapper)).toBe('19a6aa');
    });

    it('lowercases hex in Koios wrapper', () => {
      const wrapper = { bytes: 'D8799FFF', value: null };
      expect(inlineDatumToHex(wrapper)).toBe('d8799fff');
    });

    it('returns null for empty Koios wrapper {bytes:null,value:null}', () => {
      expect(inlineDatumToHex({ bytes: null, value: null })).toBeNull();
    });

    it('encodes raw PlutusData JSON (DetailedSchema int) to CBOR hex', () => {
      const result = inlineDatumToHex({ int: 42 });
      expect(result).toMatch(/^[0-9a-f]+$/);
      expect(result!.length % 2).toBe(0);
      // Round-trip: re-encoding from hex (Blockfrost-shape) should yield the same hex
      expect(inlineDatumToHex(result!)).toBe(result);
    });

    it('encodes raw PlutusData JSON (constructor form) to CBOR hex', () => {
      const result = inlineDatumToHex({ constructor: 0, fields: [] });
      expect(result).toMatch(/^[0-9a-f]+$/);
      expect(result!.length % 2).toBe(0);
    });

    it('encodes Buildooor "constr" form to the same CBOR as "constructor"', () => {
      const fromCli = inlineDatumToHex({ constructor: 0, fields: [] });
      const fromBuildooor = inlineDatumToHex({ constr: 0, fields: [] });
      expect(fromBuildooor).toBe(fromCli);
    });

    it('returns null for unparseable object (defensive, no throw)', () => {
      expect(inlineDatumToHex({ random: 'garbage' })).toBeNull();
      expect(inlineDatumToHex({})).toBeNull();
    });

    it('returns null for arrays (top-level not valid PlutusData JSON)', () => {
      expect(inlineDatumToHex([1, 2, 3])).toBeNull();
    });
  });
});
