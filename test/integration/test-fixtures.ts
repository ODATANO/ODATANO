/**
 * Test Fixtures
 * Constants and mock data for integration tests
 * This file has NO nock dependency - safe to import in all tests
 */

export type BackendType = 'blockfrost' | 'koios' | 'ogmios';
export type TxBuilderType = 'buildooor';

export interface TestConfiguration {
  backendName: BackendType;
  txBuilderName: TxBuilderType;
  apiKey?: string;
}

export const TEST_FIXTURES = {
  network: 'preview',
  addressWithFunds: 'addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp',
  addressWithAssets: 'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae',
  emptyAddress: 'addr_test1vr8nl4u0u6fmtfnawx2rxfz95dy7m46t6dhzdftp2uha87syeufdg',
  validBech32Address: 'addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp',
  validStakeAddress: 'stake_test1urqntq4wexjylnrdnp97qq79qkxxvrsa9lcnwr7ckjd6w0cr04y4p',
  validPoolId: 'pool1knap9hldvhww0fjqew26sxkfjpj3c8tp8uuj7j3729lzqn9x70r',
  validTxHash: '2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83',
  txWithMetadata: '95edd3f70ac85d6445fd5d719a66955edf3eda78c0c365004f8c28b3e9e48bb1',
  validBlockHash: '890af88d47433ecc9eccf16369aef16df40fc7f41b9d38a8d758c8ca1968a886',
  transactionMetadataLabel: '1990',
  validUnit: 'eadc69a5d2d1357acc9b9d49ec5390fcdf6e080c7a40139917223dcba971c6765a1acab1d7849f4f032195cf69c4ab486ac6dedec9533103',
  validDrepId: 'drep1y2ldnl4ugmhx873hpw7x23rvqe7krtwvgmvqjn3hy62xv6c8ashc0',
  unsignedTxCbor: '84a400818258202db5788ec32bc0fdd0bc308b4787dba2d2dd4930bec4025360647fed6d35bccb010182a200583900d090525914fb9bcd35141eaff7b054b9ce105f154ebb73347ff9c7415318a7bcc399479a382e00ef73306801c4d8064df6cc20d2a5ca7189011a00989680a200581d60374610273097b313fade06a30e90c5fb2640074ca0744ce850b8f0a101821b000000023f09f49ca1581cdef68337867cb4f1f95b6b811fedbfcdd7780d10a95cc072077088eaa146546f6b656e4d1909c4021a000294c10f00a0f5f6',
  signedTxCbor1: '84a400818258202db5788ec32bc0fdd0bc308b4787dba2d2dd4930bec4025360647fed6d35bccb010182a200583900d090525914fb9bcd35141eaff7b054b9ce105f154ebb73347ff9c7415318a7bcc399479a382e00ef73306801c4d8064df6cc20d2a5ca7189011a00989680a200581d60374610273097b313fade06a30e90c5fb2640074ca0744ce850b8f0a101821b000000023f09f49ca1581cdef68337867cb4f1f95b6b811fedbfcdd7780d10a95cc072077088eaa146546f6b656e4d1909c4021a000294c10f00a100d9010281825820e865ca640ce4c6e92cd45b5e7f4ab37da379f1098eae4dc5e46709a42dec8f2f584068f60d60ecf7dcc99b5e19577015cd4d06f9c0c69d2d0688625c72cdbb2dae67e8a2bf0af85d12f6adda74ee693802ad2ccf7ed2a1ce5ec7c0a872bcf259c206f5f6',
  signedTxCbor2: '84a400818258205305281b2828b54252969df717d3050ddd81f61e2f62b3125eb326a258c76f78000182a200583900d090525914fb9bcd35141eaff7b054b9ce105f154ebb73347ff9c7415318a7bcc399479a382e00ef73306801c4d8064df6cc20d2a5ca7189011a00989680a200581d60374610273097b313fade06a30e90c5fb2640074ca0744ce850b8f0a1011b000000025370c023021a00028d5d0f00a100d9010281825820e865ca640ce4c6e92cd45b5e7f4ab37da379f1098eae4dc5e46709a42dec8f2f584066b33b3bcaf0a5f908d83a13273d570d2d9fbbe240d917985d620fc5d24d3a9e7919426a00a960d10a7e430889eac4f16a55e6520f8804891e9fb9af443c010ef5f6',
  witnessSetCbor: 'a100d9010281825820e865ca640ce4c6e92cd45b5e7f4ab37da379f1098eae4dc5e46709a42dec8f2f584068f60d60ecf7dcc99b5e19577015cd4d06f9c0c69d2d0688625c72cdbb2dae67e8a2bf0af85d12f6adda74ee693802ad2ccf7ed2a1ce5ec7c0a872bcf259c206',
  txHash: '4a066f70b5e478f7564311fb2762025fa449246e5bdb035d233a8aadb004abc7',
  txBodyHash: '4a066f70b5e478f7564311fb2762025fa449246e5bdb035d233a8aadb004abc7', // Same as txHash
  lovelaceAmount: '5000000', // 5 ADA
  highLovelaceAmount: '15000000000', // 15,000 ADA
  invalidLovelaceAmountNegative: '-1000',
  expectedTxHashCbor2: '290c6b9abf9118cdc1fdcbdc6635f94ef0d414c1212c2c95b069a209d32b97cf',
  invalidAddress: 'invalid_address',
  invalidLovelaceAmount: 'not_a_number',
  policyId: 'def68337867cb4f1f95b6b811fedbfcdd7780d10a95cc072077088ea',
  assetName: '546f6b656e4d', // "TokenM" in hex
  assetName2: '416e6f74686572', // "Another" in hex
  assetUnit: 'def68337867cb4f1f95b6b811fedbfcdd7780d10a95cc072077088ea546f6b656e4d',
  assetUnit2: 'def68337867cb4f1f95b6b811fedbfcdd7780d10a95cc072077088ea416e6f74686572',
  tokenQuantity_1000: '1000',
  mintQuantity_1000: '1000',
  burnQuantity_500: '-500',
  validPlutusScript: "585401010029800aba2aba1aab9eaab9dab9a4888896600264653001300600198031803800cc0180092225980099b8748000c01cdd500144c9289bae30093008375400516401830060013003375400d149a26cac8009",
  // Genuinely PARAMETERIZED always-succeeds PlutusV3 script: `\param -> \ctx -> 0`.
  // Applying one parameter leaves a valid single-arg validator that evaluates without
  // error. (validPlutusScript above is non-parameterized — applying a param to it
  // produces a script that fails local evaluation, which the builder now rejects when
  // no Ogmios evaluator is available.)
  parameterizedScript: "4701010022480001",
  validMetadataJson: JSON.stringify({"721": {"MyToken": {"name": "TokenM", "description": "My first minted token"}}}),
  invalidMintActionsJson: "invalid_json",
  invalidMintingPolicyScript: 'invalid_script',
  validAssetsJson: JSON.stringify([{ unit: 'def68337867cb4f1f95b6b811fedbfcdd7780d10a95cc072077088ea546f6b656e4d', quantity: '100' }]),
  validMintActionsJson: JSON.stringify([{ assetUnit: 'def68337867cb4f1f95b6b811fedbfcdd7780d10a95cc072077088ea546f6b656e4d', quantity: '1000' }]),
  validSpendingScript: '587601010029800aba2aba1aab9eaab9dab9a48888966002646465300130053754003300700398038012444b30013370e9000001c4c9289bae300a3009375400915980099b874800800e2646644944c02c004c02cc030004c024dd5002459007200e18031803800980300098019baa0068a4d13656400401',
  // blake2b_224(0x03 || validSpendingScript bytes) — the policyId when validSpendingScript mints
  spendingScriptPolicyId: '61e32e15ca8e4b37687f007d13467d1ee84327d02aac9168d7e42a2c',
};

