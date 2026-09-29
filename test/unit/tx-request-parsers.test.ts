/**
 * Shared Build*-payload parsers (srv/utils/tx-request-parsers.ts). They back both the
 * CardanoTransactionService handlers and the wallet worker, so every branch is exercised here once.
 */

// Imported above the vi.mock block only so `vi` is declared before it is read;
// vitest hoists vi.mock above all imports regardless, so the order is cosmetic.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// Mock cds logger (validators.ts imports cds)
vi.mock('@sap/cds', () => {
  const cdsMock = {
    log: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    utils: { uuid: vi.fn(() => 'test-uuid-1234') },
  };
  return { default: cdsMock, ...cdsMock };
});

import {
  parseUtxoRefArray,
  parseRequiredSigners,
  parseAssetsArray,
  parseExtraOutputs,
  parseMintActionPolicyFields,
  parseOutputList,
  parseScriptInputs,
  parsePolicyMintActions,
  MAX_EXTRA_OUTPUTS,
  MAX_SCRIPT_INPUTS,
} from '../../srv/utils/tx-request-parsers';
import { TEST_FIXTURES } from '../integration/test-fixtures';
import { setActiveNetwork } from '../../srv/utils/network-context';

// Address validation is network-aware — pin the active network for the suite.
beforeAll(() => setActiveNetwork('preview'));
afterAll(() => setActiveNetwork(null));

const TX_HASH = TEST_FIXTURES.validTxHash;
const ADDR = TEST_FIXTURES.validBech32Address;
const UNIT = TEST_FIXTURES.assetUnit;
const KEY_HASH = 'a'.repeat(56);

describe('parseUtxoRefArray', () => {
  it('returns undefined for absent input', () => {
    expect(parseUtxoRefArray(undefined, 'forceInputsJson')).toEqual({ parsed: undefined });
  });

  it('parses valid refs', () => {
    const result = parseUtxoRefArray(JSON.stringify([{ txHash: TX_HASH, outputIndex: 2 }]), 'forceInputsJson');
    expect(result.error).toBeUndefined();
    expect(result.parsed).toEqual([{ txHash: TX_HASH, outputIndex: 2 }]);
  });

  it('treats an empty array as no-op', () => {
    expect(parseUtxoRefArray('[]', 'referenceInputsJson')).toEqual({ parsed: undefined });
  });

  it('rejects non-array JSON', () => {
    expect(parseUtxoRefArray('{"txHash":"x"}', 'forceInputsJson').error).toMatch(/must be a JSON array/);
  });

  it('rejects non-object entries', () => {
    expect(parseUtxoRefArray('["nope"]', 'forceInputsJson').error).toMatch(/must be an object/);
  });

  it('rejects invalid txHash and negative/non-integer outputIndex', () => {
    expect(parseUtxoRefArray(JSON.stringify([{ txHash: 'beef', outputIndex: 0 }]), 'forceInputsJson').error)
      .toMatch(/64-hex txHash/);
    expect(parseUtxoRefArray(JSON.stringify([{ txHash: TX_HASH, outputIndex: -1 }]), 'forceInputsJson').error)
      .toMatch(/non-negative integer/);
    expect(parseUtxoRefArray(JSON.stringify([{ txHash: TX_HASH, outputIndex: 1.5 }]), 'referenceInputsJson').error)
      .toMatch(/non-negative integer/);
  });

  it('names the entry after the field in error messages', () => {
    expect(parseUtxoRefArray('["x"]', 'referenceInputsJson').error).toMatch(/referenceInputs entry/);
  });
});

describe('parseRequiredSigners', () => {
  it('returns undefined for absent input', () => {
    expect(parseRequiredSigners(undefined)).toEqual({ parsed: undefined });
  });

  it('parses an array of 56-hex key hashes', () => {
    const result = parseRequiredSigners(JSON.stringify([KEY_HASH]));
    expect(result.error).toBeUndefined();
    expect(result.parsed).toEqual([KEY_HASH]);
  });

  it('rejects malformed entries', () => {
    expect(parseRequiredSigners(JSON.stringify(['nope'])).error).toBeDefined();
    expect(parseRequiredSigners('{"not":"array"}').error).toBeDefined();
  });
});

