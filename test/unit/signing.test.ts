/**
 * Unit tests for signing module (ExternalSignerModule and SignatureVerifier)
 *
 * These tests use real CSL and harmoniclabs libraries with valid test data
 */

import {
  ExternalSignerModule,
  createExternalSignerModule,
  getExternalSignerModule,
} from '../../srv/blockchain/signing/external-signer';

import {
  SignatureVerifier,
  getSignatureVerifier,
} from '../../srv/blockchain/signing/signature-verifier';

import {
  combineTransactionWithWitnesses,
  isWitnessSetCbor,
} from '../../srv/utils/signing-helper';

import {
  ExternalSignerType,
  SigningStatus,
  UnsignedTxExportPayload,
  SignatureVerificationResult,
} from '../../srv/utils/types';

import { TransactionValidationError } from '../../srv/utils/errors';
import * as cbor from 'cbor';

// Mock only the logger to reduce noise in tests
jest.mock('@sap/cds', () => ({
  log: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
  utils: {
    uuid: jest.fn(() => 'test-uuid-1234'),
  },
}));

// Valid test transaction CBORs from actual Cardano testnet
// These are real transactions from the csl-tx-builder tests

// Unsigned transaction CBOR
const VALID_UNSIGNED_TX_CBOR = '84a400818258202db5788ec32bc0fdd0bc308b4787dba2d2dd4930bec4025360647fed6d35bccb010182a200583900d090525914fb9bcd35141eaff7b054b9ce105f154ebb73347ff9c7415318a7bcc399479a382e00ef73306801c4d8064df6cc20d2a5ca7189011a00989680a200581d60374610273097b313fade06a30e90c5fb2640074ca0744ce850b8f0a101821b000000023f09f49ca1581cdef68337867cb4f1f95b6b811fedbfcdd7780d10a95cc072077088eaa146546f6b656e4d1909c4021a000294c10f00a0f5f6';

// Signed transaction CBOR (same transaction with witness set added)
const VALID_SIGNED_TX_CBOR = '84a400818258202db5788ec32bc0fdd0bc308b4787dba2d2dd4930bec4025360647fed6d35bccb010182a200583900d090525914fb9bcd35141eaff7b054b9ce105f154ebb73347ff9c7415318a7bcc399479a382e00ef73306801c4d8064df6cc20d2a5ca7189011a00989680a200581d60374610273097b313fade06a30e90c5fb2640074ca0744ce850b8f0a101821b000000023f09f49ca1581cdef68337867cb4f1f95b6b811fedbfcdd7780d10a95cc072077088eaa146546f6b656e4d1909c4021a000294c10f00a100d9010281825820e865ca640ce4c6e92cd45b5e7f4ab37da379f1098eae4dc5e46709a42dec8f2f584068f60d60ecf7dcc99b5e19577015cd4d06f9c0c69d2d0688625c72cdbb2dae67e8a2bf0af85d12f6adda74ee693802ad2ccf7ed2a1ce5ec7c0a872bcf259c206f5f6';

// Just the witness set (what CIP-30 wallet signTx() returns)
const VALID_WITNESS_SET_CBOR = 'a100d9010281825820e865ca640ce4c6e92cd45b5e7f4ab37da379f1098eae4dc5e46709a42dec8f2f584068f60d60ecf7dcc99b5e19577015cd4d06f9c0c69d2d0688625c72cdbb2dae67e8a2bf0af85d12f6adda74ee693802ad2ccf7ed2a1ce5ec7c0a872bcf259c206';

