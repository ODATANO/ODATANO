/**
 * Unit tests for the shared Build*-payload parsers (srv/utils/tx-request-parsers.ts).
 *
 * These parsers back BOTH the synchronous CardanoTransactionService handlers and
 * the wallet-worker's request transformation, so every accept/reject branch is
 * exercised here once instead of through two service layers.
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
  MAX_EXTRA_OUTPUTS,
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