describe('parseAssetsArray', () => {
  it('returns undefined for absent input', () => {
    expect(parseAssetsArray(undefined, 'assetsJson')).toEqual({ parsed: undefined });
  });

  it('parses valid unit/quantity entries', () => {
    const result = parseAssetsArray(JSON.stringify([{ unit: UNIT, quantity: '100' }]), 'assetsJson');
    expect(result.error).toBeUndefined();
    expect(result.parsed).toEqual([{ unit: UNIT, quantity: '100' }]);
  });

  it('rejects non-array JSON and non-object entries', () => {
    expect(parseAssetsArray('"x"', 'assetsJson').error).toMatch(/must be a JSON array/);
    expect(parseAssetsArray('[1]', 'assetsJson').error).toMatch(/must be an object/);
  });

  it('rejects the pseudo-unit "lovelace" and invalid units', () => {
    expect(parseAssetsArray(JSON.stringify([{ unit: 'lovelace', quantity: '1' }]), 'assetsJson').error)
      .toMatch(/valid asset unit/);
    expect(parseAssetsArray(JSON.stringify([{ unit: 'beef', quantity: '1' }]), 'assetsJson').error)
      .toMatch(/valid asset unit/);
  });

  it('rejects zero, negative, and non-string quantities', () => {
    expect(parseAssetsArray(JSON.stringify([{ unit: UNIT, quantity: '0' }]), 'assetsJson').error).toBeDefined();
    expect(parseAssetsArray(JSON.stringify([{ unit: UNIT, quantity: '-5' }]), 'assetsJson').error).toBeDefined();
    expect(parseAssetsArray(JSON.stringify([{ unit: UNIT, quantity: 5 }]), 'assetsJson').error).toBeDefined();
  });
});

describe('parseExtraOutputs', () => {
  const entry = { address: ADDR, lovelaceAmount: '2000000' };

  it('returns undefined for absent input and empty arrays', () => {
    expect(parseExtraOutputs(undefined)).toEqual({ parsed: undefined });
    expect(parseExtraOutputs('[]')).toEqual({ parsed: undefined });
  });

  it('parses a full entry with assets, inline datum and reference script', () => {
    const result = parseExtraOutputs(JSON.stringify([{
      ...entry,
      assets: [{ unit: UNIT, quantity: '7' }],
      inlineDatumJson: JSON.stringify({ constructor: 0, fields: [] }),
      referenceScriptHex: 'deadbeef',
    }]));
    expect(result.error).toBeUndefined();
    expect(result.parsed).toEqual([{
      address: ADDR,
      lovelaceAmount: '2000000',
      assets: [{ unit: UNIT, quantity: '7' }],
      inlineDatum: { constructor: 0, fields: [] },
      referenceScript: 'deadbeef',
    }]);
  });

  it('caps the number of entries', () => {
    const many = Array.from({ length: MAX_EXTRA_OUTPUTS + 1 }, () => entry);
    expect(parseExtraOutputs(JSON.stringify(many)).error).toMatch(/maximum/);
  });

  it('rejects invalid addresses and amounts', () => {
    expect(parseExtraOutputs(JSON.stringify([{ ...entry, address: 'nope' }])).error).toMatch(/Bech32/);
    expect(parseExtraOutputs(JSON.stringify([{ ...entry, lovelaceAmount: '0' }])).error).toMatch(/positive integer/);
    expect(parseExtraOutputs(JSON.stringify([{ ...entry, lovelaceAmount: 12 }])).error).toMatch(/positive integer/);
  });

  it('rejects malformed nested assets', () => {
    expect(parseExtraOutputs(JSON.stringify([{ ...entry, assets: 'x' }])).error).toMatch(/must be an array/);
    expect(parseExtraOutputs(JSON.stringify([{ ...entry, assets: [{ unit: 'lovelace', quantity: '1' }] }])).error)
      .toMatch(/valid asset unit/);
    expect(parseExtraOutputs(JSON.stringify([{ ...entry, assets: [{ unit: UNIT, quantity: '0' }] }])).error)
      .toMatch(/positive integer/);
  });

  it('rejects non-string inlineDatumJson and odd-length referenceScriptHex', () => {
    expect(parseExtraOutputs(JSON.stringify([{ ...entry, inlineDatumJson: 42 }])).error).toMatch(/JSON string/);
    expect(parseExtraOutputs(JSON.stringify([{ ...entry, referenceScriptHex: 'abc' }])).error).toMatch(/even-length hex/);
  });

  it('rejects non-array JSON and non-object entries', () => {
    expect(parseExtraOutputs('"x"').error).toMatch(/must be a JSON array/);
    expect(parseExtraOutputs('[3]').error).toMatch(/must be an object/);
  });
});