export const MOCK_EVALUATED_BUDGET = {
  memory: 200000,  // 200K - much lower than default 14M
  cpu: 100000000   // 100M - much lower than default 10B
};

// Mock UTxOs with ADA only (Koios response format)
export const mockUtxosAdaOnly = [
  {
    tx_hash: '1939e853adca5ce67b101d46722d9a84861843f01d030e787c82bd060d294e33',
    tx_index: 0,
    value: '15000000', // 15 ADA
    asset_list: [],
    block_hash: 'a1b2c3d4e5f6',
    datum_hash: null
  },
  {
    tx_hash: 'f2e3025deee1dbf12e1e762421bc019b0a8de86dbcf7cc27964334d6190a6696',
    tx_index: 1,
    value: '10000000', // 10 ADA
    asset_list: [],
    block_hash: 'b2c3d4e5f6g7',
    datum_hash: null
  }
];

// Mock UTxOs with native assets (Koios response format)
export const mockUtxosWithAssets = [
  {
    tx_hash: '1939e853adca5ce67b101d46722d9a84861843f01d030e787c82bd060d294e33',
    tx_index: 0,
    value: '10000000', // 10 ADA
    asset_list: [
      { policy_id: TEST_FIXTURES.policyId, asset_name: TEST_FIXTURES.assetName, quantity: '1000' }
    ],
    block_hash: 'a1b2c3d4',
    datum_hash: null
  },
  {
    tx_hash: 'f2e3025deee1dbf12e1e762421bc019b0a8de86dbcf7cc27964334d6190a6696',
    tx_index: 0,
    value: '5000000', // 5 ADA
    asset_list: [
      { policy_id: TEST_FIXTURES.policyId, asset_name: TEST_FIXTURES.assetName, quantity: '500' }
    ],
    block_hash: 'e5f6g7h8',
    datum_hash: null
  }
];