describe('SignatureVerifier', () => {
  let verifier: SignatureVerifier;

  beforeEach(() => {
    verifier = new SignatureVerifier();
  });

  describe('extractTxBodyHash()', () => {
    it('should extract transaction body hash from valid unsigned CBOR', () => {
      const hash = verifier.extractTxBodyHash(VALID_UNSIGNED_TX_CBOR);

      expect(hash).toBeDefined();
      expect(typeof hash).toBe('string');
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should extract transaction body hash from valid signed CBOR', () => {
      const hash = verifier.extractTxBodyHash(VALID_SIGNED_TX_CBOR);

      expect(hash).toBeDefined();
      expect(typeof hash).toBe('string');
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should throw error for invalid CBOR', () => {
      expect(() => {
        verifier.extractTxBodyHash('invalid-hex');
      }).toThrow();
    });

    it('should throw error for empty string', () => {
      expect(() => {
        verifier.extractTxBodyHash('');
      }).toThrow();
    });
  });

  describe('isSigned()', () => {
    it('should return true for signed transaction', () => {
      const result = verifier.isSigned(VALID_SIGNED_TX_CBOR);
      expect(result).toBe(true);
    });

    it('should return false for unsigned transaction', () => {
      const result = verifier.isSigned(VALID_UNSIGNED_TX_CBOR);
      expect(result).toBe(false);
    });

    it('should return false for invalid CBOR', () => {
      const result = verifier.isSigned('invalid-cbor');
      expect(result).toBe(false);
    });
  });

  describe('getWitnessCount()', () => {
    it('should return witness count for signed transaction', () => {
      const count = verifier.getWitnessCount(VALID_SIGNED_TX_CBOR);
      expect(count).toBeGreaterThan(0);
    });

    it('should return 0 for unsigned transaction', () => {
      const count = verifier.getWitnessCount(VALID_UNSIGNED_TX_CBOR);
      expect(count).toBe(0);
    });

    it('should return 0 for invalid CBOR', () => {
      const count = verifier.getWitnessCount('invalid');
      expect(count).toBe(0);
    });
  });

  describe('verify()', () => {
    let expectedHash: string;

    beforeEach(() => {
      // Extract the actual hash from our test transaction
      expectedHash = verifier.extractTxBodyHash(VALID_SIGNED_TX_CBOR);
    });

    it('should successfully verify a valid signed transaction', () => {
      const result = verifier.verify(VALID_SIGNED_TX_CBOR, {
        expectedTxBodyHash: expectedHash,
        requireSignature: true,
      });

      expect(result.isValid).toBe(true);
      expect(result.txBodyHash).toBe(expectedHash);
      expect(result.witnessCount).toBeGreaterThan(0);
      expect(result.signerKeyHashes.length).toBeGreaterThan(0);
      expect(result.warnings).toHaveLength(0);
    });

    it('should fail when transaction body hash does not match expected', () => {
      const wrongHash = 'b'.repeat(64);

      const result = verifier.verify(VALID_SIGNED_TX_CBOR, {
        expectedTxBodyHash: wrongHash,
        requireSignature: true,
      });

      expect(result.isValid).toBe(false);
      expect(result.errorMessage).toContain('Transaction body hash mismatch');
    });

    it('should fail when signature required but transaction is unsigned', () => {
      const result = verifier.verify(VALID_UNSIGNED_TX_CBOR, {
        requireSignature: true,
      });

      expect(result.isValid).toBe(false);
      expect(result.errorMessage).toContain('No signatures found');
    });

    it('should succeed when no signature required and none present', () => {
      const result = verifier.verify(VALID_UNSIGNED_TX_CBOR, {
        requireSignature: false,
      });

      expect(result.isValid).toBe(true);
      expect(result.witnessCount).toBe(0);
    });

    it('should fail when required signer is missing', () => {
      const nonExistentSigner = 'abcd1234'.repeat(7);

      const result = verifier.verify(VALID_SIGNED_TX_CBOR, {
        requiredSigners: [nonExistentSigner],
      });

      expect(result.isValid).toBe(false);
      expect(result.errorMessage).toContain('Missing required signatures');
    });

    it('should succeed when all required signers are present', () => {
      // First get the actual signers from the transaction
      const prelimResult = verifier.verify(VALID_SIGNED_TX_CBOR, {
        requireSignature: false,
      });

      expect(prelimResult.signerKeyHashes.length).toBeGreaterThan(0);

      // Now verify with the actual signer
      const result = verifier.verify(VALID_SIGNED_TX_CBOR, {
        requiredSigners: prelimResult.signerKeyHashes,
      });

      expect(result.isValid).toBe(true);
    });

    it('should handle invalid CBOR gracefully', () => {
      const result = verifier.verify('invalid-cbor-hex');

      expect(result.isValid).toBe(false);
      expect(result.errorMessage).toContain('Failed to verify signature');
    });
  });

  describe('verifyOrThrow()', () => {
    it('should return result when verification succeeds', () => {
      const expectedHash = verifier.extractTxBodyHash(VALID_SIGNED_TX_CBOR);

      const result = verifier.verifyOrThrow(VALID_SIGNED_TX_CBOR, {
        expectedTxBodyHash: expectedHash,
      });

      expect(result.isValid).toBe(true);
    });

    it('should throw TransactionValidationError when verification fails', () => {
      expect(() => {
        verifier.verifyOrThrow(VALID_SIGNED_TX_CBOR, {
          expectedTxBodyHash: 'wrong-hash',
        });
      }).toThrow(TransactionValidationError);
    });
  });

  describe('getSignatureVerifier()', () => {
    it('should return singleton instance', () => {
      const instance1 = getSignatureVerifier();
      const instance2 = getSignatureVerifier();

      expect(instance1).toBe(instance2);
      expect(instance1).toBeInstanceOf(SignatureVerifier);
    });
  });
});

