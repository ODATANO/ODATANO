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
 * The direct dependency is deliberately pinned to 0.5.1 while this patch is needed.
 * At runtime we additionally verify both the affected version and the broken decoder
 * feature before touching the global class. REMOVE once a later ledger-ts release
 * contains the fix: bump the dependency, delete this file and its side-effect import
 * in srv/cbor/parse.ts — the tag-259 test keeps guarding the behavior.
 *
 * Public exports are used wherever they preserve class identity. Private modules
 * are loaded lazily only inside the affected-version branch because ledger-ts 0.5.1's
 * public TxMetadata export is a different class from the one AuxiliaryData expects.
 */
import { Cbor, CborObj, CborMap, CborArray, CborTag, CborUInt } from '@harmoniclabs/cbor';
import {
  AuxiliaryData,
  Script,
  ScriptType,
  nativeScriptFromCborObj,
} from '@harmoniclabs/cardano-ledger-ts';
import ledgerPackageJson from '@harmoniclabs/cardano-ledger-ts/package.json';

const PATCHED_MARKER = '__odatano_auxdata_patch__';
const AFFECTED_LEDGER_VERSION = '0.5.1';

function hasBrokenConwayDecoder(): boolean {
  // Conway tag 259 containing metadata key 0 with an empty metadata map. All script
  // fields are optional; 0.5.1 incorrectly rejects this unless all four are present.
  const metadataOnlyAuxData = Cbor.parse(Buffer.from('d90103a100a0', 'hex'));
  try {
    AuxiliaryData.fromCborObj(metadataOnlyAuxData);
    return false;
  } catch {
    return true;
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
if (
  ledgerPackageJson.version === AFFECTED_LEDGER_VERSION
  && !(AuxiliaryData as any)[PATCHED_MARKER]
  && hasBrokenConwayDecoder()
) {
  // Lazy private imports: these paths are never resolved after the dependency is
  // upgraded past the affected release and the patch becomes a no-op.
  const { TxMetadata } = require(
    '@harmoniclabs/cardano-ledger-ts/dist/tx/metadata/TxMetadata'
  ) as { TxMetadata: { fromCborObj(cObj: CborObj): any } };
  const { InvalidCborFormatError } = require(
    '@harmoniclabs/cardano-ledger-ts/dist/utils/InvalidCborFormatError'
  ) as { InvalidCborFormatError: new (subject: string) => Error };
  const { getSubCborRef } = require(
    '@harmoniclabs/cardano-ledger-ts/dist/utils/getSubCborRef'
  ) as { getSubCborRef(cObj: CborObj): any };

  (AuxiliaryData as any)[PATCHED_MARKER] = AFFECTED_LEDGER_VERSION;

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

    return new AuxiliaryData(
      {
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
      },
      getSubCborRef(cObj),
    );
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export {};