// UTxOs for burn tests (with asset to burn and ADA-only for collateral)
export const utxosForBurn = [
  {
    tx_hash: '1939e853adca5ce67b101d46722d9a84861843f01d030e787c82bd060d294e33',
    tx_index: 0,
    value: '10000000', // 10 ADA
    asset_list: [
      { policy_id: TEST_FIXTURES.policyId, asset_name: TEST_FIXTURES.assetName2, quantity: '1000' } // TokenB - has tokens to burn
    ],
    block_hash: 'burn123',
    datum_hash: null
  },
  {
    tx_hash: 'f2e3025deee1dbf12e1e762421bc019b0a8de86dbcf7cc27964334d6190a6696',
    tx_index: 0,
    value: '10000000', // 10 ADA - ADA-only UTxO for collateral
    asset_list: [],
    block_hash: 'collateral123',
    datum_hash: null
  }
];

// UTxOs for multi-asset tests (with multiple assets)
export const multiAssetUtxos = [{
  tx_hash: '1939e853adca5ce67b101d46722d9a84861843f01d030e787c82bd060d294e33',
  tx_index: 0,
  value: '15000000', // 15 ADA
  asset_list: [
    { policy_id: TEST_FIXTURES.policyId, asset_name: TEST_FIXTURES.assetName, quantity: '1000' },
    { policy_id: TEST_FIXTURES.policyId, asset_name: '416e6f74686572', quantity: '2000' } // Another asset
  ],
  block_hash: 'multi123',
  datum_hash: null
}];

export const limitedUtxos = [{
  tx_hash: '1939e853adca5ce67b101d46722d9a84861843f01d030e787c82bd060d294e33',
  tx_index: 0,
  value: '10000000', // 10 ADA
  asset_list: [
    { policy_id: TEST_FIXTURES.policyId, asset_name: TEST_FIXTURES.assetName, quantity: '100' } // Only 100 tokens
  ],
  block_hash: 'limited123',
  datum_hash: null
}];

