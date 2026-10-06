// No cds mocks needed — parseTransaction is a pure function with no CAP/DB dependency.

import {
  Tx,
  TxBody,
  TxOut,
  UTxO,
  TxOutRef,
  Address,
  Value,
  Hash32,
  PubKeyHash,
  Signature,
  TxWitnessSet,
  VKeyWitness,
  AuxiliaryData,
  Script,
  DataI,
  CertStakeRegistration,
  Credential,
  StakeAddress,
  Hash28,
} from '@harmoniclabs/buildooor';
// AuxiliaryData/TxMetadata check `instanceof` against the classes at the dist/tx/metadata
// paths; the buildooor barrel re-exports the eras/common variants, which fail that check.
// Import from the paths the library uses internally.
import { TxMetadata } from '@harmoniclabs/cardano-ledger-ts/dist/tx/metadata/TxMetadata';
import { TxMetadatumInt } from '@harmoniclabs/cardano-ledger-ts/dist/tx/metadata/TxMetadatum';
import { Cbor, CborArray, CborMap, CborTag, CborUInt, CborBytes } from '@harmoniclabs/cbor';

import { parseTransaction } from '../../srv/cbor';
import { isValidTxCborHex } from '../../srv/utils/validators';
import { TransactionValidationError } from '../../srv/utils/errors';
import { ERROR_CODES } from '../../srv/utils/error-codes';
import { MAX_TX_CBOR_HEX_LENGTH } from '../../srv/utils/const';

// ---------------------------------------------------------------------------
// Test fixtures and helpers
// ---------------------------------------------------------------------------

const TEST_ADDRESS_TESTNET = 'addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp';
const TX_HASH_A = 'a'.repeat(64);
const TX_HASH_B = 'b'.repeat(64);

// A valid PlutusV3 script hex (CBOR-wrapped flat UPLC — same fixture used in other unit tests).
const VALID_PLUTUS_V3_SCRIPT_HEX =
  '585401010029800aba2aba1aab9eaab9dab9a4888896600264653001300600198031803800cc0180092225980099b8748000c01cdd500144c9289bae30093008375400516401830060013003375400d149a26cac8009';

// Ed25519 key hash (28 bytes = 56 hex chars) and tx body hash (32 bytes) placeholders.
const KEY_HASH_28 = '1'.repeat(56);

function cborHex(tx: Tx): string {
  return Buffer.from(tx.toCbor()).toString('hex');
}

function buildTx(opts: {
  inputs?: UTxO[];
  outputs: TxOut[];
  fee?: bigint;
  ttl?: bigint;
  validityStart?: bigint;
  mint?: Value;
  requiredSigners?: PubKeyHash[];
  auxiliaryData?: AuxiliaryData | null;
  witnesses?: TxWitnessSet;
  collateralInputs?: UTxO[];
  extraBody?: Partial<ConstructorParameters<typeof TxBody>[0]>;
}): Tx {
  const defaultInput = makeUtxo(TX_HASH_A, 0, TEST_ADDRESS_TESTNET, 10_000_000n);
  const body = new TxBody({
    inputs: (opts.inputs && opts.inputs.length > 0 ? opts.inputs : [defaultInput]) as [UTxO, ...UTxO[]],
    outputs: opts.outputs,
    fee: opts.fee ?? 200_000n,
    ttl: opts.ttl,
    validityIntervalStart: opts.validityStart,
    mint: opts.mint,
    requiredSigners: opts.requiredSigners,
    collateralInputs: opts.collateralInputs,
    ...opts.extraBody,
  });
  return new Tx({
    body,
    witnesses: opts.witnesses ?? new TxWitnessSet({}),
    auxiliaryData: opts.auxiliaryData,
  });
}

function makeUtxo(txHashHex: string, idx: number, bech32: string, lovelace: bigint): UTxO {
  return new UTxO({
    utxoRef: new TxOutRef({ id: new Hash32(txHashHex), index: idx }),
    resolved: new TxOut({
      address: Address.fromString(bech32),
      value: Value.lovelaces(lovelace),
    }),
  });
}

function makeOutput(bech32: string, lovelace: bigint, extras?: Partial<{ datum: Hash32 | DataI; refScript: Script }>) : TxOut {
  return new TxOut({
    address: Address.fromString(bech32),
    value: Value.lovelaces(lovelace),
    datum: extras?.datum,
    refScript: extras?.refScript,
  });
}

