/**
 * Unit tests for the wallet-worker request transformation
 * (srv/blockchain/wallet-worker/build-request.ts).
 *
 * The stored job `requestJson` has the documented Build*-action payload shape;
 * prepareWorkerBuildRequest must produce exactly what the CardanoIndexer build
 * methods expect (assets, bigint mintActions, parsed metadata, assembled
 * plutusScriptExecution). Malformed payloads throw BackendError 400 — a
 * deterministic, terminal job failure.
 */

// Imported above the vi.mock block only so `vi` is declared before it is read;
// vitest hoists vi.mock above all imports regardless, so the order is cosmetic.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// Mock cds logger (validators/mappers/tx-build-helper import cds)
vi.mock('@sap/cds', () => {
  const cdsMock = {
    log: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    utils: { uuid: vi.fn(() => 'test-uuid-1234') },
  };
  return { default: cdsMock, ...cdsMock };
});

import { Script } from '@harmoniclabs/cardano-ledger-ts';
import { prepareWorkerBuildRequest } from '../../srv/blockchain/wallet-worker/build-request';
import { applyScriptParameters } from '../../srv/utils/tx-build-helper';
import { scriptHashToEnterpriseAddress } from '../../srv/utils/mappers';
import { BackendError } from '../../srv/utils/errors';
import { TEST_FIXTURES } from '../integration/test-fixtures';
import { setActiveNetwork } from '../../srv/utils/network-context';

// Address validation is network-aware — pin the active network for the suite.
beforeAll(() => setActiveNetwork('preview'));
afterAll(() => setActiveNetwork(null));

const ADDR = TEST_FIXTURES.validBech32Address;
const TX_HASH = TEST_FIXTURES.validTxHash;
const SCRIPT = TEST_FIXTURES.validPlutusScript;
const PARAM_SCRIPT = TEST_FIXTURES.parameterizedScript;
const KEY_HASH = 'a'.repeat(56);

const hashOf = (hex: string) => Script.fromCbor(Buffer.from(hex, 'hex')).hash.toString();
/** An asset unit under the fixture script's own policy (passes the prefix check). */
const scriptUnit = (assetNameHex: string) => hashOf(SCRIPT) + assetNameHex;

const base = { senderAddress: ADDR, recipientAddress: ADDR, lovelaceAmount: '2000000' };

function expectRejects(fn: () => unknown, pattern: RegExp) {
  try {
    fn();
    expect.unreachable('expected BackendError');
  } catch (err) {
    expect(err).toBeInstanceOf(BackendError);
    expect((err as BackendError).statusCode).toBe(400);
    expect((err as BackendError).message).toMatch(pattern);
  }
}

