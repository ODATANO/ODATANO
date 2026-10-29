// CIP-68 helpers (srv/cbor/cip68.ts): label arithmetic on units and `decimals` out of a reference datum.

import { DataConstr, DataMap, DataPair, DataB, DataI, DataList, dataToCbor } from '@harmoniclabs/plutus-data';
import { CIP68_LABEL, cip68ReferenceUnit, cip68UserUnits, cip68DecimalsFromDatum } from '../../srv/cbor/cip68';

const POLICY = 'b2'.repeat(28);
const NAME = Buffer.from('INDY').toString('hex');
const REF = POLICY + CIP68_LABEL.reference + NAME;
const FT = POLICY + CIP68_LABEL.ft + NAME;
const RFT = POLICY + CIP68_LABEL.rft + NAME;
const NFT = POLICY + CIP68_LABEL.nft + NAME;

const hex = (d: Parameters<typeof dataToCbor>[0]): string => Buffer.from(dataToCbor(d) as unknown as Uint8Array).toString('hex');
const key = (s: string) => new DataB(Buffer.from(s).toString('hex'));
const referenceDatum = (entries: ConstructorParameters<typeof DataMap>[0], version = 1) => hex(new DataConstr(0, [new DataMap(entries), new DataI(version)]));

describe('cip68ReferenceUnit / cip68UserUnits', () => {
  it('maps a label-333 or label-444 unit to its reference NFT and back', () => {
    expect(cip68ReferenceUnit(FT)).toBe(REF);
    expect(cip68ReferenceUnit(RFT)).toBe(REF);
    expect(cip68UserUnits(REF)).toEqual([FT, RFT]);
  });

  it('knows no reference for NFTs, plain units, a policy alone or a label-less short name', () => {
    expect(cip68ReferenceUnit(NFT)).toBeNull();
    expect(cip68ReferenceUnit(REF)).toBeNull();
    expect(cip68ReferenceUnit(POLICY + NAME)).toBeNull();
    expect(cip68ReferenceUnit(POLICY)).toBeNull();
    expect(cip68ReferenceUnit(POLICY + '0014df')).toBeNull();
    expect(cip68UserUnits(FT)).toBeNull();
    expect(cip68UserUnits(POLICY)).toBeNull();
  });

  it('keeps an empty name after the label', () => {
    expect(cip68ReferenceUnit(POLICY + CIP68_LABEL.ft)).toBe(POLICY + CIP68_LABEL.reference);
    expect(cip68UserUnits(POLICY + CIP68_LABEL.reference)).toEqual([POLICY + CIP68_LABEL.ft, POLICY + CIP68_LABEL.rft]);
  });
});

describe('cip68DecimalsFromDatum', () => {
  it('reads the decimals integer out of the metadata map, whatever else it holds', () => {
    const datum = referenceDatum([
      new DataPair(key('name'), key('Indigo')),
      new DataPair(key('decimals'), new DataI(6)),
      new DataPair(key('ticker'), key('INDY')),
    ], 2);
    expect(cip68DecimalsFromDatum(datum)).toBe(6);
    expect(cip68DecimalsFromDatum(referenceDatum([new DataPair(key('decimals'), new DataI(0))]))).toBe(0);
  });

  it('answers null when decimals are absent, not an integer, out of range or the datum has another shape', () => {
    expect(cip68DecimalsFromDatum(referenceDatum([new DataPair(key('name'), key('x'))]))).toBeNull();
    expect(cip68DecimalsFromDatum(referenceDatum([new DataPair(key('decimals'), key('6'))]))).toBeNull();
    expect(cip68DecimalsFromDatum(referenceDatum([new DataPair(key('decimals'), new DataI(256))]))).toBeNull();
    expect(cip68DecimalsFromDatum(referenceDatum([new DataPair(key('decimals'), new DataI(-1))]))).toBeNull();
    // Constr 1, a list instead of the map, a bare integer, not CBOR at all
    expect(cip68DecimalsFromDatum(hex(new DataConstr(1, [new DataMap([new DataPair(key('decimals'), new DataI(6))])])))).toBeNull();
    expect(cip68DecimalsFromDatum(hex(new DataConstr(0, [new DataList([new DataI(6)])])))).toBeNull();
    expect(cip68DecimalsFromDatum(hex(new DataI(6)))).toBeNull();
    expect(cip68DecimalsFromDatum('zz')).toBeNull();
    expect(cip68DecimalsFromDatum('')).toBeNull();
  });
});