describe('ExternalSignerModule', () => {
  let module: ExternalSignerModule;
  let verifier: SignatureVerifier;

  beforeEach(() => {
    module = new ExternalSignerModule();
    verifier = new SignatureVerifier();
  });

  describe('constructor', () => {
    it('should create module with default TTL', () => {
      const mod = new ExternalSignerModule();
      expect(mod).toBeInstanceOf(ExternalSignerModule);
    });

    it('should create module with custom TTL', () => {
      const customTtl = 60 * 60 * 1000; // 1 hour
      const mod = new ExternalSignerModule({ signingTtlMs: customTtl });
      expect(mod).toBeInstanceOf(ExternalSignerModule);
    });
  });

  describe('createSigningRequest()', () => {
    it('should create a valid signing request with all required fields', () => {
      const buildId = 'build-123';
      const network = 'preprod';
      const txBodyHash = verifier.extractTxBodyHash(VALID_UNSIGNED_TX_CBOR);

      const request = module.createSigningRequest(
        buildId,
        VALID_UNSIGNED_TX_CBOR,
        txBodyHash,
        network,
        'Test signing message'
      );

      expect(request.signingRequestId).toBe('test-uuid-1234');
      expect(request.buildId).toBe(buildId);
      expect(request.txBodyHash).toBe(txBodyHash);
      expect(request.unsignedTxCbor).toBe(VALID_UNSIGNED_TX_CBOR);
      expect(request.network).toBe(network);
      expect(request.createdAt).toBeDefined();
      expect(request.expiresAt).toBeDefined();
      expect(request.signingInstructions).toBeDefined();
      expect(request.signingInstructions.signerTypeHint).toBe(ExternalSignerType.CARDANO_CLI);
    });

    it('should include required signers when provided', () => {
      const txBodyHash = verifier.extractTxBodyHash(VALID_UNSIGNED_TX_CBOR);
      const requiredSigners = ['abcd1234'.repeat(7)];

      const request = module.createSigningRequest(
        'build-123',
        VALID_UNSIGNED_TX_CBOR,
        txBodyHash,
        'preprod',
        'Test signing message',
        { requiredSigners }
      );

      expect(request.requiredSigners).toEqual(requiredSigners);
    });

    it('should use custom signer type hint', () => {
      const txBodyHash = verifier.extractTxBodyHash(VALID_UNSIGNED_TX_CBOR);

      const request = module.createSigningRequest(
        'build-123',
        VALID_UNSIGNED_TX_CBOR,
        txBodyHash,
        'mainnet',
        'Test signing message',
        { signerTypeHint: ExternalSignerType.BROWSER_WALLET }
      );

      expect(request.signingInstructions.signerTypeHint).toBe(ExternalSignerType.BROWSER_WALLET);
    });

    it('should generate proper signing instructions for mainnet', () => {
      const txBodyHash = verifier.extractTxBodyHash(VALID_UNSIGNED_TX_CBOR);

      const request = module.createSigningRequest(
        'build-123',
        VALID_UNSIGNED_TX_CBOR,
        txBodyHash,
        'mainnet',
        'Test signing message'
      );

      expect(request.signingInstructions.network).toBe('mainnet');
      expect(request.signingInstructions.cip30SigningRequest).toBeDefined();
      expect(request.signingInstructions.cip30SigningRequest?.txCbor).toBe(VALID_UNSIGNED_TX_CBOR);
    });

    it('should generate proper signing instructions for preprod testnet', () => {
      const txBodyHash = verifier.extractTxBodyHash(VALID_UNSIGNED_TX_CBOR);

      const request = module.createSigningRequest(
        'build-123',
        VALID_UNSIGNED_TX_CBOR,
        txBodyHash,
        'preprod',
        'Test signing message'
      );

      expect(request.signingInstructions.network).toBe('preprod');
    });

    it('should generate proper signing instructions for preview testnet', () => {
      const txBodyHash = verifier.extractTxBodyHash(VALID_UNSIGNED_TX_CBOR);

      const request = module.createSigningRequest(
        'build-123',
        VALID_UNSIGNED_TX_CBOR,
        txBodyHash,
        'preview',
        'Test signing message'
      );

      expect(request.signingInstructions.network).toBe('preview');
    });

    it('should set expiration time based on default TTL (30 minutes)', () => {
      const txBodyHash = verifier.extractTxBodyHash(VALID_UNSIGNED_TX_CBOR);
      const now = new Date();

      const request = module.createSigningRequest(
        'build-123',
        VALID_UNSIGNED_TX_CBOR,
        txBodyHash,
        'preprod',
        'Test signing message'
      );

      const expiresAt = new Date(request.expiresAt);
      const timeDiff = expiresAt.getTime() - now.getTime();

      // Should be approximately 30 minutes (default TTL)
      expect(timeDiff).toBeGreaterThan(29 * 60 * 1000);
      expect(timeDiff).toBeLessThan(31 * 60 * 1000);
    });
  });

  describe('verifySignedTransaction()', () => {
    it('should successfully verify valid signed transaction', () => {
      const expectedHash = verifier.extractTxBodyHash(VALID_SIGNED_TX_CBOR);

      const result = module.verifySignedTransaction(
        VALID_SIGNED_TX_CBOR,
        expectedHash
      );

      expect(result.isValid).toBe(true);
      expect(result.txBodyHash).toBe(expectedHash);
    });

    it('should fail verification for mismatched hash', () => {
      const wrongHash = 'a'.repeat(64);

      const result = module.verifySignedTransaction(
        VALID_SIGNED_TX_CBOR,
        wrongHash
      );

      expect(result.isValid).toBe(false);
      expect(result.errorMessage).toContain('mismatch');
    });

    it('should reject expired signing request when expiresAt is in the past', () => {
      const expectedHash = verifier.extractTxBodyHash(VALID_SIGNED_TX_CBOR);
      const pastDate = new Date(Date.now() - 60000).toISOString();

      const result = module.verifySignedTransaction(
        VALID_SIGNED_TX_CBOR,
        expectedHash,
        { expiresAt: pastDate }
      );

      expect(result.isValid).toBe(false);
      expect(result.errorMessage).toContain('expired');
    });
  });

  describe('verifyOrThrow()', () => {
    it('should return result on successful verification', () => {
      const expectedHash = verifier.extractTxBodyHash(VALID_SIGNED_TX_CBOR);

      const result = module.verifyOrThrow(
        VALID_SIGNED_TX_CBOR,
        expectedHash
      );

      expect(result.isValid).toBe(true);
    });

    it('should throw TransactionValidationError on failed verification', () => {
      expect(() => {
        module.verifyOrThrow(VALID_SIGNED_TX_CBOR, 'wrong-hash');
      }).toThrow(TransactionValidationError);
    });
  });

  describe('Workflow State Management', () => {
    let signingRequest: UnsignedTxExportPayload;

    beforeEach(() => {
      const txBodyHash = verifier.extractTxBodyHash(VALID_UNSIGNED_TX_CBOR);
      signingRequest = module.createSigningRequest(
        'build-123',
        VALID_UNSIGNED_TX_CBOR,
        txBodyHash,
        'preprod',
        'Test signing message'
      );
    });

    describe('createWorkflowState()', () => {
      it('should create initial workflow state with pending status', () => {
        const state = module.createWorkflowState(signingRequest);

        expect(state.status).toBe(SigningStatus.PENDING);
        expect(state.request).toBe(signingRequest);
        expect(state.timestamps.created).toBe(signingRequest.createdAt);
        expect(state.signedTxCbor).toBeUndefined();
        expect(state.verificationResult).toBeUndefined();
      });
    });

    describe('markAsSigned()', () => {
      it('should update state to signed with transaction data', () => {
        const initialState = module.createWorkflowState(signingRequest);
        const signedState = module.markAsSigned(initialState, VALID_SIGNED_TX_CBOR);

        expect(signedState.status).toBe(SigningStatus.SIGNED);
        expect(signedState.signedTxCbor).toBe(VALID_SIGNED_TX_CBOR);
        expect(signedState.timestamps.signed).toBeDefined();
      });
    });

    describe('markAsVerified()', () => {
      it('should update state to verified on successful verification', () => {
        const initialState = module.createWorkflowState(signingRequest);
        const signedState = module.markAsSigned(initialState, VALID_SIGNED_TX_CBOR);

        const verificationResult: SignatureVerificationResult = {
          isValid: true,
          txBodyHash: signingRequest.txBodyHash,
          witnessCount: 1,
          signerKeyHashes: ['abcd1234'.repeat(7)],
          warnings: [],
        };

        const verifiedState = module.markAsVerified(signedState, verificationResult);

        expect(verifiedState.status).toBe(SigningStatus.VERIFIED);
        expect(verifiedState.verificationResult).toBe(verificationResult);
        expect(verifiedState.timestamps.verified).toBeDefined();
      });

      it('should mark as failed when verification result is invalid', () => {
        const initialState = module.createWorkflowState(signingRequest);

        const verificationResult: SignatureVerificationResult = {
          isValid: false,
          txBodyHash: signingRequest.txBodyHash,
          witnessCount: 0,
          signerKeyHashes: [],
          warnings: [],
          errorMessage: 'Verification failed',
        };

        const failedState = module.markAsVerified(initialState, verificationResult);

        expect(failedState.status).toBe(SigningStatus.FAILED);
        expect(failedState.errorMessage).toBe('Verification failed');
        expect(failedState.timestamps.failed).toBeDefined();
      });
    });

    describe('markAsSubmitted()', () => {
      it('should update state to submitted with transaction hash', () => {
        const initialState = module.createWorkflowState(signingRequest);
        const txHash = 'tx-hash-123';
        const submittedState = module.markAsSubmitted(initialState, txHash);

        expect(submittedState.status).toBe(SigningStatus.SUBMITTED);
        expect(submittedState.txHash).toBe(txHash);
        expect(submittedState.timestamps.submitted).toBeDefined();
      });
    });

    describe('markAsFailed()', () => {
      it('should update state to failed with error message', () => {
        const initialState = module.createWorkflowState(signingRequest);
        const errorMessage = 'Something went wrong';
        const failedState = module.markAsFailed(initialState, errorMessage);

        expect(failedState.status).toBe(SigningStatus.FAILED);
        expect(failedState.errorMessage).toBe(errorMessage);
        expect(failedState.timestamps.failed).toBeDefined();
      });
    });
  });

  describe('isExpired()', () => {
    it('should return false for future expiration timestamp', () => {
      const futureDate = new Date(Date.now() + 60000).toISOString();
      expect(module.isExpired(futureDate)).toBe(false);
    });

    it('should return true for past expiration timestamp', () => {
      const pastDate = new Date(Date.now() - 60000).toISOString();
      expect(module.isExpired(pastDate)).toBe(true);
    });
  });

  describe('validateForSubmission()', () => {
    it('should validate and return verification result for valid transaction', () => {
      const expectedHash = verifier.extractTxBodyHash(VALID_SIGNED_TX_CBOR);

      const payload = {
        signingRequestId: 'req-123',
        buildId: 'build-123',
        signedTxCbor: VALID_SIGNED_TX_CBOR,
        signerType: ExternalSignerType.CARDANO_CLI,
      };

      const result = module.validateForSubmission(payload, expectedHash);

      expect(result.isValid).toBe(true);
      expect(result.txBodyHash).toBe(expectedHash);
    });

    it('should throw TransactionValidationError on validation failure', () => {
      const payload = {
        signingRequestId: 'req-123',
        buildId: 'build-123',
        signedTxCbor: VALID_SIGNED_TX_CBOR,
        signerType: ExternalSignerType.CARDANO_CLI,
      };

      expect(() => {
        module.validateForSubmission(payload, 'wrong-hash');
      }).toThrow(TransactionValidationError);
    });
  });

  describe('getVerifier()', () => {
    it('should return the signature verifier instance', () => {
      const returnedVerifier = module.getVerifier();
      expect(returnedVerifier).toBeInstanceOf(SignatureVerifier);
    });
  });

  describe('Factory functions', () => {
    it('getExternalSignerModule() should return singleton instance', () => {
      const instance1 = getExternalSignerModule();
      const instance2 = getExternalSignerModule();

      expect(instance1).toBe(instance2);
      expect(instance1).toBeInstanceOf(ExternalSignerModule);
    });

    it('createExternalSignerModule() should create new instance with custom options', () => {
      const customTtl = 60 * 60 * 1000;
      const instance = createExternalSignerModule({ signingTtlMs: customTtl });

      expect(instance).toBeInstanceOf(ExternalSignerModule);
    });
  });
});