describe('prepareWorkerBuildRequest: simpleAda', () => {
  it('passes core fields through and transforms the *Json fields', () => {
    const result = prepareWorkerBuildRequest('simpleAda', {
      ...base,
      forceInputsJson: JSON.stringify([{ txHash: TX_HASH, outputIndex: 1 }]),
      outputDatumJson: JSON.stringify({ constructor: 0, fields: [] }),
      assetsJson: JSON.stringify([{ unit: TEST_FIXTURES.assetUnit, quantity: '10' }]),
      referenceScriptHex: 'deadbeef',
    }, 'preview') as Record<string, unknown>;

    expect(result.senderAddress).toBe(ADDR);
    expect(result.forceInputs).toEqual([{ txHash: TX_HASH, outputIndex: 1 }]);
    expect(result.outputDatum).toEqual({ constructor: 0, fields: [] });
    expect(result.assets).toEqual([{ unit: TEST_FIXTURES.assetUnit, quantity: '10' }]);
    expect(result.referenceScript).toBe('deadbeef');
    for (const consumed of ['forceInputsJson', 'outputDatumJson', 'assetsJson', 'referenceScriptHex', 'validatorScript', 'scriptParamsJson', 'lockOnScript']) {
      expect(result).not.toHaveProperty(consumed);
    }
  });

  it('rejects missing required fields with BackendError 400', () => {
    expectRejects(() => prepareWorkerBuildRequest('simpleAda', { senderAddress: ADDR }, 'preview'), /required/);
  });

  it('lockOnScript requires a validatorScript', () => {
    expectRejects(() => prepareWorkerBuildRequest('simpleAda', { ...base, lockOnScript: true }, 'preview'),
      /requires validatorScript/);
  });

  it('lockOnScript routes the output to the derived script address', () => {
    const result = prepareWorkerBuildRequest('simpleAda', {
      ...base, lockOnScript: true, validatorScript: SCRIPT,
    }, 'preview') as Record<string, unknown>;
    expect(result.recipientAddress).toBe(scriptHashToEnterpriseAddress(hashOf(SCRIPT), 'preview'));
  });

  it('lockOnScript with script params derives from the APPLIED script', () => {
    const applied = applyScriptParameters(PARAM_SCRIPT, [{ int: 42 }]);
    const result = prepareWorkerBuildRequest('simpleAda', {
      ...base, lockOnScript: true, validatorScript: PARAM_SCRIPT, scriptParamsJson: JSON.stringify([{ int: 42 }]),
    }, 'preview') as Record<string, unknown>;
    expect(result.recipientAddress).toBe(scriptHashToEnterpriseAddress(hashOf(applied), 'preview'));
  });

  it('rejects invalid JSON in optional fields', () => {
    expectRejects(() => prepareWorkerBuildRequest('simpleAda', { ...base, outputDatumJson: '{nope' }, 'preview'), /outputDatumJson/);
    expectRejects(() => prepareWorkerBuildRequest('simpleAda', { ...base, scriptParamsJson: '{"a":1}' }, 'preview'), /must be a JSON array/);
    expectRejects(() => prepareWorkerBuildRequest('simpleAda', { ...base, outputDatumJson: 42 }, 'preview'), /must be a JSON string/);
  });
});

describe('prepareWorkerBuildRequest: metadata', () => {
  it('parses metadataJson into an object', () => {
    const result = prepareWorkerBuildRequest('metadata', {
      ...base, metadataJson: JSON.stringify({ '674': { msg: ['hi'] } }),
    }, 'preview') as Record<string, unknown>;
    expect(result.metadataJson).toEqual({ '674': { msg: ['hi'] } });
  });

  it('rejects a missing metadataJson', () => {
    expectRejects(() => prepareWorkerBuildRequest('metadata', { ...base }, 'preview'), /metadataJson/);
  });
});

describe('prepareWorkerBuildRequest: multiAsset', () => {
  it('transforms assetsJson into assets', () => {
    const result = prepareWorkerBuildRequest('multiAsset', {
      ...base,
      assetsJson: JSON.stringify([{ unit: TEST_FIXTURES.assetUnit, quantity: '5' }]),
      outputDatumJson: JSON.stringify({ int: 1 }),
      referenceScriptHex: 'cafe',
    }, 'preview') as Record<string, unknown>;
    expect(result.assets).toEqual([{ unit: TEST_FIXTURES.assetUnit, quantity: '5' }]);
    expect(result.outputDatum).toEqual({ int: 1 });
    expect(result.referenceScript).toBe('cafe');
    expect(result).not.toHaveProperty('assetsJson');
  });

  it('rejects an empty asset list', () => {
    expectRejects(() => prepareWorkerBuildRequest('multiAsset', { ...base, assetsJson: '[]' }, 'preview'),
      /at least one asset/);
  });

  it('rejects invalid asset entries', () => {
    expectRejects(() => prepareWorkerBuildRequest('multiAsset', {
      ...base, assetsJson: JSON.stringify([{ unit: 'lovelace', quantity: '1' }]),
    }, 'preview'), /valid asset unit/);
  });
});