// UTxOs where ALL have assets (no ADA-only for collateral)
export const utxosWithoutAdaOnly = [
  {
    tx_hash: '1939e853adca5ce67b101d46722d9a84861843f01d030e787c82bd060d294e33',
    tx_index: 0,
    value: '10000000', // 10 ADA
    asset_list: [
      { policy_id: TEST_FIXTURES.policyId, asset_name: TEST_FIXTURES.assetName, quantity: '500' }
    ],
    block_hash: 'nocollateral1',
    datum_hash: null
  },
  {
    tx_hash: 'f2e3025deee1dbf12e1e762421bc019b0a8de86dbcf7cc27964334d6190a6696',
    tx_index: 0,
    value: '5000000', // 5 ADA - also with assets!
    asset_list: [
      { policy_id: TEST_FIXTURES.policyId, asset_name: TEST_FIXTURES.assetName, quantity: '200' }
    ],
    block_hash: 'nocollateral2',
    datum_hash: null
  }
];

// UTxOs with very small ADA-only (insufficient for collateral)
export const utxosWithSmallAdaOnly = [
  {
    tx_hash: '1939e853adca5ce67b101d46722d9a84861843f01d030e787c82bd060d294e33',
    tx_index: 0,
    value: '10000000', // 10 ADA with assets
    asset_list: [
      { policy_id: TEST_FIXTURES.policyId, asset_name: TEST_FIXTURES.assetName, quantity: '500' }
    ],
    block_hash: 'smallcoll1',
    datum_hash: null
  },
  {
    tx_hash: 'f2e3025deee1dbf12e1e762421bc019b0a8de86dbcf7cc27964334d6190a6696',
    tx_index: 0,
    value: '1000000', // Only 1 ADA - insufficient for collateral
    asset_list: [],
    block_hash: 'smallcoll2',
    datum_hash: null
  }
];

// PlutusV3 cost model (297 parameters) - minimal valid values for testing
export const PLUTUS_V3_COST_MODEL = Array(297).fill(1000);

// Mock protocol parameters (Koios /cli_protocol_params format)
export const mockProtocolParams = {
  txFeePerByte: 44,
  txFeeFixed: 155381,
  maxTxSize: 16384,
  maxBlockHeaderSize: 1100,
  maxBlockBodySize: 65536,
  stakeAddressDeposit: 2000000,
  stakePoolDeposit: 500000000,
  poolRetireMaxEpoch: 18,
  stakePoolTargetNum: 500,
  poolPledgeInfluence: 0.3,
  monetaryExpansion: 0.003,
  treasuryCut: 0.2,
  minPoolCost: 340000000,
  protocolVersion: { major: 8, minor: 0 },
  executionUnitPrices: { priceMemory: 0.0577, priceSteps: 0.0000721 },
  maxTxExecutionUnits: { memory: 14000000, steps: 10000000000 },
  maxBlockExecutionUnits: { memory: 62000000, steps: 20000000000 },
  maxValueSize: 5000,
  collateralPercentage: 150,
  maxCollateralInputs: 3,
  utxoCostPerByte: 4310,
  costModels: {
    'PlutusV3': PLUTUS_V3_COST_MODEL
  }
};

