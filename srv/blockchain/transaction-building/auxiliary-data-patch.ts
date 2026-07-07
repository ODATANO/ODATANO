/**
 * VENDORED RUNTIME PATCH for @harmoniclabs/cardano-ledger-ts@0.5.1 —
 * `AuxiliaryData.fromCborObj` (Conway tag-259 decode).
 *
 * The shipped implementation (dist/tx/AuxiliaryData/AuxiliaryData.js:190-203) is broken
 * for EVERY Conway tag-259 auxiliary-data payload:
 *  1. it fills a 4-slot array (keys 0-3) but destructures 5 fields, so plutusV3
 *     (key 4) is never read and `_pV3` is always undefined, and
 *  2. the guard requires ALL four script collections to be present CborArrays, so even
 *     metadata-only aux data (the common case) is rejected.
 * Net effect without this patch: `Tx.fromCbor` — and with it our ParseTransactionCbor
 * action — throws "Invalid CBOR format for AuxiliaryData" for any Conway-format
 * metadata transaction.
 *
 * This module replaces the static method with the fixed implementation from our
 * upstream PR (HarmonicLabs/cardano-ledger-ts#18, fork branch
 * fix/auxiliary-data-from-cbor-optional-fields): read all 5 optional fields and only
 * validate the ones that are present. Same vendoring pattern as keep-relevant.ts.
 *
 * REMOVE once a ledger-ts release (> 0.5.1) contains the fix: bump the dependency,
 * delete this file and its side-effect import in srv/cbor/parse.ts — the enabled
 * tag-259 test in test/unit/cbor-parse.test.ts keeps guarding the behavior.
 *
 * Import paths mirror the ones the patched module uses internally (single hoisted
 * ledger-ts instance — verified — so buildooor's internal parsing benefits too).
 */
import { Cbor, CborObj, CborMap, CborArray, CborTag, CborUInt } from '@harmoniclabs/cbor';
import { AuxiliaryData } from '@harmoniclabs/cardano-ledger-ts/dist/tx/AuxiliaryData/AuxiliaryData';
import { TxMetadata } from '@harmoniclabs/cardano-ledger-ts/dist/tx/metadata/TxMetadata';
import { Script, ScriptType } from '@harmoniclabs/cardano-ledger-ts/dist/script/Script';
import { nativeScriptFromCborObj } from '@harmoniclabs/cardano-ledger-ts/dist/script/NativeScript';
import { InvalidCborFormatError } from '@harmoniclabs/cardano-ledger-ts/dist/utils/InvalidCborFormatError';

const PATCHED_MARKER = '__odatano_auxdata_patch__';

/* eslint-disable @typescript-eslint/no-explicit-any */
if (!(AuxiliaryData as any)[PATCHED_MARKER]) {
  (AuxiliaryData as any)[PATCHED_MARKER] = true;

  AuxiliaryData.fromCborObj = function fromCborObjPatched(cObj: CborObj): AuxiliaryData {
    // shelley; metadata only
    if (cObj instanceof CborMap) {
      return new AuxiliaryData({ metadata: TxMetadata.fromCborObj(cObj) });
    }

    // shelley multi assets; metadata + native scripts
    if (cObj instanceof CborArray) {
      if (!(cObj.array[1] instanceof CborArray)) throw new InvalidCborFormatError('AuxiliaryData');
      return new AuxiliaryData({
        metadata: TxMetadata.fromCborObj(cObj.array[0]),
        nativeScripts: cObj.array[1].array.map(nativeScriptFromCborObj),
      });
    }

    if (!(cObj instanceof CborTag && cObj.data instanceof CborMap)) {
      throw new InvalidCborFormatError('AuxiliaryData');
    }

    // conway (tag 259): 5 fields — 0 metadata, 1 native, 2 plutusV1, 3 plutusV2, 4 plutusV3
    const fields: (CborObj | undefined)[] = new Array(5).fill(undefined);
    for (let i = 0; i < 5; i++) {
      const { v } = cObj.data.map.find(
        ({ k }) => k instanceof CborUInt && Number(k.num) === i
      ) ?? { v: undefined };
      if (v === undefined) continue;
      fields[i] = v;
    }
    const [_metadata, _native, _pV1, _pV2, _pV3] = fields;

    // every field of conway aux data is optional; only validate the present ones
    if (!(
      (_native === undefined || _native instanceof CborArray) &&
      (_pV1 === undefined || _pV1 instanceof CborArray) &&
      (_pV2 === undefined || _pV2 instanceof CborArray) &&
      (_pV3 === undefined || _pV3 instanceof CborArray)
    )) {
      throw new InvalidCborFormatError('AuxiliaryData');
    }

    return new AuxiliaryData({
      metadata: _metadata === undefined ? undefined : TxMetadata.fromCborObj(_metadata),
      nativeScripts: _native === undefined ? undefined :
        _native.array.map((nativeCborObj: CborObj) =>
          new Script(ScriptType.NativeScript, Cbor.encode(nativeCborObj))),
      plutusV1Scripts: _pV1 === undefined ? undefined :
        _pV1.array.map((cbor: CborObj) => Script.plutusV1(Cbor.encode(cbor))),
      plutusV2Scripts: _pV2 === undefined ? undefined :
        _pV2.array.map((cbor: CborObj) => Script.plutusV2(Cbor.encode(cbor))),
      plutusV3Scripts: _pV3 === undefined ? undefined :
        _pV3.array.map((cbor: CborObj) => Script.plutusV3(Cbor.encode(cbor))),
    });
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export {};