describe('Utility Functions', () => {
  describe('combineTransactionWithWitnesses()', () => {
    it('should successfully combine unsigned transaction with witness set', () => {
      const result = combineTransactionWithWitnesses(
        VALID_UNSIGNED_TX_CBOR,
        VALID_WITNESS_SET_CBOR
      );

      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);

      // Verify the result is valid CBOR
      expect(() => Buffer.from(result, 'hex')).not.toThrow();
    });

    it('should throw TransactionValidationError for invalid transaction CBOR', () => {
      expect(() => {
        combineTransactionWithWitnesses('invalid-hex', VALID_WITNESS_SET_CBOR);
      }).toThrow(TransactionValidationError);
    });

    it('should throw TransactionValidationError for invalid witness CBOR', () => {
      expect(() => {
        combineTransactionWithWitnesses(VALID_UNSIGNED_TX_CBOR, 'invalid-hex');
      }).toThrow(TransactionValidationError);
    });

    it('should produce valid signed transaction CBOR', () => {
      const result = combineTransactionWithWitnesses(
        VALID_UNSIGNED_TX_CBOR,
        VALID_WITNESS_SET_CBOR
      );

      // Should be parseable as CBOR array
      const decoded = cbor.decodeFirstSync(Buffer.from(result, 'hex'));
      expect(Array.isArray(decoded)).toBe(true);
      expect(decoded.length).toBeGreaterThanOrEqual(2);
    });

    it('should merge wallet VKeys into existing witness set, preserving script witnesses', () => {
      // Build a Plutus-like unsigned tx with script witnesses in the witness set
      // Witness set keys: 5=redeemers, 6=datums, 7=plutus_v3_scripts
      const txBody = cbor.decodeFirstSync(Buffer.from(VALID_UNSIGNED_TX_CBOR, 'hex'))[0];
      const fakeRedeemer = Buffer.from('redeemer-data');
      const fakeDatum = Buffer.from('datum-data');
      const fakeScript = Buffer.from('plutus-v3-script');

      // Build witness set with script witnesses (no VKeys yet)
      const origWitnessSet = new Map();
      origWitnessSet.set(5, [fakeRedeemer]);   // redeemers
      origWitnessSet.set(6, [fakeDatum]);       // datums
      origWitnessSet.set(7, [fakeScript]);      // plutus_v3_scripts

      const plutusTx = [txBody, origWitnessSet, true, null];
      const plutusTxCbor = cbor.encodeOne(plutusTx).toString('hex');

      // Combine with wallet witness set (only VKeys at key 0)
      const result = combineTransactionWithWitnesses(plutusTxCbor, VALID_WITNESS_SET_CBOR);

      // Verify result contains ALL witness keys
      const decoded = cbor.decodeFirstSync(Buffer.from(result, 'hex'));
      const resultWs = decoded[1];

      expect(resultWs).toBeInstanceOf(Map);
      expect(resultWs.has(0)).toBe(true);   // VKey witnesses (from wallet)
      expect(resultWs.has(5)).toBe(true);   // redeemers (preserved from builder)
      expect(resultWs.has(6)).toBe(true);   // datums (preserved from builder)
      expect(resultWs.has(7)).toBe(true);   // plutus_v3_scripts (preserved from builder)

      // VKeys should come from wallet (CBOR tag 258 wraps the array for sets)
      const vkeys = resultWs.get(0);
      expect(vkeys).toBeDefined();
      // Script witnesses should be unchanged
      expect(resultWs.get(5)).toEqual([fakeRedeemer]);
      expect(resultWs.get(6)).toEqual([fakeDatum]);
      expect(resultWs.get(7)).toEqual([fakeScript]);
    });

    it('should correctly count Conway-era CborTag(258, ...) wrapped VKey witnesses', () => {
      // VALID_WITNESS_SET_CBOR starts with a100d90102... meaning:
      // Map(1 entry): key=0, value=CborTag(258, CborArray([...]))
      // This is Conway-era witness format
      const result = combineTransactionWithWitnesses(
        VALID_UNSIGNED_TX_CBOR,
        VALID_WITNESS_SET_CBOR
      );

      // The result should be a valid hex string
      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
      expect(result).toMatch(/^[a-f0-9]+$/);

      // Parse and verify witness structure is preserved as CborMap
      const decoded = cbor.decodeFirstSync(Buffer.from(result, 'hex'));
      const ws = decoded[1];
      expect(ws).toBeInstanceOf(Map);
      expect(ws.has(0)).toBe(true); // VKey witnesses present
    });

    it('should handle simple transaction without script witnesses (fallback path)', () => {
      // Standard non-Plutus transaction — existing behavior should still work
      const result = combineTransactionWithWitnesses(
        VALID_UNSIGNED_TX_CBOR,
        VALID_WITNESS_SET_CBOR
      );

      const decoded = cbor.decodeFirstSync(Buffer.from(result, 'hex'));
      expect(Array.isArray(decoded)).toBe(true);
      // Witness set should have VKeys
      const ws = decoded[1];
      if (ws instanceof Map) {
        expect(ws.has(0)).toBe(true);
      }
    });
  });

  describe('isWitnessSetCbor()', () => {
    it('should return false for full transaction CBOR', () => {
      const result = isWitnessSetCbor(VALID_SIGNED_TX_CBOR);
      expect(result).toBe(false);
    });

    it('should return false for unsigned transaction CBOR', () => {
      const result = isWitnessSetCbor(VALID_UNSIGNED_TX_CBOR);
      expect(result).toBe(false);
    });

    it('should return true for witness set CBOR', () => {
      const result = isWitnessSetCbor(VALID_WITNESS_SET_CBOR);
      expect(result).toBe(true);
    });

    it('should return false for invalid CBOR', () => {
      const result = isWitnessSetCbor('invalid-cbor-string');
      expect(result).toBe(false);
    });

    it('should return false for empty string', () => {
      const result = isWitnessSetCbor('');
      expect(result).toBe(false);
    });
  });
});