// Mock protocol parameters in LedgerProtocolParameter format (mapped from mockProtocolParams)
// This is the format used by CardanoTxBuilder - same mapping as koios-backend.ts getProtocolParameters()
export const mockLedgerProtocolParams = {
  network: 'preview' as const,
  epoch: 0,
  // --- Fees / Sizes ---
  minFeeA: mockProtocolParams.txFeePerByte,
  minFeeB: mockProtocolParams.txFeeFixed,
  maxBlockSize: mockProtocolParams.maxBlockBodySize,
  maxTxSize: mockProtocolParams.maxTxSize,
  maxBlockHeaderSize: mockProtocolParams.maxBlockHeaderSize,
  // --- Deposits / Pools ---
  keyDeposit: mockProtocolParams.stakeAddressDeposit.toString(),
  poolDeposit: mockProtocolParams.stakePoolDeposit.toString(),
  eMax: mockProtocolParams.poolRetireMaxEpoch,
  nOpt: mockProtocolParams.stakePoolTargetNum,
  a0: mockProtocolParams.poolPledgeInfluence,
  rho: mockProtocolParams.monetaryExpansion,
  tau: mockProtocolParams.treasuryCut,
  minPoolCost: mockProtocolParams.minPoolCost.toString(),
  // --- Legacy / Misc ---
  decentralisationParam: 0,
  extraEntropy: null,
  protocolMajorVer: mockProtocolParams.protocolVersion.major,
  protocolMinorVer: mockProtocolParams.protocolVersion.minor,
  minUtxo: '0',
  nonce: '',
  // --- Plutus / Execution units ---
  costModels: JSON.stringify(mockProtocolParams.costModels),
  priceMem: mockProtocolParams.executionUnitPrices.priceMemory,
  priceStep: mockProtocolParams.executionUnitPrices.priceSteps,
  maxTxExMem: mockProtocolParams.maxTxExecutionUnits.memory.toString(),
  maxTxExSteps: mockProtocolParams.maxTxExecutionUnits.steps.toString(),
  maxBlockExMem: mockProtocolParams.maxBlockExecutionUnits.memory.toString(),
  maxBlockExSteps: mockProtocolParams.maxBlockExecutionUnits.steps.toString(),
  // --- Babbage+ UTxO cost / Collateral ---
  maxValSize: mockProtocolParams.maxValueSize.toString(),
  collateralPercent: mockProtocolParams.collateralPercentage,
  maxCollateralInputs: mockProtocolParams.maxCollateralInputs,
  coinsPerUtxoSize: mockProtocolParams.utxoCostPerByte.toString(),
  // --- Housekeeping ---
  fetchedAt: new Date().toISOString(),
  source: 'mock'
};

// Request bodies for various transaction builds
export const simpleRequestBody = {
  senderAddress: TEST_FIXTURES.addressWithFunds,
  recipientAddress: TEST_FIXTURES.emptyAddress,
  lovelaceAmount: TEST_FIXTURES.lovelaceAmount,
  changeAddress: TEST_FIXTURES.addressWithFunds,
};

export const simpleRequestBody2 = {
  senderAddress: TEST_FIXTURES.addressWithFunds,
  recipientAddress: TEST_FIXTURES.emptyAddress,
  lovelaceAmount: TEST_FIXTURES.highLovelaceAmount,
};

export const MINT_ACTIONS = [
  {
    assetUnit: TEST_FIXTURES.assetUnit,
    quantity: TEST_FIXTURES.mintQuantity_1000
  }
];
export const MINT_ACTIONS_2 = [
  {
    assetUnit: TEST_FIXTURES.assetUnit2,
    quantity: TEST_FIXTURES.burnQuantity_500
  }
];

export const burningRequestBody = {
  senderAddress: TEST_FIXTURES.addressWithFunds,
  recipientAddress: TEST_FIXTURES.emptyAddress,
  lovelaceAmount: TEST_FIXTURES.lovelaceAmount,
  changeAddress: TEST_FIXTURES.addressWithFunds,
  mintActionsJson: JSON.stringify(MINT_ACTIONS_2),
  mintingPolicyScript: TEST_FIXTURES.validPlutusScript,
};

export const mintingRequestBody = {
  senderAddress: TEST_FIXTURES.addressWithFunds,
  recipientAddress: TEST_FIXTURES.emptyAddress,
  lovelaceAmount: TEST_FIXTURES.lovelaceAmount,
  changeAddress: TEST_FIXTURES.addressWithFunds,
  mintActionsJson: JSON.stringify(MINT_ACTIONS),
  mintingPolicyScript: TEST_FIXTURES.validPlutusScript,
};