describe('prepareWorkerBuildRequest: mint', () => {
  const mintBase = {
    ...base,
    mintingPolicyScript: SCRIPT,
    mintActionsJson: JSON.stringify([{ assetUnit: scriptUnit('546f6b656e4d'), quantity: '1000' }]),
  };

  it('converts mint actions to bigint quantities and parses the optional fields', () => {
    const result = prepareWorkerBuildRequest('mint', {
      ...mintBase,
      requiredSignersJson: JSON.stringify([KEY_HASH]),
      inlineDatumJson: JSON.stringify({ int: 7 }),
      mintRedeemerJson: JSON.stringify({ constructor: 0, fields: [] }),
      forceInputsJson: JSON.stringify([{ txHash: TX_HASH, outputIndex: 0 }]),
      referenceInputsJson: JSON.stringify([{ txHash: TX_HASH, outputIndex: 3 }]),
      metadataJson: JSON.stringify({ '721': {} }),
    }, 'preview') as Record<string, unknown>;

    expect(result.mintActions).toEqual([{ assetUnit: scriptUnit('546f6b656e4d'), quantity: 1000n }]);
    expect(result.mintingPolicyScript).toBe(SCRIPT);
    expect(result.requiredSigners).toEqual([KEY_HASH]);
    expect(result.inlineDatum).toEqual({ int: 7 });
    expect(result.mintRedeemer).toEqual({ constructor: 0, fields: [] });
    expect(result.forceInputs).toEqual([{ txHash: TX_HASH, outputIndex: 0 }]);
    expect(result.referenceInputs).toEqual([{ txHash: TX_HASH, outputIndex: 3 }]);
    expect(result.metadataJson).toEqual({ '721': {} });
    for (const consumed of ['mintActionsJson', 'requiredSignersJson', 'inlineDatumJson', 'mintRedeemerJson', 'forceInputsJson', 'referenceInputsJson', 'lockOnScript']) {
      expect(result).not.toHaveProperty(consumed);
    }
  });

  it('supports negative quantities (burns)', () => {
    const result = prepareWorkerBuildRequest('mint', {
      ...mintBase,
      mintActionsJson: JSON.stringify([{ assetUnit: scriptUnit('546f6b656e4d'), quantity: '-500' }]),
    }, 'preview') as Record<string, unknown>;
    expect((result.mintActions as Array<{ quantity: bigint }>)[0].quantity).toBe(-500n);
  });

  it('rejects a unit that does not carry the policy id (BUG 9 guard)', () => {
    // NOTE: TEST_FIXTURES.assetUnit's prefix IS the fixture script's policy id —
    // use a foreign policy prefix to actually trigger the mismatch.
    expectRejects(() => prepareWorkerBuildRequest('mint', {
      ...mintBase,
      mintActionsJson: JSON.stringify([{ assetUnit: 'b'.repeat(56) + '546f6b656e4d', quantity: '1' }]),
    }, 'preview'), /does not start with the minting policy id/);
  });

  it('rejects bare asset names without scriptParamsJson', () => {
    expectRejects(() => prepareWorkerBuildRequest('mint', {
      ...mintBase,
      mintActionsJson: JSON.stringify([{ assetUnit: '546f6b656e4d', quantity: '1' }]),
    }, 'preview'), /Invalid assetUnit/);
  });

  it('expands bare asset names with the applied-script policy and routes lockOnScript', () => {
    const applied = applyScriptParameters(PARAM_SCRIPT, [{ int: 1 }]);
    const appliedHash = hashOf(applied);
    const result = prepareWorkerBuildRequest('mint', {
      ...base,
      mintingPolicyScript: PARAM_SCRIPT,
      scriptParamsJson: JSON.stringify([{ int: 1 }]),
      lockOnScript: true,
      mintActionsJson: JSON.stringify([{ assetUnit: '546f6b656e4d', quantity: '1' }]),
    }, 'preview') as Record<string, unknown>;
    expect((result.mintActions as Array<{ assetUnit: string }>)[0].assetUnit).toBe(appliedHash + '546f6b656e4d');
    expect(result.mintingPolicyScript).toBe(applied);
    expect(result.recipientAddress).toBe(scriptHashToEnterpriseAddress(appliedHash, 'preview'));
  });

  it('rejects lockOnScript without scriptParamsJson', () => {
    expectRejects(() => prepareWorkerBuildRequest('mint', { ...mintBase, lockOnScript: true }, 'preview'),
      /lockOnScript requires scriptParamsJson/);
  });

  it('rejects malformed quantities and non-object metadata', () => {
    expectRejects(() => prepareWorkerBuildRequest('mint', {
      ...mintBase, mintActionsJson: JSON.stringify([{ assetUnit: scriptUnit('aa'), quantity: '1.5' }]),
    }, 'preview'), /Invalid quantity/);
    expectRejects(() => prepareWorkerBuildRequest('mint', {
      ...mintBase, metadataJson: JSON.stringify([1, 2]),
    }, 'preview'), /must be an object/);
  });

  describe('multi-policy mint (per-action policy fields)', () => {
    const secondScript = applyScriptParameters(PARAM_SCRIPT, [{ int: 5 }]);
    const secondHash = hashOf(secondScript);

    it('accepts per-action mintingPolicyScript + redeemerJson', () => {
      const result = prepareWorkerBuildRequest('mint', {
        ...mintBase,
        mintActionsJson: JSON.stringify([
          { assetUnit: scriptUnit('01'), quantity: '1' },
          {
            assetUnit: secondHash + '02', quantity: '1',
            mintingPolicyScript: secondScript,
            redeemerJson: JSON.stringify({ constructor: 0, fields: [] }),
          },
        ]),
      }, 'preview') as Record<string, unknown>;
      const actions = result.mintActions as Array<Record<string, unknown>>;
      expect(actions[0]).not.toHaveProperty('mintingPolicyScript');
      expect(actions[1].mintingPolicyScript).toBe(secondScript);
      expect(actions[1].redeemerJson).toEqual({ constructor: 0, fields: [] });
    });

    it('expands a bare asset name with the PER-ACTION policy id', () => {
      const result = prepareWorkerBuildRequest('mint', {
        ...mintBase,
        mintActionsJson: JSON.stringify([
          { assetUnit: scriptUnit('01'), quantity: '1' },
          { assetUnit: '02', quantity: '1', mintingPolicyScript: secondScript },
        ]),
      }, 'preview') as Record<string, unknown>;
      const actions = result.mintActions as Array<{ assetUnit: string }>;
      expect(actions[1].assetUnit).toBe(secondHash + '02');
    });

    it('rejects a per-action unit that does not carry its own policy id', () => {
      expectRejects(() => prepareWorkerBuildRequest('mint', {
        ...mintBase,
        mintActionsJson: JSON.stringify([
          { assetUnit: 'b'.repeat(56) + '02', quantity: '1', mintingPolicyScript: secondScript },
        ]),
      }, 'preview'), /does not start with its own policy id/);
    });

    it('rejects redeemerJson without a per-action script', () => {
      expectRejects(() => prepareWorkerBuildRequest('mint', {
        ...mintBase,
        mintActionsJson: JSON.stringify([
          { assetUnit: scriptUnit('01'), quantity: '1', redeemerJson: '{}' },
        ]),
      }, 'preview'), /requires mintActions\[0\].mintingPolicyScript/);
    });

    it('parses extraOutputsJson on mint (FR-2)', () => {
      const result = prepareWorkerBuildRequest('mint', {
        ...mintBase,
        extraOutputsJson: JSON.stringify([{
          address: ADDR, lovelaceAmount: '2000000',
          assets: [{ unit: scriptUnit('01'), quantity: '1' }],
          inlineDatumJson: JSON.stringify({ int: 1 }),
        }]),
      }, 'preview') as Record<string, unknown>;
      expect(result.extraOutputs).toEqual([{
        address: ADDR, lovelaceAmount: '2000000',
        assets: [{ unit: scriptUnit('01'), quantity: '1' }],
        inlineDatum: { int: 1 },
      }]);
      expect(result).not.toHaveProperty('extraOutputsJson');
    });
  });
});