describe('parseMintActionPolicyFields (multi-policy mint)', () => {
  const SCRIPT = TEST_FIXTURES.validPlutusScript;

  it('returns empty fields for a plain action', () => {
    expect(parseMintActionPolicyFields({ assetUnit: 'aa', quantity: '1' }, 0))
      .toEqual({ script: undefined, redeemer: undefined });
  });

  it('parses a per-action script with a JSON-encoded redeemer', () => {
    const result = parseMintActionPolicyFields({
      mintingPolicyScript: SCRIPT,
      redeemerJson: JSON.stringify({ constructor: 0, fields: [] }),
    }, 1);
    expect(result.error).toBeUndefined();
    expect(result.script).toBe(SCRIPT);
    expect(result.redeemer).toEqual({ constructor: 0, fields: [] });
  });

  it('rejects a non-hex per-action script', () => {
    expect(parseMintActionPolicyFields({ mintingPolicyScript: 'zz' }, 2).error)
      .toMatch(/mintActions\[2\].mintingPolicyScript/);
  });

  it('rejects a non-string redeemerJson', () => {
    expect(parseMintActionPolicyFields({ mintingPolicyScript: SCRIPT, redeemerJson: { int: 1 } }, 0).error)
      .toMatch(/must be a JSON string/);
  });

  it('rejects malformed redeemerJson content', () => {
    expect(parseMintActionPolicyFields({ mintingPolicyScript: SCRIPT, redeemerJson: '{nope' }, 0).error)
      .toMatch(/redeemerJson/);
  });

  it('rejects a redeemer without its script', () => {
    expect(parseMintActionPolicyFields({ redeemerJson: '{}' }, 3).error)
      .toMatch(/requires mintActions\[3\].mintingPolicyScript/);
  });
});