export const mintingRequestBody2 = {
  senderAddress: TEST_FIXTURES.addressWithFunds,
  recipientAddress: TEST_FIXTURES.emptyAddress,
  lovelaceAmount: TEST_FIXTURES.highLovelaceAmount,
  mintActionsJson: JSON.stringify(MINT_ACTIONS),
  mintingPolicyScript: TEST_FIXTURES.validPlutusScript,
};

export const multiAssetRequestBody = {
  senderAddress: TEST_FIXTURES.addressWithFunds,
  recipientAddress: TEST_FIXTURES.emptyAddress,
  lovelaceAmount: TEST_FIXTURES.lovelaceAmount,
  assetsJson: JSON.stringify([
    { unit: TEST_FIXTURES.assetUnit, quantity: '100' } // Send less than available to get change
  ])
  // changeAddress intentionally omitted
};

export const multiAssetRequestBody2 = {
  senderAddress: TEST_FIXTURES.addressWithFunds,
  recipientAddress: TEST_FIXTURES.emptyAddress,
  lovelaceAmount: TEST_FIXTURES.lovelaceAmount,
  assetsJson: JSON.stringify([
    { unit: TEST_FIXTURES.assetUnit, quantity: '1200' } // Requires both UTxOs
  ])
};

export const multiAssetRequestBody3 = {
  senderAddress: TEST_FIXTURES.addressWithFunds,
  recipientAddress: TEST_FIXTURES.emptyAddress,
  lovelaceAmount: TEST_FIXTURES.lovelaceAmount,
  changeAddress: TEST_FIXTURES.addressWithFunds,
  assetsJson: JSON.stringify([
    { unit: TEST_FIXTURES.assetUnit, quantity: '500' }
  ]),
};

const METADATA = {
  "674": {
    "msg": ["Hello", "from", "ODATANO"]
  }
};

export const metaDataRequestBody = {
  senderAddress: TEST_FIXTURES.addressWithFunds,
  recipientAddress: TEST_FIXTURES.emptyAddress,
  lovelaceAmount: TEST_FIXTURES.lovelaceAmount,
  changeAddress: TEST_FIXTURES.addressWithFunds,
  metadataJson: JSON.stringify(METADATA),
};

export const metaDataRequestBody2 = {
  senderAddress: TEST_FIXTURES.addressWithFunds,
  recipientAddress: TEST_FIXTURES.emptyAddress,
  lovelaceAmount: TEST_FIXTURES.highLovelaceAmount,
  metadataJson: JSON.stringify(METADATA),
};

// ---------------------------------------------------------------------------
// Plutus Spend Transaction Test Data
// ---------------------------------------------------------------------------

export const SCRIPT_UTXO_TX_HASH = 'aabb0011223344556677889900aabbccddeeff00112233445566778899001122';
export const SCRIPT_UTXO_OUTPUT_INDEX = 0;

// Enterprise script address (header 0x70) for the validSpendingScript hash — the
// address the script UTxO actually lives at. Kept distinct from the sender so the
// builder runs its getTransaction-based script-UTxO resolution (instead of finding
// it among sender UTxOs) and the live-unspent pre-check queries it separately.
export const SCRIPT_UTXO_ADDRESS = 'addr_test1wps7xts4e28ykdmg0uq86y6x050wsse86q42eytg6ljz5tqmrcwgm';

// Koios /address_utxos entry the script address returns, so _assertUnspent sees the
// script UTxO as live. Only tx_hash/tx_index are consulted by the unspent check.
export const scriptUtxoKoiosEntry = {
  tx_hash: SCRIPT_UTXO_TX_HASH,
  tx_index: SCRIPT_UTXO_OUTPUT_INDEX,
  value: '10000000',
  asset_list: [],
  block_hash: 'mockscriptblockhash0000000000000000000000000000000000000000000000',
  datum_hash: null,
};

