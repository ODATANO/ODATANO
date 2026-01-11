import {
  isTxHash,
  isAssetUnit,
  isBlockHash,
  isValidPoolId,
  isValidDrepId,
  isValidBech32Address,
  isValidBech32StakeAddress,
  isEpochNumber,
  isValidCbor,
} from '../../srv/utils/validators';

describe('Validator Helper Methods and Type Guards', () => {

  // ==========================================================================
  // isTxHash
  // ==========================================================================
  describe('isTxHash', () => {
    it('should return true for valid 64-char hex transaction hash', () => {
      const validHash = 'a'.repeat(64);
      expect(isTxHash(validHash)).toBe(true);
    });

    it('should return true for mixed case hex hash', () => {
      const validHash = 'abcdef0123456789'.repeat(4); // 64 chars
      expect(isTxHash(validHash)).toBe(true);
    });

    it('should return false for hash with uppercase letters', () => {
      const invalidHash = 'A'.repeat(64);
      expect(isTxHash(invalidHash)).toBe(false);
    });

    it('should return false for hash shorter than 64 chars', () => {
      const shortHash = 'a'.repeat(63);
      expect(isTxHash(shortHash)).toBe(false);
    });

    it('should return false for hash longer than 64 chars', () => {
      const longHash = 'a'.repeat(65);
      expect(isTxHash(longHash)).toBe(false);
    });

    it('should return false for non-hex characters', () => {
      const invalidHash = 'g'.repeat(64);
      expect(isTxHash(invalidHash)).toBe(false);
    });

    it('should return false for non-string input', () => {
      expect(isTxHash(123)).toBe(false);
      expect(isTxHash(null)).toBe(false);
      expect(isTxHash(undefined)).toBe(false);
      expect(isTxHash({})).toBe(false);
      expect(isTxHash([])).toBe(false);
    });
  });

  // ==========================================================================
  // isAssetUnit
  // ==========================================================================
  describe('isAssetUnit', () => {
    it('should return true for valid asset unit (policy + asset name)', () => {
      const policyId = 'a'.repeat(56);
      const assetName = 'b'.repeat(64); // 32 bytes = 64 hex chars
      const assetUnit = policyId + assetName;
      expect(isAssetUnit(assetUnit)).toBe(true);
    });

    it('should return true for asset unit with just policy ID (no asset name)', () => {
      const policyId = 'a'.repeat(56);
      expect(isAssetUnit(policyId)).toBe(true);
    });

    it('should return true for asset unit with maximum asset name length', () => {
      const policyId = 'a'.repeat(56);
      const assetName = 'b'.repeat(128); // 64 bytes = 128 hex chars
      const assetUnit = policyId + assetName;
      expect(isAssetUnit(assetUnit)).toBe(true);
    });

    it('should return false for asset unit shorter than 56 chars', () => {
      const shortUnit = 'a'.repeat(55);
      expect(isAssetUnit(shortUnit)).toBe(false);
    });

    it('should return false for asset unit longer than 192 chars', () => {
      const longUnit = 'a'.repeat(193);
      expect(isAssetUnit(longUnit)).toBe(false);
    });

    it('should return false for non-hex characters', () => {
      const invalidUnit = 'g'.repeat(56);
      expect(isAssetUnit(invalidUnit)).toBe(false);
    });

    it('should handle trimming whitespace', () => {
      const validUnit = 'a'.repeat(56);
      expect(isAssetUnit(`  ${validUnit}  `)).toBe(true);
    });

    it('should return false for non-string input', () => {
      expect(isAssetUnit(123)).toBe(false);
      expect(isAssetUnit(null)).toBe(false);
      expect(isAssetUnit(undefined)).toBe(false);
    });
  });

  // ==========================================================================
  // isBlockHash
  // ==========================================================================
  describe('isBlockHash', () => {
    it('should return true for valid 64-char hex block hash', () => {
      const validHash = 'f'.repeat(64);
      expect(isBlockHash(validHash)).toBe(true);
    });

    it('should return false for invalid block hash', () => {
      const invalidHash = 'x'.repeat(64);
      expect(isBlockHash(invalidHash)).toBe(false);
    });

    it('should return false for wrong length', () => {
      expect(isBlockHash('a'.repeat(63))).toBe(false);
      expect(isBlockHash('a'.repeat(65))).toBe(false);
    });

    it('should return false for non-string input', () => {
      expect(isBlockHash(12345)).toBe(false);
      expect(isBlockHash(null)).toBe(false);
    });
  });

  // ==========================================================================
  // isValidPoolId
  // ==========================================================================
  describe('isValidPoolId', () => {
    it('should return true for valid pool ID', () => {
      // Valid mainnet pool ID (bech32 encoded, 28 bytes payload)
      const validPoolId = 'pool1pu5jlj4q9w9jlxeu370a3c9myx47md5j5m2str0naunn2q3lkdy';
      expect(isValidPoolId(validPoolId)).toBe(true);
    });

    it('should return false for pool ID with wrong HRP', () => {
      const invalidPoolId = 'addr1pu5jlj4q9w9jlxeu370a3c9myx47md5j5m2str0naunn2q3lkdy';
      expect(isValidPoolId(invalidPoolId)).toBe(false);
    });

    it('should return false for pool ID with wrong payload length', () => {
      // This would need a specially crafted bech32 string with wrong payload
      const invalidPoolId = 'pool1abc';
      expect(isValidPoolId(invalidPoolId)).toBe(false);
    });

    it('should return false for invalid bech32 encoding', () => {
      const invalidPoolId = 'pool1invalidbech32!!!';
      expect(isValidPoolId(invalidPoolId)).toBe(false);
    });

    it('should handle trimming whitespace', () => {
      const validPoolId = 'pool1pu5jlj4q9w9jlxeu370a3c9myx47md5j5m2str0naunn2q3lkdy';
      expect(isValidPoolId(`  ${validPoolId}  `)).toBe(true);
    });

    it('should return false for empty string', () => {
      expect(isValidPoolId('')).toBe(false);
      expect(isValidPoolId('   ')).toBe(false);
    });

    it('should return false for non-string input', () => {
      expect(isValidPoolId(123)).toBe(false);
      expect(isValidPoolId(null)).toBe(false);
      expect(isValidPoolId(undefined)).toBe(false);
      expect(isValidPoolId({})).toBe(false);
    });
  });

  // ==========================================================================
  // isValidDrepId
  // ==========================================================================
  describe('isValidDrepId', () => {

    it('should return false for DRep ID with wrong HRP', () => {
      const invalidDrepId = 'pool1vpzcgfrlgdh4jnw9jvlvs9r0xkjfz4h7xs0x9q2wv3r9qgqxj7v';
      expect(isValidDrepId(invalidDrepId)).toBe(false);
    });

    it('should return false for invalid bech32 encoding', () => {
      const invalidDrepId = 'drep1invalid!!!';
      expect(isValidDrepId(invalidDrepId)).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isValidDrepId('')).toBe(false);
      expect(isValidDrepId('   ')).toBe(false);
    });

    it('should return false for non-string input', () => {
      expect(isValidDrepId(null)).toBe(false);
      expect(isValidDrepId(undefined)).toBe(false);
      expect(isValidDrepId(123)).toBe(false);
    });
  });

  // ==========================================================================
  // isValidBech32Address
  // ==========================================================================
  describe('isValidBech32Address', () => {


    it('should return false for address with wrong HRP', () => {
      const invalidAddr = 'stake1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp';
      expect(isValidBech32Address(invalidAddr)).toBe(false);
    });

    it('should return false for valid bech32 with disallowed HRP prefix', () => {
      // Valid bech32 encoding but with 'pool' HRP instead of allowed addr/stake prefixes
      const validBech32WrongHrp = 'pool1pu5jlj4q9w9jlxeu370a3c9myx47md5j5m2str0naunn2q3lkdy';
      expect(isValidBech32Address(validBech32WrongHrp)).toBe(false);
    });

    it('should return false for invalid bech32 encoding', () => {
      const invalidAddr = 'addr1invalid!!!';
      expect(isValidBech32Address(invalidAddr)).toBe(false);
    });

    it('should return false for address with payload too short', () => {
      const invalidAddr = 'addr1abc';
      expect(isValidBech32Address(invalidAddr)).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isValidBech32Address('')).toBe(false);
      expect(isValidBech32Address('   ')).toBe(false);
    });

    it('should return false for non-string input', () => {
      expect(isValidBech32Address(123)).toBe(false);
      expect(isValidBech32Address(null)).toBe(false);
      expect(isValidBech32Address(undefined)).toBe(false);
    });
  });

  // ==========================================================================
  // isValidBech32StakeAddress
  // ==========================================================================
  describe('isValidBech32StakeAddress', () => {

    it('should return false for stake address with wrong HRP', () => {
      const invalidStake = 'addr1u9ttjzthqhmvn2p6eewpzhf8m6hpx8hgue8czs3mfe4gfvqw42lgy';
      expect(isValidBech32StakeAddress(invalidStake)).toBe(false);
    });

    it('should return false for invalid bech32 encoding', () => {
      const invalidStake = 'stake1invalid!!!';
      expect(isValidBech32StakeAddress(invalidStake)).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isValidBech32StakeAddress('')).toBe(false);
      expect(isValidBech32StakeAddress('   ')).toBe(false);
    });

    it('should return false for non-string input', () => {
      expect(isValidBech32StakeAddress(null)).toBe(false);
      expect(isValidBech32StakeAddress(undefined)).toBe(false);
      expect(isValidBech32StakeAddress(123)).toBe(false);
    });
  });

  // ==========================================================================
  // isEpochNumber
  // ==========================================================================
  describe('isEpochNumber', () => {
    it('should return true for valid epoch number 0', () => {
      expect(isEpochNumber(0)).toBe(true);
    });

    it('should return true for valid epoch number within range', () => {
      expect(isEpochNumber(100)).toBe(true);
      expect(isEpochNumber(1000)).toBe(true);
      expect(isEpochNumber(50000)).toBe(true);
    });

    it('should return true for maximum epoch number', () => {
      expect(isEpochNumber(100000)).toBe(true);
    });

    it('should return false for negative epoch number', () => {
      expect(isEpochNumber(-1)).toBe(false);
      expect(isEpochNumber(-100)).toBe(false);
    });

    it('should return false for epoch number exceeding maximum', () => {
      expect(isEpochNumber(100001)).toBe(false);
      expect(isEpochNumber(200000)).toBe(false);
    });

    it('should return false for floating point numbers', () => {
      expect(isEpochNumber(123.45)).toBe(false);
      expect(isEpochNumber(0.5)).toBe(false);
    });

    it('should return false for NaN', () => {
      expect(isEpochNumber(NaN)).toBe(false);
    });

    it('should return false for Infinity', () => {
      expect(isEpochNumber(Infinity)).toBe(false);
      expect(isEpochNumber(-Infinity)).toBe(false);
    });

    it('should return false for non-number input', () => {
      expect(isEpochNumber('123')).toBe(false);
      expect(isEpochNumber(null)).toBe(false);
      expect(isEpochNumber(undefined)).toBe(false);
      expect(isEpochNumber({})).toBe(false);
      expect(isEpochNumber([])).toBe(false);
    });
  });

  describe('isValidCbor', () => {
    it('should return true for valid even-length hex string', () => {
      const validCbor = 'a1b2c3d4';
      expect(isValidCbor(validCbor)).toBe(true);
    });
    it('should return false for odd-length hex string', () => {
      const oddLengthCbor = 'a1b2c3d';
      expect(isValidCbor(oddLengthCbor)).toBe(false);
    });

    it('should return false for non-hex characters', () => {
      const invalidCbor = 'g1h2i3j4';
      expect(isValidCbor(invalidCbor)).toBe(false);
    });
    
    it('should return false for empty string', () => {
      expect(isValidCbor('')).toBe(false);
      expect(isValidCbor('   ')).toBe(false);
    });

    it('should return false for non-string input', () => {
      expect(isValidCbor(123)).toBe(false);
      expect(isValidCbor(null)).toBe(false);
      expect(isValidCbor(undefined)).toBe(false);
    });
  }); 
});