describe('parseScriptInputs', () => {
  const H1 = '1'.repeat(64);
  const H2 = '2'.repeat(64);
  const redeemerJson = JSON.stringify({ constructor: 0, fields: [] });

  it('parses inline and reference-script entries with their own redeemers', () => {
    const r = parseScriptInputs(JSON.stringify([
      { txHash: H1, outputIndex: 0, validatorScript: 'abcd', scriptParamsJson: '[{"int":1}]', redeemerJson },
      { txHash: H2, outputIndex: 3, referenceScript: { txHash: H1, outputIndex: 1 }, redeemerJson: '{"int":5}', datumJson: '{"int":7}' },
    ]));
    expect(r.error).toBeUndefined();
    expect(r.parsed).toEqual<unknown[]>([
      { txHash: H1, outputIndex: 0, validatorScript: 'abcd', scriptParams: [{ int: 1 }], redeemer: { constructor: 0, fields: [] } },
      { txHash: H2, outputIndex: 3, referenceScript: { txHash: H1, outputIndex: 1 }, redeemer: { int: 5 }, datum: { int: 7 } },
    ]);
  });

  it.each([
    [undefined, 'scriptInputsJson is required'],
    ['[]', 'must be a non-empty JSON array'],
    [JSON.stringify([{ txHash: H1, outputIndex: 0, redeemerJson }]), 'exactly one of validatorScript or referenceScript'],
    [JSON.stringify([{ txHash: H1, outputIndex: 0, validatorScript: 'ab', referenceScript: { txHash: H2, outputIndex: 0 }, redeemerJson }]), 'exactly one of'],
    [JSON.stringify([{ txHash: H1, outputIndex: 0, validatorScript: 'ab' }]), 'scriptInputs[0] needs exactly one of redeemerJson or redeemerCbor'],
    [JSON.stringify([{ txHash: H1, outputIndex: 0, validatorScript: 'ab', redeemerJson }, { txHash: H1, outputIndex: 0, validatorScript: 'ab', redeemerJson }]), 'a second time'],
    [JSON.stringify([{ txHash: H1, outputIndex: 0, referenceScript: { txHash: H2 }, redeemerJson }]), 'referenceScript must be {txHash, outputIndex}'],
    [JSON.stringify([{ txHash: H1, outputIndex: 0, referenceScript: { txHash: H2, outputIndex: 0 }, scriptParamsJson: '[]', redeemerJson }]), 'inline validatorScript only'],
    [JSON.stringify([{ txHash: 'xyz', outputIndex: 0, validatorScript: 'ab', redeemerJson }]), 'txHash must be 64 hex'],
  ])('rejects %s', (json, message) => {
    expect(parseScriptInputs(json as string | undefined).error).toContain(message);
  });

  it('caps the number of script inputs', () => {
    const many = Array.from({ length: MAX_SCRIPT_INPUTS + 1 }, (_, i) => ({ txHash: H1, outputIndex: i, validatorScript: 'ab', redeemerJson }));
    expect(parseScriptInputs(JSON.stringify(many)).error).toContain('exceeds maximum');
  });
});

describe('parseOutputList (outputsJson)', () => {
  const HASH = 'a'.repeat(64);

  it('accepts a datum hash in outputsJson and keeps the order', () => {
    const r = parseOutputList(JSON.stringify([
      { address: ADDR, lovelaceAmount: '2000000', datumHash: HASH.toUpperCase() },
      { address: ADDR, lovelaceAmount: '1500000', inlineDatumJson: '{"int":1}' },
    ]), 'outputsJson');
    expect(r.parsed).toEqual([
      { address: ADDR, lovelaceAmount: '2000000', datumHash: HASH, assets: undefined, inlineDatum: undefined, referenceScript: undefined },
      { address: ADDR, lovelaceAmount: '1500000', assets: undefined, inlineDatum: { int: 1 }, referenceScript: undefined },
    ]);
  });

  it('names outputs[i] in errors and refuses a datum hash in extraOutputsJson', () => {
    expect(parseOutputList(JSON.stringify([{ address: ADDR, lovelaceAmount: '0' }]), 'outputsJson').error).toContain('outputs[0].lovelaceAmount');
    expect(parseOutputList(JSON.stringify([{ address: ADDR, lovelaceAmount: '1', datumHash: HASH }]), 'extraOutputsJson').error).toContain('only supported in outputsJson');
    expect(parseOutputList(JSON.stringify([{ address: ADDR, lovelaceAmount: '1', datumHash: HASH, inlineDatumJson: '{"int":1}' }]), 'outputsJson').error).toContain('not both');
  });
});

