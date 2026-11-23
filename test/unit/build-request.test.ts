/**
 * The shared request preparation of the Build* actions and the wallet worker: one request is
 * checked the same way on both paths, and every refusal names its field.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

vi.mock('@sap/cds', () => {
  const cdsMock = { log: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }), utils: { uuid: vi.fn(() => 'u') } };
  return { default: cdsMock, ...cdsMock };
});

import { Script } from '@harmoniclabs/cardano-ledger-ts';
import {
  parseMintActions, prepareMintRequest, preparePayoutRequest, preparePlutusSpendRequest, prepareSimpleAdaRequest, scriptHashOf,
} from '../../srv/utils/build-request';
import { prepareWorkerBuildRequest } from '../../srv/blockchain/wallet-worker/build-request';
import { TEST_FIXTURES } from '../integration/test-fixtures';
import { setActiveNetwork } from '../../srv/utils/network-context';

beforeAll(() => setActiveNetwork('preview'));
afterAll(() => setActiveNetwork(null));

const ADDR = TEST_FIXTURES.validBech32Address;
const SCRIPT = TEST_FIXTURES.validPlutusScript;
const POLICY = Script.fromCbor(Buffer.from(SCRIPT, 'hex')).hash.toString();
const base = { senderAddress: ADDR, recipientAddress: ADDR, lovelaceAmount: '2000000' };
const mint = (actions: unknown[]) => ({ ...base, mintingPolicyScript: SCRIPT, mintActionsJson: JSON.stringify(actions) });

describe('field checks shared with the Build* actions', () => {
  it('refuses an address that is no bech32 address of the network, naming the field', () => {
    expect(prepareSimpleAdaRequest({ ...base, recipientAddress: 'addr_test1_nope' }, () => 'preview'))
      .toEqual({ error: 'Invalid recipient address format', field: 'recipientAddress' });
    expect(prepareSimpleAdaRequest({ ...base, changeAddress: 'nope' }, () => 'preview'))
      .toEqual({ error: 'Invalid changeAddress format', field: 'changeAddress' });
  });

  it('marks a missing field as missing', () => {
    expect(prepareSimpleAdaRequest({ senderAddress: ADDR, recipientAddress: ADDR }, () => 'preview'))
      .toEqual({ error: 'lovelaceAmount is required', field: 'lovelaceAmount', missing: true });
    expect(preparePlutusSpendRequest({ ...base, validatorScript: SCRIPT, scriptTxHash: TEST_FIXTURES.validTxHash, redeemerJson: '{"int":0}' }, () => 'preview'))
      .toMatchObject({ field: 'scriptOutputIndex', missing: true });
  });

  it('refuses a lovelace amount that is no positive integer', () => {
    expect(prepareSimpleAdaRequest({ ...base, lovelaceAmount: '-5' }, () => 'preview')).toMatchObject({ field: 'lovelaceAmount' });
  });

  it('checks outputDatumCbor and keeps it exclusive with outputDatumJson', () => {
    expect(prepareSimpleAdaRequest({ ...base, outputDatumCbor: 'zz' }, () => 'preview')).toMatchObject({ field: 'outputDatumCbor' });
    expect(prepareSimpleAdaRequest({ ...base, outputDatumCbor: 'd87980', outputDatumJson: '{"int":1}' }, () => 'preview'))
      .toMatchObject({ error: expect.stringContaining('exclude each other'), field: 'outputDatumCbor' });
    expect(prepareSimpleAdaRequest({ ...base, outputDatumCbor: 'D87980' }, () => 'preview'))
      .toMatchObject({ request: expect.objectContaining({ outputDatumCbor: 'd87980' }) });
  });

  it('applies the same checks to a wallet job', () => {
    expect(() => prepareWorkerBuildRequest('simpleAda', { ...base, recipientAddress: 'addr_test1_nope' }, 'preview'))
      .toThrow(expect.objectContaining({ statusCode: 400, code: 'ODATANO_INVALID_INPUT', target: 'recipientAddress' }));
    expect(() => prepareWorkerBuildRequest('multiAsset', { ...base, assetsJson: JSON.stringify([{ unit: TEST_FIXTURES.assetUnit, quantity: '1' }]), outputDatumCbor: 'zz' }, 'preview'))
      .toThrow(/outputDatumCbor/);
  });

  it('checks the sender and the validity of a payout', () => {
    const outputsJson = JSON.stringify([{ address: ADDR, lovelaceAmount: '2000000' }]);
    expect(preparePayoutRequest({ senderAddress: 'nope', outputsJson })).toMatchObject({ field: 'senderAddress' });
    expect(preparePayoutRequest({ senderAddress: ADDR, outputsJson, validityEndMs: 'soon' })).toMatchObject({ field: 'validityEndMs' });
    expect(preparePayoutRequest({ senderAddress: ADDR, outputsJson })).toMatchObject({ request: expect.objectContaining({ senderAddress: ADDR }) });
  });
});

describe('prepareSimpleAdaRequest: a server that is not ready', () => {
  it('lets the 503 of a missing app context through instead of calling the script invalid', async () => {
    const { ProviderUnavailableError } = await import('../../srv/utils/errors');
    const notReady = () => { throw new ProviderUnavailableError('Application context not initialized', 'server'); };
    expect(() => prepareSimpleAdaRequest({
      senderAddress: ADDR, recipientAddress: ADDR, lovelaceAmount: '2000000', lockOnScript: true, validatorScript: TEST_FIXTURES.validPlutusScript,
    }, notReady)).toThrow(expect.objectContaining({ statusCode: 503 }));
  });
});

describe('parseMintActions: one parser for mint and spend', () => {
  const parse = (actions: unknown[], bare = false) => () => parseMintActions({ mintActionsJson: JSON.stringify(actions) }, bare);

  it('refuses a zero quantity, which the ledger never mints', () => {
    expect(parse([{ assetUnit: POLICY + 'aa', quantity: '0' }])).toThrow('Invalid quantity: "0": a mint action must mint or burn, zero does neither');
  });

  it('answers with the texts of the action it parses for', () => {
    expect(parse([{ assetUnit: POLICY + 'aa', quantity: 'x' }])).toThrow('Invalid quantity format: "x": must be an integer string');
    expect(parse([{ assetUnit: POLICY + 'aa', quantity: 1 }])).toThrow('Each mint action must have a string quantity');
    const spend = (actions: unknown[]) => () => parseMintActions({ mintActionsJson: JSON.stringify(actions) }, false, 'spend');
    expect(spend([{ assetUnit: POLICY + 'aa', quantity: 'x' }])).toThrow('Invalid quantity: "x": must be an integer string');
    expect(spend([{ quantity: '1' }])).toThrow('Each mint action must have assetUnit string');
    expect(spend([{ assetUnit: 'zz', quantity: '1' }])).toThrow(/or scriptParamsJson is set and the policy equals the validator/);
  });

  it('checks the fields in the order each Build* action always did', () => {
    // BuildMintTransaction: the unit before the quantity; the combined mint of a spend: the quantity first
    expect(parse([{ assetUnit: 'zz', quantity: 'x' }])).toThrow(/Invalid assetUnit: "zz"/);
    const spend = (actions: unknown[]) => () => parseMintActions({ mintActionsJson: JSON.stringify(actions) }, false, 'spend');
    expect(spend([{ assetUnit: 'zz', quantity: 'x' }])).toThrow('Invalid quantity: "x": must be an integer string');
  });

  it('refuses a redeemer that is no integer instead of failing inside the builder', () => {
    expect(parse([{ assetUnit: POLICY + 'aa', quantity: '1', redeemer: 'x' }])).toThrow(/redeemer must be an integer/);
    expect(parseMintActions({ mintActionsJson: JSON.stringify([{ assetUnit: POLICY + 'aa', quantity: '1', redeemer: 2 }]) }, false)[0].redeemer).toBe(2);
  });

  it('returns units in lower case', () => {
    const [action] = parseMintActions({ mintActionsJson: JSON.stringify([{ assetUnit: (POLICY + 'AB').toUpperCase(), quantity: '-3' }]) }, false);
    expect(action).toEqual({ assetUnit: POLICY + 'ab', quantity: -3n });
  });

  it('completes a bare name only where the policy is known', () => {
    expect(parse([{ assetUnit: 'AB', quantity: '1' }])).toThrow(/Invalid assetUnit/);
    expect(parseMintActions({ mintActionsJson: JSON.stringify([{ assetUnit: 'AB', quantity: '1' }]) }, true)[0].assetUnit).toBe('ab');
  });
});

describe('prepareMintRequest', () => {
  it('refuses a unit outside the minting policy, naming the field', () => {
    expect(prepareMintRequest(mint([{ assetUnit: 'b'.repeat(56) + 'aa', quantity: '1' }]), () => 'preview'))
      .toMatchObject({ error: expect.stringContaining('does not start with the minting policy id'), field: 'mintActionsJson' });
  });

  it('passes a unit of the policy through and reports no script address without lockOnScript', () => {
    const result = prepareMintRequest(mint([{ assetUnit: POLICY + 'aa', quantity: '1' }]), () => 'preview');
    expect(result).toMatchObject({ request: { mintActions: [{ assetUnit: POLICY + 'aa', quantity: 1n }] } });
    expect(result).not.toHaveProperty('scriptAddress', expect.any(String));
  });

  it('needs scriptParamsJson for lockOnScript', () => {
    expect(prepareMintRequest({ ...mint([{ assetUnit: POLICY + 'aa', quantity: '1' }]), lockOnScript: true }, () => 'preview'))
      .toMatchObject({ field: 'lockOnScript' });
  });
});

describe('scriptHashOf', () => {
  it('is the policy id of the script', () => {
    expect(scriptHashOf(SCRIPT)).toBe(POLICY);
  });
});