describe('prepareWorkerBuildRequest: plutusSpend', () => {
  const spendBase = {
    ...base,
    validatorScript: SCRIPT,
    scriptTxHash: TX_HASH,
    scriptOutputIndex: 0,
    redeemerJson: JSON.stringify({ constructor: 0, fields: [] }),
  };

  it('assembles plutusScriptExecution and strips the raw fields', () => {
    const result = prepareWorkerBuildRequest('plutusSpend', {
      ...spendBase,
      datumJson: JSON.stringify({ int: 9 }),
      requiredSignersJson: JSON.stringify([KEY_HASH]),
      extraOutputsJson: JSON.stringify([{ address: ADDR, lovelaceAmount: '1500000' }]),
    }, 'preview') as Record<string, unknown>;

    expect(result.plutusScriptExecution).toEqual({
      validatorScript: SCRIPT,
      scriptUtxo: { txHash: TX_HASH, outputIndex: 0 },
      redeemer: { constructor: 0, fields: [] },
      datum: { int: 9 },
    });
    expect(result.requiredSigners).toEqual([KEY_HASH]);
    expect(result.extraOutputs).toEqual([{
      address: ADDR, lovelaceAmount: '1500000', assets: undefined, inlineDatum: undefined, referenceScript: undefined,
    }]);
    for (const consumed of ['redeemerJson', 'datumJson', 'requiredSignersJson', 'extraOutputsJson', 'lockOnScript']) {
      expect(result).not.toHaveProperty(consumed);
    }
  });

  it('rejects a missing scriptOutputIndex', () => {
    const withoutIndex: Record<string, unknown> = { ...spendBase };
    delete withoutIndex.scriptOutputIndex;
    expectRejects(() => prepareWorkerBuildRequest('plutusSpend', withoutIndex, 'preview'), /scriptOutputIndex/);
  });

  it('rejects mint fields without mintActionsJson and vice versa', () => {
    expectRejects(() => prepareWorkerBuildRequest('plutusSpend', {
      ...spendBase, mintingPolicyScript: SCRIPT,
    }, 'preview'), /require mintActionsJson/);
    expectRejects(() => prepareWorkerBuildRequest('plutusSpend', {
      ...spendBase, mintActionsJson: JSON.stringify([{ assetUnit: scriptUnit('aa'), quantity: '1' }]),
    }, 'preview'), /requires mintingPolicyScript/);
  });

  it('combined spend+mint with policy === validator reuses the applied script and expands bare names', () => {
    const applied = applyScriptParameters(PARAM_SCRIPT, [{ int: 5 }]);
    const appliedHash = hashOf(applied);
    const result = prepareWorkerBuildRequest('plutusSpend', {
      ...spendBase,
      validatorScript: PARAM_SCRIPT,
      mintingPolicyScript: PARAM_SCRIPT,
      scriptParamsJson: JSON.stringify([{ int: 5 }]),
      mintActionsJson: JSON.stringify([{ assetUnit: '546f6b656e4d', quantity: '2' }]),
      mintRedeemerJson: JSON.stringify({ int: 0 }),
    }, 'preview') as Record<string, unknown>;

    expect((result.plutusScriptExecution as { validatorScript: string }).validatorScript).toBe(applied);
    expect(result.mintingPolicyScript).toBe(applied);
    expect(result.mintActions).toEqual([{ assetUnit: appliedHash + '546f6b656e4d', quantity: 2n }]);
    expect(result.mintRedeemer).toEqual({ int: 0 });
  });

  it('lockOnScript with script params routes the continuing output to the applied-script address', () => {
    const applied = applyScriptParameters(PARAM_SCRIPT, [{ int: 3 }]);
    const result = prepareWorkerBuildRequest('plutusSpend', {
      ...spendBase,
      validatorScript: PARAM_SCRIPT,
      scriptParamsJson: JSON.stringify([{ int: 3 }]),
      lockOnScript: true,
    }, 'preview') as Record<string, unknown>;
    expect(result.recipientAddress).toBe(scriptHashToEnterpriseAddress(hashOf(applied), 'preview'));
  });

  it('rejects lockOnScript without scriptParamsJson', () => {
    expectRejects(() => prepareWorkerBuildRequest('plutusSpend', { ...spendBase, lockOnScript: true }, 'preview'),
      /lockOnScript requires scriptParamsJson/);
  });
});

describe('prepareWorkerBuildRequest: unsupported kinds', () => {
  it('rejects unknown kinds', () => {
    expectRejects(() => prepareWorkerBuildRequest('nope' as never, base, 'preview'), /Unsupported job kind/);
  });
});