export const plutusSpendRequestBody = {
  senderAddress: TEST_FIXTURES.addressWithFunds,
  recipientAddress: TEST_FIXTURES.emptyAddress,
  lovelaceAmount: '2000000',
  validatorScript: TEST_FIXTURES.validSpendingScript,
  scriptTxHash: SCRIPT_UTXO_TX_HASH,
  scriptOutputIndex: SCRIPT_UTXO_OUTPUT_INDEX,
  redeemerJson: JSON.stringify({ constructor: 0, fields: [] }),
  datumJson: JSON.stringify({ constructor: 0, fields: [] }),
  changeAddress: TEST_FIXTURES.addressWithFunds,
};

// Mock Koios tx_info response for script UTxO lookup
export const mockScriptTxInfo = [{
  tx_hash: SCRIPT_UTXO_TX_HASH,
  block_hash: 'mockscriptblockhash0000000000000000000000000000000000000000000000',
  block_height: 1000,
  block_time: 1704067200,
  slot_no: 50000000,
  tx_index: 0,
  tx_fee: '200000',
  deposit: '0',
  tx_size: 300,
  inputs: [{
    tx_hash: '0000000000000000000000000000000000000000000000000000000000000000',
    tx_index: 0,
    value: '10000000',
    payment_addr: { bech32: TEST_FIXTURES.addressWithFunds },
    asset_list: []
  }],
  outputs: [{
    tx_index: SCRIPT_UTXO_OUTPUT_INDEX,
    value: '10000000',
    payment_addr: { bech32: SCRIPT_UTXO_ADDRESS },
    asset_list: [],
    datum_hash: null,
    inline_datum: null,
    reference_script: null
  }]
}];

// Mock Koios tx_info response for script UTxO with native assets
export const mockScriptTxInfoWithAssets = [{
  ...mockScriptTxInfo[0],
  outputs: [{
    ...mockScriptTxInfo[0].outputs[0],
    asset_list: [{ policy_id: TEST_FIXTURES.policyId, asset_name: TEST_FIXTURES.assetName, quantity: '1' }],
  }]
}];

// ---------------------------------------------------------------------------
// FR-2 Fixtures — extraOutputsJson
// ---------------------------------------------------------------------------

/** Single ADA-only extra output, generously sized to clear min-ADA on any address. */
export const validExtraOutputAdaOnly = {
  address: TEST_FIXTURES.emptyAddress,
  lovelaceAmount: '2000000',
};

/** Extra output carrying a native asset alongside ADA. */
export const validExtraOutputWithAssets = {
  address: TEST_FIXTURES.emptyAddress,
  lovelaceAmount: '2500000',
  assets: [{ unit: TEST_FIXTURES.assetUnit, quantity: '10' }],
};

/** Extra output with an inline PlutusData datum. */
export const validExtraOutputWithDatum = {
  address: TEST_FIXTURES.emptyAddress,
  lovelaceAmount: '2000000',
  inlineDatumJson: JSON.stringify({ constructor: 0, fields: [{ int: 7 }] }),
};

export const plutusSpendWithExtraOutputsRequestBody = {
  ...plutusSpendRequestBody,
  // Both ADA-only so coin selection against the ADA-only mock funding succeeds.
  extraOutputsJson: JSON.stringify([
    validExtraOutputAdaOnly,
    { ...validExtraOutputAdaOnly, lovelaceAmount: '3000000' },
  ]),
};

export const plutusSpendWithExtraOutputInlineDatumRequestBody = {
  ...plutusSpendRequestBody,
  extraOutputsJson: JSON.stringify([validExtraOutputWithDatum]),
};

/** 33 entries — exceeds the MAX_EXTRA_OUTPUTS=32 cap by one. */
export const tooManyExtraOutputs = Array.from({ length: 33 }, () => ({ ...validExtraOutputAdaOnly }));

/** Below the typical min-ADA — designed to trip the per-output guard. */
export const extraOutputBelowMinAda = {
  address: TEST_FIXTURES.emptyAddress,
  lovelaceAmount: '100000',
};

// ---------------------------------------------------------------------------
// Fixtures — lockOnScript / DeriveScriptAddress / ExtractPaymentKeyHash
// ---------------------------------------------------------------------------

