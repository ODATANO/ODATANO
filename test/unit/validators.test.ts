// Mock getCardanoClient before imports
jest.mock('../../srv/server', () => ({
  getCardanoClient: jest.fn()
}));

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
  validateRequiredSigners,
  validateTransactionInputs,
} from '../../srv/utils/validators';
import { getCardanoClient } from '../../srv/server';

// Type the mock for better IntelliSense
const mockGetCardanoClient = getCardanoClient as jest.MockedFunction<typeof getCardanoClient>;

describe('Validator Helper Methods and Type Guards', () => {

  // Set default network for all tests
  beforeEach(() => {
    mockGetCardanoClient.mockReturnValue({ network: 'preview' } as any);
  });

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

    it('should return true for valid DRep ID', () => {
      const validDrepId = 'drep1y2ldnl4ugmhx873hpw7x23rvqe7krtwvgmvqjn3hy62xv6c8ashc0';
      expect(isValidDrepId(validDrepId)).toBe(true);
    });

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

    it('should return true for valid testnet address', () => {
      const validAddr = 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';
      expect(isValidBech32Address(validAddr)).toBe(true);
    });

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
      expect(isValidBech32Address("123")).toBe(false);
      expect(isValidBech32Address("null")).toBe(false);
      expect(isValidBech32Address("undefined")).toBe(false);
    });
  });

  // ==========================================================================
  // isValidBech32StakeAddress
  // ==========================================================================
  describe('isValidBech32StakeAddress', () => {

    it('should return true for valid testnet stake address', () => {
      const validStake = 'stake_test1urqntq4wexjylnrdnp97qq79qkxxvrsa9lcnwr7ckjd6w0cr04y4p';
      expect(isValidBech32StakeAddress(validStake)).toBe(true);
    });

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
      expect(isValidBech32StakeAddress("null")).toBe(false);
      expect(isValidBech32StakeAddress("undefined")).toBe(false);
      expect(isValidBech32StakeAddress("123")).toBe(false);
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
      expect(isValidCbor("123")).toBe(false);
      expect(isValidCbor("null")).toBe(false);
      expect(isValidCbor("undefined")).toBe(false);
    });
  });

  // ==========================================================================
  // validateRequiredSigners
  // ==========================================================================
  describe('validateRequiredSigners', () => {
    it('should return signers when all key hashes are valid', () => {
      const signers = ['a'.repeat(56), 'b'.repeat(56)];
      expect(validateRequiredSigners(signers)).toEqual(signers);
    });

    it('should throw when input is not an array', () => {
      expect(() => validateRequiredSigners('not-an-array' as any)).toThrow('requiredSignersJson must be a JSON array');
    });

    it('should throw when signer hash has invalid length', () => {
      expect(() => validateRequiredSigners(['a'.repeat(55)])).toThrow('Invalid Ed25519 key hash');
    });

    it('should throw when signer hash is not hexadecimal', () => {
      expect(() => validateRequiredSigners(['g'.repeat(56)])).toThrow('Invalid Ed25519 key hash');
    });
  });

  // ==========================================================================
  // validateTransactionInputs
  // ==========================================================================
  describe('validateTransactionInputs', () => {
    // Valid test addresses (testnet)
    const validSenderAddress = 'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp';
    const validRecipientAddress = 'addr_test1qpu5vlrf4xkxv2qpwngf6cjhtw542ayty80v8dyr49rf5ewvxwdrt70qlcpeeagscasafhffqsxy36t90ldv06wqrk2qum8x5w';
    const validCborHex = 'a1b2c3d4e5f6';

    describe('required fields validation', () => {
      it('should return errors for missing required fields', () => {
        const errors = validateTransactionInputs(
          {},
          ['senderAddress', 'recipientAddress', 'lovelaceAmount']
        );

        expect(errors).toHaveLength(3);
        expect(errors[0]).toEqual({
          type: 'missing',
          field: 'senderAddress',
          message: 'senderAddress is required'
        });
        expect(errors[1]).toEqual({
          type: 'missing',
          field: 'recipientAddress',
          message: 'recipientAddress is required'
        });
        expect(errors[2]).toEqual({
          type: 'missing',
          field: 'lovelaceAmount',
          message: 'lovelaceAmount is required'
        });
      });

      it('should return no errors when all required fields are present and valid', () => {
        const errors = validateTransactionInputs(
          {
            senderAddress: validSenderAddress,
            recipientAddress: validRecipientAddress,
            lovelaceAmount: 1000000n
          },
          ['senderAddress', 'recipientAddress', 'lovelaceAmount']
        );

        expect(errors).toHaveLength(0);
      });

      it('should treat empty string as missing', () => {
        const errors = validateTransactionInputs(
          { senderAddress: '' },
          ['senderAddress']
        );

        expect(errors).toHaveLength(1);
        expect(errors[0].type).toBe('missing');
      });
    });

    describe('address validation', () => {
      it('should return error for invalid sender address format', () => {
        const errors = validateTransactionInputs(
          {
            senderAddress: 'invalid_address',
            recipientAddress: validRecipientAddress,
            lovelaceAmount: 1000000n
          },
          ['senderAddress', 'recipientAddress', 'lovelaceAmount']
        );

        expect(errors).toHaveLength(1);
        expect(errors[0]).toEqual({
          type: 'invalid',
          field: 'senderAddress',
          message: 'Invalid sender address format'
        });
      });

      it('should return error for invalid recipient address format', () => {
        const errors = validateTransactionInputs(
          {
            senderAddress: validSenderAddress,
            recipientAddress: 'not_a_valid_bech32',
            lovelaceAmount: 1000000n
          },
          ['senderAddress', 'recipientAddress', 'lovelaceAmount']
        );

        expect(errors).toHaveLength(1);
        expect(errors[0]).toEqual({
          type: 'invalid',
          field: 'recipientAddress',
          message: 'Invalid recipient address format'
        });
      });

      it('should return error for invalid change address format', () => {
        const errors = validateTransactionInputs(
          {
            senderAddress: validSenderAddress,
            recipientAddress: validRecipientAddress,
            changeAddress: 'bad_change_address'
          },
          ['senderAddress', 'recipientAddress']
        );

        expect(errors).toHaveLength(1);
        expect(errors[0]).toEqual({
          type: 'invalid',
          field: 'changeAddress',
          message: 'Invalid change address format'
        });
      });
    });

    describe('CBOR validation', () => {
      it('should return error for invalid signedTxCbor format', () => {
        const errors = validateTransactionInputs(
          { signedTxCbor: 'not_hex!' },
          ['signedTxCbor']
        );

        expect(errors).toHaveLength(1);
        expect(errors[0]).toEqual({
          type: 'invalid',
          field: 'signedTxCbor',
          message: 'Invalid signedTxCbor format'
        });
      });

      it('should return error for odd-length signedTxCbor', () => {
        const errors = validateTransactionInputs(
          { signedTxCbor: 'abc' },
          ['signedTxCbor']
        );

        expect(errors).toHaveLength(1);
        expect(errors[0].field).toBe('signedTxCbor');
      });

      it('should accept valid signedTxCbor', () => {
        const errors = validateTransactionInputs(
          { signedTxCbor: validCborHex },
          ['signedTxCbor']
        );

        expect(errors).toHaveLength(0);
      });

      it('should return error for invalid mintingPolicyScript format', () => {
        const errors = validateTransactionInputs(
          {
            senderAddress: validSenderAddress,
            recipientAddress: validRecipientAddress,
            mintingPolicyScript: 'invalid_cbor!'
          },
          ['senderAddress', 'recipientAddress', 'mintingPolicyScript']
        );

        expect(errors).toHaveLength(1);
        expect(errors[0]).toEqual({
          type: 'invalid',
          field: 'mintingPolicyScript',
          message: 'Invalid mintingPolicyScript format'
        });
      });
    });

    describe('JSON validation', () => {
      it('should return error for invalid metadataJson', () => {
        const errors = validateTransactionInputs(
          {
            senderAddress: validSenderAddress,
            recipientAddress: validRecipientAddress,
            lovelaceAmount: 1000000n,
            metadataJson: 'not valid json {'
          },
          ['senderAddress', 'recipientAddress', 'lovelaceAmount', 'metadataJson']
        );

        expect(errors).toHaveLength(1);
        expect(errors[0]).toEqual({
          type: 'invalid',
          field: 'metadataJson',
          message: 'Invalid JSON in metadataJson'
        });
      });

      it('should accept valid metadataJson', () => {
        const errors = validateTransactionInputs(
          {
            senderAddress: validSenderAddress,
            recipientAddress: validRecipientAddress,
            lovelaceAmount: 1000000n,
            metadataJson: '{"key": "value"}'
          },
          ['senderAddress', 'recipientAddress', 'lovelaceAmount', 'metadataJson']
        );

        expect(errors).toHaveLength(0);
      });

      it('should return error for invalid assetsJson', () => {
        const errors = validateTransactionInputs(
          {
            senderAddress: validSenderAddress,
            recipientAddress: validRecipientAddress,
            lovelaceAmount: 1000000n,
            assetsJson: '[invalid'
          },
          ['senderAddress', 'recipientAddress', 'lovelaceAmount', 'assetsJson']
        );

        expect(errors).toHaveLength(1);
        expect(errors[0]).toEqual({
          type: 'invalid',
          field: 'assetsJson',
          message: 'Invalid JSON in assetsJson'
        });
      });

      it('should return error for invalid mintActionsJson', () => {
        const errors = validateTransactionInputs(
          {
            senderAddress: validSenderAddress,
            recipientAddress: validRecipientAddress,
            mintActionsJson: '{broken json'
          },
          ['senderAddress', 'recipientAddress', 'mintActionsJson']
        );

        expect(errors).toHaveLength(1);
        expect(errors[0]).toEqual({
          type: 'invalid',
          field: 'mintActionsJson',
          message: 'Invalid JSON in mintActionsJson'
        });
      });

      it('should return error for JSON exceeding max size (1MB)', () => {
        // Create JSON string > 1MB
        const largeJson = JSON.stringify({ data: 'x'.repeat(1_100_000) });
        const errors = validateTransactionInputs(
          {
            senderAddress: validSenderAddress,
            recipientAddress: validRecipientAddress,
            lovelaceAmount: 1000000n,
            metadataJson: largeJson
          },
          ['senderAddress', 'recipientAddress', 'lovelaceAmount', 'metadataJson']
        );

        expect(errors).toHaveLength(1);
        expect(errors[0].field).toBe('metadataJson');
        expect(errors[0].message).toContain('exceeds maximum size');
      });

      it('should return error for JSON exceeding max nesting depth', () => {
        // Create deeply nested object (11 levels, limit is 10)
        let nested = { value: 'deep' };
        for (let i = 0; i < 11; i++) {
          nested = { nested } as any;
        }
        const errors = validateTransactionInputs(
          {
            senderAddress: validSenderAddress,
            recipientAddress: validRecipientAddress,
            lovelaceAmount: 1000000n,
            metadataJson: JSON.stringify(nested)
          },
          ['senderAddress', 'recipientAddress', 'lovelaceAmount', 'metadataJson']
        );

        expect(errors).toHaveLength(1);
        expect(errors[0].field).toBe('metadataJson');
        expect(errors[0].message).toContain('nesting depth');
      });

      it('should return error for JSON object with too many keys', () => {
        // Create object with 101 keys (limit is 100)
        const manyKeys: Record<string, number> = {};
        for (let i = 0; i < 101; i++) {
          manyKeys[`key${i}`] = i;
        }
        const errors = validateTransactionInputs(
          {
            senderAddress: validSenderAddress,
            recipientAddress: validRecipientAddress,
            lovelaceAmount: 1000000n,
            metadataJson: JSON.stringify(manyKeys)
          },
          ['senderAddress', 'recipientAddress', 'lovelaceAmount', 'metadataJson']
        );

        expect(errors).toHaveLength(1);
        expect(errors[0].field).toBe('metadataJson');
        expect(errors[0].message).toContain('maximum key count');
      });

      it('should return error for JSON array exceeding max length', () => {
        // Create array with 1001 elements (limit is 1000)
        const largeArray = Array.from({ length: 1001 }, (_, i) => i);
        const errors = validateTransactionInputs(
          {
            senderAddress: validSenderAddress,
            recipientAddress: validRecipientAddress,
            lovelaceAmount: 1000000n,
            assetsJson: JSON.stringify(largeArray)
          },
          ['senderAddress', 'recipientAddress', 'lovelaceAmount', 'assetsJson']
        );

        expect(errors).toHaveLength(1);
        expect(errors[0].field).toBe('assetsJson');
        expect(errors[0].message).toContain('maximum length');
      });

      it('should return error for JSON string value exceeding max length', () => {
        // Create object with string value > 65536 chars
        const longString = 'x'.repeat(70000);
        const errors = validateTransactionInputs(
          {
            senderAddress: validSenderAddress,
            recipientAddress: validRecipientAddress,
            lovelaceAmount: 1000000n,
            metadataJson: JSON.stringify({ text: longString })
          },
          ['senderAddress', 'recipientAddress', 'lovelaceAmount', 'metadataJson']
        );

        expect(errors).toHaveLength(1);
        expect(errors[0].field).toBe('metadataJson');
        expect(errors[0].message).toContain('String value exceeds maximum length');
      });

      it('should accept valid JSON within all limits', () => {
        const validJson = JSON.stringify({
          label1: { nested: { value: 'test' } },
          label2: [1, 2, 3, 4, 5],
          label3: 'short string'
        });
        const errors = validateTransactionInputs(
          {
            senderAddress: validSenderAddress,
            recipientAddress: validRecipientAddress,
            lovelaceAmount: 1000000n,
            metadataJson: validJson
          },
          ['senderAddress', 'recipientAddress', 'lovelaceAmount', 'metadataJson']
        );

        expect(errors).toHaveLength(0);
      });
    });

    describe('multiple errors', () => {
      it('should return only missing errors when required fields are missing (early return)', () => {
        const errors = validateTransactionInputs(
          {
            senderAddress: 'invalid_address' // invalid but also missing recipientAddress
          },
          ['senderAddress', 'recipientAddress']
        );

        // Should return early with missing field error, not validate format
        expect(errors).toHaveLength(1);
        expect(errors[0].type).toBe('missing');
        expect(errors[0].field).toBe('recipientAddress');
      });

      it('should return multiple validation errors when all required fields present', () => {
        const errors = validateTransactionInputs(
          {
            senderAddress: 'invalid_sender',
            recipientAddress: 'invalid_recipient',
            lovelaceAmount: 1000000n
          },
          ['senderAddress', 'recipientAddress', 'lovelaceAmount']
        );

        expect(errors).toHaveLength(2);
        expect(errors.map(e => e.field)).toContain('senderAddress');
        expect(errors.map(e => e.field)).toContain('recipientAddress');
      });
    });

    describe('optional fields', () => {
      it('should not validate optional fields that are not provided', () => {
        const errors = validateTransactionInputs(
          {
            senderAddress: validSenderAddress,
            recipientAddress: validRecipientAddress
          },
          ['senderAddress', 'recipientAddress']
        );

        expect(errors).toHaveLength(0);
      });

      it('should validate optional changeAddress when provided', () => {
        const errors = validateTransactionInputs(
          {
            senderAddress: validSenderAddress,
            recipientAddress: validRecipientAddress,
            changeAddress: validSenderAddress
          },
          ['senderAddress', 'recipientAddress']
        );

        expect(errors).toHaveLength(0);
      });
    });

    describe('buildId and submissionId', () => {
      it('should return error for missing buildId when required', () => {
        const errors = validateTransactionInputs(
          {},
          ['buildId']
        );

        expect(errors).toHaveLength(1);
        expect(errors[0]).toEqual({
          type: 'missing',
          field: 'buildId',
          message: 'buildId is required'
        });
      });

      it('should return error for missing submissionId when required', () => {
        const errors = validateTransactionInputs(
          {},
          ['submissionId']
        );

        expect(errors).toHaveLength(1);
        expect(errors[0]).toEqual({
          type: 'missing',
          field: 'submissionId',
          message: 'submissionId is required'
        });
      });

      it('should accept valid buildId', () => {
        const errors = validateTransactionInputs(
          { buildId: 'some-uuid-value' },
          ['buildId']
        );

        expect(errors).toHaveLength(0);
      });
    });

    // ========================================================================
    // Plutus Spending Fields
    // ========================================================================
    describe('Plutus spending fields', () => {
      const validScriptCbor = 'aabbccdd';
      const validScriptTxHash = 'a'.repeat(64);

      it('should require validatorScript when listed as required', () => {
        const errors = validateTransactionInputs(
          {},
          ['validatorScript']
        );

        expect(errors).toHaveLength(1);
        expect(errors[0].type).toBe('missing');
        expect(errors[0].field).toBe('validatorScript');
      });

      it('should reject invalid validatorScript CBOR', () => {
        const errors = validateTransactionInputs(
          { validatorScript: 'not_hex!' },
          ['validatorScript']
        );

        expect(errors).toHaveLength(1);
        expect(errors[0].type).toBe('invalid');
        expect(errors[0].field).toBe('validatorScript');
      });

      it('should reject odd-length validatorScript CBOR', () => {
        const errors = validateTransactionInputs(
          { validatorScript: 'abc' },
          ['validatorScript']
        );

        expect(errors).toHaveLength(1);
        expect(errors[0].type).toBe('invalid');
        expect(errors[0].field).toBe('validatorScript');
      });

      it('should accept valid validatorScript CBOR', () => {
        const errors = validateTransactionInputs(
          { validatorScript: validScriptCbor },
          ['validatorScript']
        );

        expect(errors).toHaveLength(0);
      });

      it('should reject invalid scriptTxHash format', () => {
        const errors = validateTransactionInputs(
          { scriptTxHash: 'invalidhash' },
          ['scriptTxHash']
        );

        expect(errors).toHaveLength(1);
        expect(errors[0].type).toBe('invalid');
        expect(errors[0].field).toBe('scriptTxHash');
      });

      it('should accept valid scriptTxHash', () => {
        const errors = validateTransactionInputs(
          { scriptTxHash: validScriptTxHash },
          ['scriptTxHash']
        );

        expect(errors).toHaveLength(0);
      });

      it('should reject negative scriptOutputIndex', () => {
        const errors = validateTransactionInputs(
          { scriptOutputIndex: -1, scriptTxHash: validScriptTxHash },
          ['scriptTxHash']
        );

        expect(errors).toHaveLength(1);
        expect(errors[0].type).toBe('invalid');
        expect(errors[0].field).toBe('scriptOutputIndex');
      });

      it('should reject non-integer scriptOutputIndex', () => {
        const errors = validateTransactionInputs(
          { scriptOutputIndex: 1.5, scriptTxHash: validScriptTxHash },
          ['scriptTxHash']
        );

        expect(errors).toHaveLength(1);
        expect(errors[0].type).toBe('invalid');
        expect(errors[0].field).toBe('scriptOutputIndex');
      });

      it('should accept valid scriptOutputIndex 0', () => {
        const errors = validateTransactionInputs(
          { scriptOutputIndex: 0, scriptTxHash: validScriptTxHash },
          ['scriptTxHash']
        );

        expect(errors).toHaveLength(0);
      });

      it('should accept valid scriptOutputIndex > 0', () => {
        const errors = validateTransactionInputs(
          { scriptOutputIndex: 3, scriptTxHash: validScriptTxHash },
          ['scriptTxHash']
        );

        expect(errors).toHaveLength(0);
      });

      it('should reject invalid redeemerJson', () => {
        const errors = validateTransactionInputs(
          { redeemerJson: 'not valid json{' },
          ['redeemerJson']
        );

        expect(errors).toHaveLength(1);
        expect(errors[0].type).toBe('invalid');
        expect(errors[0].field).toBe('redeemerJson');
      });

      it('should accept valid redeemerJson', () => {
        const errors = validateTransactionInputs(
          { redeemerJson: '{"constructor": 0, "fields": []}' },
          ['redeemerJson']
        );

        expect(errors).toHaveLength(0);
      });

      it('should reject invalid datumJson', () => {
        const errors = validateTransactionInputs(
          { datumJson: '{invalid' },
          ['datumJson']
        );

        expect(errors).toHaveLength(1);
        expect(errors[0].type).toBe('invalid');
        expect(errors[0].field).toBe('datumJson');
      });

      it('should accept valid datumJson', () => {
        const errors = validateTransactionInputs(
          { datumJson: '{"int": 42}' },
          ['datumJson']
        );

        expect(errors).toHaveLength(0);
      });

      it('should validate all Plutus spending fields together', () => {
        const errors = validateTransactionInputs(
          {
            senderAddress: validSenderAddress,
            recipientAddress: validRecipientAddress,
            validatorScript: validScriptCbor,
            scriptTxHash: validScriptTxHash,
            scriptOutputIndex: 0,
            redeemerJson: '{"constructor": 0, "fields": []}',
          },
          ['senderAddress', 'recipientAddress', 'validatorScript', 'scriptTxHash', 'redeemerJson']
        );

        expect(errors).toHaveLength(0);
      });
    });

    describe('lovelaceAmount validation', () => {
      it('should reject lovelaceAmount of zero', () => {
        const errors = validateTransactionInputs(
          {
            senderAddress: validSenderAddress,
            recipientAddress: validRecipientAddress,
            lovelaceAmount: 0 as any,
          },
          ['senderAddress', 'recipientAddress']
        );

        expect(errors).toHaveLength(1);
        expect(errors[0]).toEqual({
          type: 'invalid',
          field: 'lovelaceAmount',
          message: 'lovelaceAmount must be a positive integer',
        });
      });

      it('should reject non-numeric lovelaceAmount string', () => {
        const errors = validateTransactionInputs(
          {
            senderAddress: validSenderAddress,
            recipientAddress: validRecipientAddress,
            lovelaceAmount: 'abc' as any,
          },
          ['senderAddress', 'recipientAddress']
        );

        expect(errors).toHaveLength(1);
        expect(errors[0].field).toBe('lovelaceAmount');
      });
    });

    describe('CBOR size validation', () => {
      it('should reject signedTxCbor exceeding maximum size', () => {
        // MAX_CBOR_HEX_LENGTH is 65536; create valid hex that exceeds it
        const oversizedCbor = 'ab'.repeat(33000); // 66000 hex chars > 65536
        const errors = validateTransactionInputs(
          { signedTxCbor: oversizedCbor },
          []
        );

        expect(errors).toHaveLength(1);
        expect(errors[0]).toEqual({
          type: 'invalid',
          field: 'signedTxCbor',
          message: 'signedTxCbor exceeds maximum size of 65536 hex characters',
        });
      });
    });
  });
});
