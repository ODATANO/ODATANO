import { dataFromCbor, DataConstr, DataI, DataB, DataList, DataMap, type Data } from '@harmoniclabs/plutus-data';
import { TransactionValidationError } from '../utils/errors';
import { ERROR_CODES } from '../utils/error-codes';

/**
 * PlutusData as cardano-cli DetailedSchema JSON, the shape the build actions accept as
 * outputDatumJson. Integers beyond the safe JS range are decimal strings so no digit is lost.
 */
export type PlutusDataJson =
  | { constructor: number; fields: PlutusDataJson[] }
  | { int: number | string }
  | { bytes: string }
  | { list: PlutusDataJson[] }
  | { map: { k: PlutusDataJson; v: PlutusDataJson }[] };

export function plutusDataToJson(data: Data): PlutusDataJson {
  if (data instanceof DataConstr) return { constructor: Number(data.constr), fields: data.fields.map(plutusDataToJson) };
  if (data instanceof DataI) {
    const i = data.int;
    return { int: i >= BigInt(Number.MIN_SAFE_INTEGER) && i <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(i) : i.toString() };
  }
  if (data instanceof DataB) return { bytes: Buffer.from(data.bytes).toString('hex') };
  if (data instanceof DataList) return { list: data.list.map(plutusDataToJson) };
  if (data instanceof DataMap) return { map: data.map.map((kv) => ({ k: plutusDataToJson(kv.fst), v: plutusDataToJson(kv.snd) })) };
  throw new TypeError('unknown PlutusData node');
}

/** @throws TransactionValidationError (`TX_PARSE_FAILED`) when the hex is not PlutusData CBOR. */
export function decodePlutusData(cborHex: string): PlutusDataJson {
  try {
    return plutusDataToJson(dataFromCbor(cborHex.trim().toLowerCase()));
  } catch (err) {
    throw new TransactionValidationError(
      `Not PlutusData CBOR: ${err instanceof Error ? err.message : String(err)}`,
      err,
      ERROR_CODES.TX_PARSE_FAILED,
    );
  }
}
