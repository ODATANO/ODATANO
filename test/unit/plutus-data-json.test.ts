// decodePlutusData is pure: no cds, no DB. The JSON it emits must be what the build actions
// accept as outputDatumJson, so every case round-trips through jsonToPlutusData to the same CBOR.

import { DataConstr, DataI, DataB, DataList, DataMap, DataPair, dataToCbor, dataFromCbor } from '@harmoniclabs/plutus-data';
import { decodePlutusData, plutusDataToJson } from '../../srv/cbor/plutus-data-json';
import { jsonToPlutusData } from '../../srv/utils/tx-build-helper';
import { TransactionValidationError } from '../../srv/utils/errors';
import { ERROR_CODES } from '../../srv/utils/error-codes';
import type { JSONValue } from '../../srv/utils/types';

const hex = (d: Parameters<typeof dataToCbor>[0]): string => Buffer.from(dataToCbor(d) as unknown as Uint8Array).toString('hex');
const roundTrip = (cborHex: string): string => hex(jsonToPlutusData(decodePlutusData(cborHex) as unknown as JSONValue));

describe('decodePlutusData', () => {
  it('emits DetailedSchema JSON: constructor/fields, int, bytes, list, map', () => {
    // a pool-style datum: Constr 0 [bytes, int, list [int, int], map {bytes: int}]
    const datum = new DataConstr(0, [
      new DataB('ab'.repeat(28)),
      new DataI(42),
      new DataList([new DataI(1), new DataI(-2)]),
      new DataMap([new DataPair(new DataB('00'), new DataI(7))]),
    ]);
    expect(decodePlutusData(hex(datum))).toEqual({
      constructor: 0,
      fields: [
        { bytes: 'ab'.repeat(28) },
        { int: 42 },
        { list: [{ int: 1 }, { int: -2 }] },
        { map: [{ k: { bytes: '00' }, v: { int: 7 } }] },
      ],
    });
  });

  it('round-trips through jsonToPlutusData to the same CBOR', () => {
    const cases = [
      new DataConstr(1, []),
      new DataConstr(7, [new DataConstr(130, [new DataI(0)])]), // tag 1280+ and the 102 fallback
      new DataB(''),
      new DataList([]),
      new DataMap([]),
      new DataI(2n ** 64n),
    ];
    for (const d of cases) expect(roundTrip(hex(d))).toBe(hex(d));
  });

  it('keeps integers beyond 2^53 exact as decimal strings, smaller ones as numbers', () => {
    expect(decodePlutusData(hex(new DataI(Number.MAX_SAFE_INTEGER)))).toEqual({ int: Number.MAX_SAFE_INTEGER });
    expect(decodePlutusData(hex(new DataI(2n ** 64n)))).toEqual({ int: '18446744073709551616' });
    expect(decodePlutusData(hex(new DataI(-(2n ** 70n))))).toEqual({ int: (-(2n ** 70n)).toString() });
  });

  it('accepts upper-case hex and surrounding whitespace', () => {
    expect(decodePlutusData(`  ${hex(new DataI(5)).toUpperCase()}\n`)).toEqual({ int: 5 });
  });

  it('rejects anything that is not PlutusData CBOR with a 400 TX_PARSE_FAILED', () => {
    for (const bad of ['zz', 'ff', 'a1', '']) {
      let caught: unknown;
      try { decodePlutusData(bad); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(TransactionValidationError);
      expect(caught).toMatchObject({ statusCode: 400, code: ERROR_CODES.TX_PARSE_FAILED });
    }
  });

  it('plutusDataToJson refuses an unknown node', () => {
    expect(() => plutusDataToJson({} as never)).toThrow(/unknown PlutusData node/);
    expect(plutusDataToJson(dataFromCbor('d87980'))).toEqual({ constructor: 0, fields: [] });
  });
});