/** PlutusData JSON array used as params for script parameter application. */
export const validScriptParamsJson = JSON.stringify([{ int: 42 }]);

/** A different param set — used to assert that different params ⇒ different address. */
export const altScriptParamsJson = JSON.stringify([{ int: 99 }]);

/** BuildSimpleAdaTransaction body extended with lockOnScript. */
export const simpleLockOnScriptRequestBody = {
  ...simpleRequestBody,
  validatorScript: TEST_FIXTURES.validPlutusScript,
  lockOnScript: true,
};

export const simpleLockOnScriptWithParamsRequestBody = {
  ...simpleLockOnScriptRequestBody,
  scriptParamsJson: validScriptParamsJson,
};

// ---------------------------------------------------------------------------
// FR-1 Fixtures — combined spend+mint on BuildPlutusSpendTransaction
// ---------------------------------------------------------------------------

export const plutusSpendWithMintRequestBody = {
  ...plutusSpendRequestBody,
  mintActionsJson: JSON.stringify([{ assetUnit: TEST_FIXTURES.assetUnit, quantity: '1' }]),
  mintingPolicyScript: TEST_FIXTURES.validPlutusScript,
  mintRedeemerJson: JSON.stringify({ constructor: 0, fields: [] }),
};

/**
 * Multi-purpose script: mintingPolicyScript === validatorScript byte-equal,
 * exercises the script-params-applied-validator reuse on the mint side.
 */
export const plutusSpendMultiPurposeScriptRequestBody = {
  ...plutusSpendRequestBody,
  // BUG 9: full assetUnits must carry the policyId of the minting script — here the
  // multi-purpose validator (validSpendingScript), not the standalone mint policy.
  mintActionsJson: JSON.stringify([{ assetUnit: TEST_FIXTURES.spendingScriptPolicyId + TEST_FIXTURES.assetName, quantity: '1' }]),
  mintingPolicyScript: TEST_FIXTURES.validSpendingScript,
};

export const plutusSpendWithBurnRequestBody = {
  ...plutusSpendRequestBody,
  mintActionsJson: JSON.stringify([{ assetUnit: TEST_FIXTURES.assetUnit, quantity: '-1' }]),
  mintingPolicyScript: TEST_FIXTURES.validPlutusScript,
};

// ---------------------------------------------------------------------------
// FR-3 Fixtures — __INPUT_IDX__ placeholder resolution
// ---------------------------------------------------------------------------

/** Redeemer pointing at the script UTxO via its post-sort index. */
export const indexPlaceholderRedeemer = {
  constructor: 0,
  fields: [{ int: `__INPUT_IDX:${SCRIPT_UTXO_TX_HASH}#${SCRIPT_UTXO_OUTPUT_INDEX}__` }],
};

export const plutusSpendWithIndexPlaceholderRequestBody = {
  ...plutusSpendRequestBody,
  redeemerJson: JSON.stringify(indexPlaceholderRedeemer),
};

/** Placeholder hash that does NOT correspond to any input — expected to error. */
export const bogusIndexPlaceholderRedeemer = {
  constructor: 0,
  fields: [{ int: `__INPUT_IDX:${'cc'.repeat(32)}#0__` }],
};

/**
 * Configure environment for a specific backend test
 * This ensures only the specified backend is used as primary
 * Server auto-initializes by default in test environment
 */
export function configureBackendForTest(
  backendConfig: TestConfiguration,
  originalBlockfrostKey?: string
): void {
  if (backendConfig.backendName === 'koios') {
    // Only Koios backend
    process.env.BACKENDS = 'koios';
    delete process.env.BLOCKFROST_API_KEY;
  } else if (backendConfig.backendName === 'blockfrost') {
    // Only Blockfrost backend
    process.env.BACKENDS = 'blockfrost';
    if (originalBlockfrostKey) {
      process.env.BLOCKFROST_API_KEY = originalBlockfrostKey;
    }
  }
}