describe('parsePolicyMintActions', () => {
  // always-succeeds Plutus V3 script used across the builder tests
  const SCRIPT = '585401010029800aba2aba1aab9eaab9dab9a4888896600264653001300600198031803800cc0180092225980099b8748000c01cdd500144c9289bae30093008375400516401830060013003375400d149a26cac8009';
  const { Script } = require('@harmoniclabs/cardano-ledger-ts');
  const POLICY = Script.fromCbor(Buffer.from(SCRIPT, 'hex')).hash.toString();

  it('prefixes a bare asset name with the policy id of the action script', () => {
    const r = parsePolicyMintActions(JSON.stringify([{ assetUnit: '746f6b', quantity: '-5', mintingPolicyScript: SCRIPT, redeemerJson: '{"int":0}' }]));
    expect(r.parsed).toEqual([{ assetUnit: POLICY + '746f6b', quantity: -5n, mintingPolicyScript: SCRIPT, redeemerJson: { int: 0 } }]);
  });

  it('requires a script per action and a matching policy id', () => {
    expect(parsePolicyMintActions(JSON.stringify([{ assetUnit: '746f6b', quantity: '1' }])).error).toContain('mintingPolicyScript is required');
    expect(parsePolicyMintActions(JSON.stringify([{ assetUnit: 'ab'.repeat(28) + '746f6b', quantity: '1', mintingPolicyScript: SCRIPT }])).error).toContain('does not start with its policy id');
    expect(parsePolicyMintActions(JSON.stringify([{ assetUnit: '746f6b', quantity: '0', mintingPolicyScript: SCRIPT }])).error).toContain('non-zero');
  });
});

describe('PlutusData as CBOR', () => {
  const H1 = '1'.repeat(64);
  const UNIT_CBOR = 'd87980'; // Constr 0 []
  const deep = (constructors: number): string => {
    let v: unknown = { int: 1 };
    for (let i = 0; i < constructors; i++) v = { constructor: 0, fields: [v] };
    return JSON.stringify(v);
  };

  it('takes redeemerCbor / datumCbor instead of the JSON forms', () => {
    const r = parseScriptInputs(JSON.stringify([{ txHash: H1, outputIndex: 0, validatorScript: 'ab', redeemerCbor: UNIT_CBOR.toUpperCase(), datumCbor: UNIT_CBOR }]));
    expect(r.error).toBeUndefined();
    expect(r.parsed![0]).toMatchObject({ redeemerCbor: UNIT_CBOR, datumCbor: UNIT_CBOR });
  });

  it('accepts a redeemerJson twelve levels deep', () => {
    const r = parseScriptInputs(JSON.stringify([{ txHash: H1, outputIndex: 0, validatorScript: 'ab', redeemerJson: deep(6) }]));
    expect(r.error).toBeUndefined();
  });

  it('refuses both or neither redeemer form, and CBOR that is no PlutusData', () => {
    expect(parseScriptInputs(JSON.stringify([{ txHash: H1, outputIndex: 0, validatorScript: 'ab', redeemerCbor: UNIT_CBOR, redeemerJson: '{"int":1}' }])).error)
      .toContain('exactly one of redeemerJson or redeemerCbor');
    expect(parseScriptInputs(JSON.stringify([{ txHash: H1, outputIndex: 0, validatorScript: 'ab' }])).error)
      .toContain('exactly one of redeemerJson or redeemerCbor');
    expect(parseScriptInputs(JSON.stringify([{ txHash: H1, outputIndex: 0, validatorScript: 'ab', redeemerCbor: 'ff' }])).error)
      .toContain('is not PlutusData CBOR');
  });

  it('takes inlineDatumCbor on outputsJson only', () => {
    expect(parseOutputList(JSON.stringify([{ address: ADDR, lovelaceAmount: '2000000', inlineDatumCbor: UNIT_CBOR }]), 'outputsJson').parsed![0])
      .toMatchObject({ inlineDatumCbor: UNIT_CBOR });
    expect(parseOutputList(JSON.stringify([{ address: ADDR, lovelaceAmount: '2000000', inlineDatumCbor: UNIT_CBOR }]), 'extraOutputsJson').error)
      .toContain('only supported in outputsJson');
    expect(parseOutputList(JSON.stringify([{ address: ADDR, lovelaceAmount: '2000000', inlineDatumCbor: UNIT_CBOR, inlineDatumJson: '{"int":1}' }]), 'outputsJson').error)
      .toContain('not both');
  });
});