// ---------------------------------------------------------------------------
// Round-trip parsing
// ---------------------------------------------------------------------------

describe('parseTransaction — round-trip from built CBOR', () => {
  it('parses a simple ADA-only transfer', () => {
    const tx = buildTx({
      outputs: [makeOutput(TEST_ADDRESS_TESTNET, 5_000_000n)],
      fee: 180_000n,
      ttl: 50_000_000n,
      validityStart: 49_000_000n,
    });

    const parsed = parseTransaction(cborHex(tx));

    expect(parsed.txHash).toBe(tx.body.hash.toString());
    expect(parsed.fee).toBe('180000');
    expect(parsed.validityEnd).toBe('50000000');
    expect(parsed.validityStart).toBe('49000000');
    expect(parsed.inputs).toHaveLength(1);
    expect(parsed.inputs[0]).toEqual({ txHash: TX_HASH_A, outputIndex: 0 });
    expect(parsed.outputs).toHaveLength(1);
    expect(parsed.outputs[0].lovelace).toBe('5000000');
    expect(parsed.outputs[0].assets).toHaveLength(0);
    expect(parsed.outputs[0].datumHash).toBeNull();
    expect(parsed.outputs[0].inlineDatumHex).toBeNull();
    expect(parsed.outputs[0].referenceScriptHex).toBeNull();
    expect(parsed.mint).toHaveLength(0);
    expect(parsed.requiredSigners).toHaveLength(0);
    expect(parsed.scriptDataHash).toBeNull();
    expect(parsed.collateral).toHaveLength(0);
    expect(parsed.metadataLabels).toHaveLength(0);
    expect(parsed.witnesses).toEqual({
      vkeyCount: 0,
      nativeScripts: 0,
      plutusScripts: 0,
      plutusData: 0,
      redeemers: 0,
    });
  });

  it('parses native-asset output with correct unit formatting', () => {
    const policyId = 'def68337867cb4f1f95b6b811fedbfcdd7780d10a95cc072077088ea';
    const assetNameHex = '546f6b656e4d';
    const assetUnit = policyId + assetNameHex;

    const value = Value.add(
      Value.lovelaces(3_000_000n),
      Value.singleAsset(policyId, Buffer.from(assetNameHex, 'hex'), 42n),
    );
    const tx = buildTx({
      outputs: [new TxOut({ address: Address.fromString(TEST_ADDRESS_TESTNET), value })],
    });

    const parsed = parseTransaction(cborHex(tx));

    expect(parsed.outputs[0].lovelace).toBe('3000000');
    expect(parsed.outputs[0].assets).toEqual([{ unit: assetUnit, quantity: '42' }]);
  });

  it('parses mint value with signed quantities (burn = negative)', () => {
    const policyId = 'def68337867cb4f1f95b6b811fedbfcdd7780d10a95cc072077088ea';
    const mintName = Buffer.from('4d696e74', 'hex'); // "Mint"
    const burnName = Buffer.from('4275726e', 'hex'); // "Burn"

    const mint = Value.add(
      Value.singleAsset(policyId, mintName, 100n),
      Value.singleAsset(policyId, burnName, -5n),
    );
    const tx = buildTx({
      outputs: [makeOutput(TEST_ADDRESS_TESTNET, 2_000_000n)],
      mint,
    });

    const parsed = parseTransaction(cborHex(tx));

    const entries = [...parsed.mint].sort((a, b) => a.unit.localeCompare(b.unit));
    expect(entries).toHaveLength(2);
    const quantitiesByName = Object.fromEntries(entries.map((e) => [e.unit.slice(56), e.quantity]));
    expect(quantitiesByName['4d696e74']).toBe('100');
    expect(quantitiesByName['4275726e']).toBe('-5');
  });

  it('parses required signers as hex strings', () => {
    const signer1 = new PubKeyHash(KEY_HASH_28);
    const signer2 = new PubKeyHash('2'.repeat(56));
    const tx = buildTx({
      outputs: [makeOutput(TEST_ADDRESS_TESTNET, 2_000_000n)],
      requiredSigners: [signer1, signer2],
    });

    const parsed = parseTransaction(cborHex(tx));

    expect(parsed.requiredSigners).toEqual([KEY_HASH_28, '2'.repeat(56)]);
  });

  it('parses collateral inputs', () => {
    const collateral = makeUtxo(TX_HASH_B, 1, TEST_ADDRESS_TESTNET, 5_000_000n);
    const tx = buildTx({
      outputs: [makeOutput(TEST_ADDRESS_TESTNET, 2_000_000n)],
      collateralInputs: [collateral],
    });

    const parsed = parseTransaction(cborHex(tx));

    expect(parsed.collateral).toEqual([{ txHash: TX_HASH_B, outputIndex: 1 }]);
  });

  it('parses inline datum into hex CBOR', () => {
    const tx = buildTx({
      outputs: [makeOutput(TEST_ADDRESS_TESTNET, 2_000_000n, { datum: new DataI(42n) })],
    });

    const parsed = parseTransaction(cborHex(tx));

    expect(parsed.outputs[0].datumHash).toBeNull();
    // DataI(42) encodes as CBOR 0x182a
    expect(parsed.outputs[0].inlineDatumHex).toBe('182a');
  });

  it('returns an inline datum with a definite map as it stands in the transaction', () => {
    const tx = buildTx({
      outputs: [makeOutput(TEST_ADDRESS_TESTNET, 2_000_000n, { datum: new DataI(42n) })],
    });
    // swap the datum #6.24(h'182a') for #6.24(h'a10102'), a definite map that re-encodes indefinite
    const hex = cborHex(tx).replace('d81842182a', 'd81843a10102');

    const parsed = parseTransaction(hex);

    expect(parsed.outputs[0].inlineDatumHex).toBe('a10102');
  });

  it('parses datum hash reference', () => {
    const datumHash = new Hash32('c'.repeat(64));
    const tx = buildTx({
      outputs: [makeOutput(TEST_ADDRESS_TESTNET, 2_000_000n, { datum: datumHash })],
    });

    const parsed = parseTransaction(cborHex(tx));

    expect(parsed.outputs[0].datumHash).toBe('c'.repeat(64));
    expect(parsed.outputs[0].inlineDatumHex).toBeNull();
  });

  it('parses CIP-33 reference script on an output', () => {
    const script = Script.fromCbor(Buffer.from(VALID_PLUTUS_V3_SCRIPT_HEX, 'hex'));
    const tx = buildTx({
      outputs: [makeOutput(TEST_ADDRESS_TESTNET, 20_000_000n, { refScript: script })],
    });

    const parsed = parseTransaction(cborHex(tx));

    expect(parsed.outputs[0].referenceScriptHex).not.toBeNull();
    // Round-tripped script should produce the same script hash
    const roundtrip = Script.fromCbor(Buffer.from(parsed.outputs[0].referenceScriptHex!, 'hex'));
    expect(roundtrip.hash.toString()).toBe(script.hash.toString());
  });

  // Build the tx (Conway tag-259 aux data), then swap the aux-data slot
  // (tx = [body, wits, isValid, aux]) for a plain Shelley metadata map before parsing.
  it('parses metadata labels from auxiliary data (legacy Shelley format)', () => {
    const metadata = new TxMetadata({
      '721': new TxMetadatumInt(1n),
      '674': new TxMetadatumInt(2n),
    });
    const tx = buildTx({
      outputs: [makeOutput(TEST_ADDRESS_TESTNET, 2_000_000n)],
      auxiliaryData: new AuxiliaryData({ metadata }),
    });

    const txCbor = Cbor.parse(Buffer.from(cborHex(tx), 'hex')) as CborArray;
    txCbor.array[3] = metadata.toCborObj(); // tag-259 → plain metadata map (Shelley)
    const legacyHex = Buffer.from(Cbor.encode(txCbor)).toString('hex');

    const parsed = parseTransaction(legacyHex);

    expect(parsed.metadataLabels.sort()).toEqual(['674', '721']);
  });

  // AuxiliaryData.fromCborObj treats the Conway script-collection fields as optional,
  // so metadata-only aux_data decodes instead of throwing.
  it('parses metadata labels from Conway tag-259 auxiliary data', () => {
    const metadata = new TxMetadata({
      '721': new TxMetadatumInt(1n),
      '674': new TxMetadatumInt(2n),
    });
    const tx = buildTx({
      outputs: [makeOutput(TEST_ADDRESS_TESTNET, 2_000_000n)],
      auxiliaryData: new AuxiliaryData({ metadata }),
    });

    const parsed = parseTransaction(cborHex(tx));

    expect(parsed.metadataLabels.sort()).toEqual(['674', '721']);
  });

  it('preserves original Conway auxiliary-data CBOR through the runtime patch', () => {
    // Key 0 is deliberately encoded non-canonically as 0x18 0x00. The parser must
    // retain the original SubCborRef so a parse/toCbor round trip does not silently
    // canonicalize and therefore change the auxiliary-data hash.
    const originalHex = 'd90103a11800a0';
    const auxiliaryData = AuxiliaryData.fromCbor(Buffer.from(originalHex, 'hex'));

    expect(Buffer.from(auxiliaryData.toCbor()).toString('hex')).toBe(originalHex);
  });

  it('counts vkey witnesses on a signed-style CBOR', () => {
    const vkey = new Hash32('3'.repeat(64));
    const signature = new Signature('4'.repeat(128)); // Ed25519 signature: 64 bytes / 128 hex
    const witnesses = new TxWitnessSet({
      vkeyWitnesses: [new VKeyWitness({ vkey, signature })],
    });
    const tx = buildTx({
      outputs: [makeOutput(TEST_ADDRESS_TESTNET, 2_000_000n)],
      witnesses,
    });

    const parsed = parseTransaction(cborHex(tx));

    expect(parsed.witnesses.vkeyCount).toBe(1);
  });

  it('body hash is stable between unsigned CBOR and signed CBOR of the same body', () => {
    const body = new TxBody({
      inputs: [makeUtxo(TX_HASH_A, 0, TEST_ADDRESS_TESTNET, 10_000_000n)],
      outputs: [makeOutput(TEST_ADDRESS_TESTNET, 2_000_000n)],
      fee: 200_000n,
    });
    const unsigned = new Tx({ body, witnesses: new TxWitnessSet({}) });
    const signed = new Tx({
      body,
      witnesses: new TxWitnessSet({
        vkeyWitnesses: [
          new VKeyWitness({ vkey: new Hash32('3'.repeat(64)), signature: new Signature('4'.repeat(128)) }),
        ],
      }),
    });

    const unsignedHash = parseTransaction(cborHex(unsigned)).txHash;
    const signedHash = parseTransaction(cborHex(signed)).txHash;

    expect(unsignedHash).toBe(signedHash);
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe('parseTransaction — value-moving body fields', () => {
  const stakeAddress = new StakeAddress({ network: 'testnet', credentials: new Hash28(KEY_HASH_28), type: 'stakeKey' });

  it('reports withdrawals, certificates, donation, treasury value and reference inputs', () => {
    const tx = buildTx({
      outputs: [makeOutput(TEST_ADDRESS_TESTNET, 5_000_000n)],
      extraBody: {
        withdrawals: [{ rewardAccount: stakeAddress, amount: 1_500_000n }],
        certs: [new CertStakeRegistration({ stakeCredential: Credential.keyHash(KEY_HASH_28) })],
        refInputs: [makeUtxo(TX_HASH_B, 3, TEST_ADDRESS_TESTNET, 2_000_000n)],
        donation: 1_000_000n,
        currentTreasuryValue: 9_000_000n,
        network: 'testnet',
      },
    });

    const parsed = parseTransaction(cborHex(tx));

    expect(parsed.withdrawals).toEqual([{ rewardAddress: stakeAddress.toString(), lovelace: '1500000' }]);
    expect(parsed.certificates).toEqual([{ index: 0, type: 'StakeRegistration' }]);
    expect(parsed.referenceInputs).toEqual([{ txHash: TX_HASH_B, outputIndex: 3 }]);
    expect(parsed.treasuryDonation).toBe('1000000');
    expect(parsed.currentTreasuryValue).toBe('9000000');
    expect(parsed.networkId).toBe(0);
    expect(parsed.votingProcedures).toBe(0);
    expect(parsed.proposalProcedures).toBe(0);
  });

  it('counts votes and proposals the library decoder drops and keeps the raw network byte', () => {
    const raw = Cbor.parse(cborHex(buildTx({ outputs: [makeOutput(TEST_ADDRESS_TESTNET, 5_000_000n)] }))) as CborArray;
    const body = raw.array[0] as CborMap;
    const voter = new CborArray([new CborUInt(0), new CborBytes(Buffer.from(KEY_HASH_28, 'hex'))]);
    const vote = (i: number) => ({ k: new CborArray([new CborBytes(Buffer.from(TX_HASH_A, 'hex')), new CborUInt(i)]), v: new CborArray([new CborUInt(1)]) });
    body.map.push(
      { k: new CborUInt(19), v: new CborMap([{ k: voter, v: new CborMap([vote(0), vote(1)]) }]) },
      { k: new CborUInt(20), v: new CborTag(258, new CborArray([new CborUInt(0)])) },
      { k: new CborUInt(15), v: new CborUInt(2) },
    );
    const hex = Buffer.from(Cbor.encode(new CborArray(raw.array))).toString('hex');

    const parsed = parseTransaction(hex);

    expect(parsed.votingProcedures).toBe(2);
    expect(parsed.proposalProcedures).toBe(1);
    expect(parsed.networkId).toBe(2);
  });

  it('reports empty fields when the body has none of them', () => {
    const parsed = parseTransaction(cborHex(buildTx({ outputs: [makeOutput(TEST_ADDRESS_TESTNET, 5_000_000n)] })));

    expect(parsed.withdrawals).toEqual([]);
    expect(parsed.certificates).toEqual([]);
    expect(parsed.referenceInputs).toEqual([]);
    expect(parsed.treasuryDonation).toBeNull();
    expect(parsed.currentTreasuryValue).toBeNull();
    expect(parsed.networkId).toBeNull();
  });

  it('reports each output size as the length of its bytes in the transaction', () => {
    const hex = cborHex(buildTx({
      outputs: [makeOutput(TEST_ADDRESS_TESTNET, 5_000_000n), makeOutput(TEST_ADDRESS_TESTNET, 7_000_000n, { datum: new DataI(42) })],
    }));

    const raw = Cbor.parse(hex) as CborArray;
    const body = raw.array[0] as unknown as { map: Array<{ k: { num: bigint }; v: CborArray }> };
    const outputs = body.map.find((e) => e.k.num === 1n)!.v;
    const expected = outputs.array.map((o) => o.subCborRef!.toBuffer().length);

    expect(parseTransaction(hex).outputs.map((o) => o.cborSize)).toEqual(expected);
  });

  it('counts the bytes as received, not a shorter re-encoding', () => {
    const canonical = cborHex(buildTx({ outputs: [makeOutput(TEST_ADDRESS_TESTNET, 5_000_000n)] }));
    // 5 000 000 lovelace as an 8-byte uint instead of the minimal 4-byte form: 4 bytes longer
    const wide = canonical.replace('1a004c4b40', '1b00000000004c4b40');
    expect(wide).not.toBe(canonical);

    const [canonicalSize] = parseTransaction(canonical).outputs.map((o) => o.cborSize);
    const [wideSize] = parseTransaction(wide).outputs.map((o) => o.cborSize);

    expect(wideSize).toBe(canonicalSize + 4);
  });
});

describe('parseTransaction — error handling', () => {
  it('throws TransactionValidationError with TX_PARSE_FAILED on malformed CBOR', () => {
    const garbage = 'deadbeef'; // valid hex, not a tx
    expect(() => parseTransaction(garbage)).toThrow(TransactionValidationError);
    try {
      parseTransaction(garbage);
    } catch (e: any) {
      expect(e).toBeInstanceOf(TransactionValidationError);
      expect(e.code).toBe(ERROR_CODES.TX_PARSE_FAILED);
      expect(e.statusCode).toBe(400);
    }
  });

  it('throws on empty string input (invalid CBOR)', () => {
    expect(() => parseTransaction('')).toThrow(TransactionValidationError);
  });
});

// ---------------------------------------------------------------------------
// isValidTxCborHex — DoS guard
// ---------------------------------------------------------------------------

describe('isValidTxCborHex — DoS guard', () => {
  it('accepts valid even-length hex within the size limit', () => {
    expect(isValidTxCborHex('deadbeef')).toBe(true);
    expect(isValidTxCborHex('a'.repeat(MAX_TX_CBOR_HEX_LENGTH))).toBe(true);
  });

  it('rejects odd-length hex', () => {
    expect(isValidTxCborHex('abc')).toBe(false);
  });

  it('rejects non-hex characters', () => {
    expect(isValidTxCborHex('zzzzzzzz')).toBe(false);
  });

  it('rejects input exceeding MAX_TX_CBOR_HEX_LENGTH', () => {
    expect(isValidTxCborHex('a'.repeat(MAX_TX_CBOR_HEX_LENGTH + 2))).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidTxCborHex('')).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isValidTxCborHex(null)).toBe(false);
    expect(isValidTxCborHex(undefined)).toBe(false);
    expect(isValidTxCborHex(123)).toBe(false);
  });
});
