import { BuildooorTxBuilder } from '../../srv/blockchain/transaction-building/buildooor-tx';
import { TxMetadata } from '@harmoniclabs/cardano-ledger-ts/dist/tx/metadata/TxMetadata';
import { TxMetadatumInt, TxMetadatumText, TxMetadatumList, TxMetadatumMap } from '@harmoniclabs/cardano-ledger-ts/dist/tx/metadata/TxMetadatum';

describe('BuildooorTxBuilder', () => {
  let builder: BuildooorTxBuilder;

  beforeEach(() => {
    builder = new BuildooorTxBuilder();
  });

  describe('_mapOdatanoMetadataToLedgerMetadata', () => {
    const mapMetadata = (value: any) =>
      (builder as any)._mapOdatanoMetadataToLedgerMetadata(value);

    it('should return empty TxMetadata for undefined', () => {
      const result = mapMetadata(undefined);
      expect(result).toBeInstanceOf(TxMetadata);
    });

    it('should return empty TxMetadata for null', () => {
      const result = mapMetadata(null);
      expect(result).toBeInstanceOf(TxMetadata);
    });

    it('should map numeric label with string value', () => {
      const result = mapMetadata({ '721': 'hello' });
      expect(result).toBeInstanceOf(TxMetadata);
    });

    it('should map numeric label with number value', () => {
      const result = mapMetadata({ '1': 42 });
      expect(result).toBeInstanceOf(TxMetadata);
    });

    it('should map multiple labels', () => {
      const result = mapMetadata({ '721': 'nft-data', '1': 100 });
      expect(result).toBeInstanceOf(TxMetadata);
    });
  });

  describe('_jsonToTxMetadatum', () => {
    const toMetadatum = (value: any) =>
      (builder as any)._jsonToTxMetadatum(value);

    it('should convert number to TxMetadatumInt', () => {
      const result = toMetadatum(42);
      expect(result).toBeInstanceOf(TxMetadatumInt);
    });

    it('should convert string to TxMetadatumText', () => {
      const result = toMetadatum('hello');
      expect(result).toBeInstanceOf(TxMetadatumText);
    });

    it('should convert array to TxMetadatumList', () => {
      const result = toMetadatum([1, 'two', 3]);
      expect(result).toBeInstanceOf(TxMetadatumList);
    });

    it('should convert object to TxMetadatumMap', () => {
      const result = toMetadatum({ key: 'value' });
      expect(result).toBeInstanceOf(TxMetadatumMap);
    });

    it('should throw on unsupported type (boolean)', () => {
      expect(() => toMetadatum(true)).toThrow('Unsupported metadata value type');
    });
  });
});
