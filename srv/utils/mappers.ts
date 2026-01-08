import {
  Transaction as TransactionProviderData,
  Address as AddressProviderData,
  UTxO as UtxosProviderData,
  TxInputLine as TxInputProviderData,
  TxOutputLine as TxOutputProviderData,
  Amount as AmountProviderData,
  Network as NetworkInfoProviderData,
  BlockData as BlockProviderData,
  EpochData as EpochProviderData,
  MetadataLabelTx as MetadataLabelTxProviderData,
  PoolData as PoolProviderData,
  DrepData as DrepProviderData,
  AccountData as AccountProviderData,
  TxBuildResult as TransactionBuildResult,
  LedgerProtocolParameters as ProtocolParameters,
} from './types';

import {
  Address as AddressRow,
  AddressAsset as AddressAssetRow,
  AddressUTxO as AddressUTxORow,
  UTxOAsset as UTxOAssetRow,
  Transaction as TransactionRow,
  TransactionInput as TransactionInputRow,
  TransactionInputAsset as TransactionInputAssetRow,
  TransactionOutput as TransactionOutputRow,
  TransactionOutputAsset as TransactionOutputAssetRow,
  NetworkInformation as NetworkInfoRow,
  TransactionMetadata as TransactionMetadataRow,
  Block as BlockRow,
  Epoch as EpochRow,
  Pool as PoolRow,
  Drep as DrepRow,
  Account as AccountRow,
}  from '#cds-models/CardanoODataService';

import type { TransactionBuild as  TransactionBuildRow, 
              LedgerProtocolParameter as ProtocolParameterRow,
              TransactionSubmission as TransactionSubmissionRow
} from '#cds-models/CardanoTransactionService';


import type { Request } from '@sap/cds';
import { BackendError } from './errors';
import { CONFIG } from '../../config/config';
import cds from '@sap/cds';

/** 
 * Maximum age for cached/indexed data in milliseconds 
 */
const MAX_AGE_MS = CONFIG.indexTtlMs;

/** 
 * Map Transaction Data
 * Converts provider transaction data into TransactionRow format
 * @param providerTx 
 * @returns {TransactionRow} mapped transaction row 
 */
export function mapTransaction(providerTx: TransactionProviderData): TransactionRow {
  // determine presence of optional data
  const hasMetadata = providerTx.metadata != null && (Array.isArray(providerTx.metadata));
  const hasInputs = Array.isArray(providerTx.inputs) && providerTx.inputs.length > 0;
  const hasOutputs = Array.isArray(providerTx.outputs) && providerTx.outputs.length > 0;

  return {
    hash: providerTx.hash,
    blockHash: providerTx.blockHash,
    blockHeight: providerTx.blockHeight ?? null,
    blockTime: providerTx.blockTime ?? null,
    slot: providerTx.slot ?? null,
    txIndex: providerTx.index ?? null,
    fee: providerTx.fee != null ? Number(providerTx.fee) : 0,
    deposit: providerTx.deposit != null ? Number(providerTx.deposit) : 0,
    size: providerTx.size ?? null,
    hasInputs: hasInputs,
    hasOutputs: hasOutputs,
    hasMetadata: hasMetadata,
  };
}

/** 
 * Map Transaction Inputs
 * Converts provider transaction input data into TransactionInputRow format
 * @param txHash transaction hash
 * @param txInputs transaction inputs from provider
 * @returns {TransactionInputRow[]} mapped transaction input rows
 */
export function mapTransactionInputs(txHash: string, txInputs: TxInputProviderData[]): TransactionInputRow[] {
  return txInputs.map((input, idx: number) => {
    // determine input index, defaulting to array index if not provided
    const inputIndex = input.outputIndex ?? idx;
    // check presence of address and amount arrays
    const hasAddress = !!input.address?.length;
    const hasAssets = Array.isArray(input.amount) && input.amount.length > 0;

    return {
      tx_hash: txHash,
      inputIndex: inputIndex,
      address_address: input.address,
      utxoData_dataHash: input.dataHash || null,
      utxoData_inlineDatum: input.inlineDatum || null,
      utxoData_referenceScriptHash: input.referenceScriptHash || null,
      isCollateral: Boolean(input.isCollateral),
      isReference: Boolean(input.isReference),
      hasAddresses: hasAddress,
      hasAssets: hasAssets,
    };
  });
}

/** 
 * Map Transaction Input Assets
 * Converts provider transaction input asset data into TransactionInputAssetRow format
 * @param txHash transaction hash
 * @param inputs transaction inputs from provider
 * @returns {TransactionInputAssetRow[]} mapped transaction input asset rows
 */
export function mapTransactionInputAssets(
  txHash: string,
  inputs: TxInputProviderData[]
): TransactionInputAssetRow[] {
  if (!Array.isArray(inputs)) return [];

  return inputs.flatMap((input, idx) => {

    const inputIndex = input.outputIndex ?? idx;

    if (!Array.isArray(input.amount)) return [];

    return input.amount.map(a => {
      const { policyId, assetName } = parseAssetUnit(a.unit);

      return {
        input_tx_hash: txHash,
        input_inputIndex: inputIndex,
        unit: a.unit,
        asset_quantity: Number(a.quantity),
        asset_policyId: policyId,
        asset_assetName: assetName,
      };
    });
  });
}

/** 
 * Map Transaction Outputs
 * Converts provider transaction output data into TransactionOutputRow format
 * @param txHash transaction hash
 * @param txOutputs transaction outputs from provider
 * @returns {TransactionOutputRow[]} mapped transaction output rows
 */
export function mapTransactionOutputs(txHash: string, txOutputs: TxOutputProviderData[]): TransactionOutputRow[] {
  return txOutputs.map((output, idx: number) => {

    const outputIndex = output.outputIndex ?? idx;
    const hasAddresses = !!output.address?.length;
    const hasAssets = Array.isArray(output.amount) && output.amount.length > 0;

    return {
      tx_hash: txHash,
      outputIndex: outputIndex,
      address_address: output.address,
      utxo_dataHash: output.dataHash || null,
      utxo_inlineDatum: output.inlineDatum || null,
      utxo_referenceScriptHash: output.referenceScriptHash || null,
      hasAddresses: hasAddresses,
      hasAssets: hasAssets,
    };
  });
}

/** 
 * Map Transaction Output Assets
 * Converts provider transaction output asset data into TransactionOutputAssetRow format
 * @param txHash transaction hash
 * @param outputs transaction outputs from provider
 * @returns {TransactionOutputAssetRow[]} mapped transaction output asset rows
 */
export function mapTransactionOutputAssets(
  txHash: string, 
  outputs: TxOutputProviderData[]
): TransactionOutputAssetRow[] {
  return outputs.flatMap((output, idx) => {

    const outputIndex = output.outputIndex ?? idx;
    if (!Array.isArray(output.amount)) return [];
    
    return output.amount.map(a => {
      const { policyId, assetName } = parseAssetUnit(a.unit);
      return {
        output_tx_hash: txHash,
        output_outputIndex: outputIndex,
        unit: a.unit,
        asset_quantity: Number(a.quantity),
        asset_policyId: policyId,
        asset_assetName: assetName,
      };
    });
  });
}

/** 
 * Map Address Data
 * Converts provider address data into AddressRow format
 * @param address address string
 * @param addressData address data from provider
 * @returns {AddressRow} mapped address row
 */
export function mapAddress(address: string, addressData: AddressProviderData): AddressRow {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const validToIso = new Date(now + MAX_AGE_MS).toISOString();
  const totalLovelace = Array.isArray(addressData.amount) 
    ? Number(addressData.amount.find((a) => a.unit === 'lovelace')?.quantity || 0)
    : 0;

  const hasUtxos = Array.isArray(addressData.utxos) && addressData.utxos.length > 0;
  const hasAssets = Array.isArray(addressData.amount) && addressData.amount.length > 0;
  return {
    address,
    stakeAddress: addressData.stakeAddress || null,
    type: addressData.type ?? 'base',
    isScript: addressData.isScript ?? false,
    totalLovelace: totalLovelace,
    validFrom: nowIso,
    validTo: validToIso,
    hasAssets: hasAssets,
    hasUTxOs: hasUtxos,
  };
}

/** 
 * Map Address UTxOs
 * @param addr address string
 * @param validFrom validFrom
 * @param validTo validTo
 * @param addressUtxosData address UTxOs data from provider 
 * @returns {AddressUTxORow[]} mapped address UTxO rows
 */
export function mapAddressUtxos(addr: string, validFrom: string, validTo: string, addressUtxosData: UtxosProviderData[]): AddressUTxORow[] {
  
   const hasAssets = addressUtxosData.some((utxo: UtxosProviderData) => 
    Array.isArray(utxo.amount) && utxo.amount.some((a) => a.unit !== 'lovelace')
  );
  const totalLovelace = addressUtxosData.reduce((sum, utxo) => {
    if (!Array.isArray(utxo.amount)) return sum;
    const lovelaceAmount = Number(utxo.amount.find((a) => a.unit === 'lovelace')?.quantity || 0);
    return sum + lovelaceAmount;
  }, 0);

  return addressUtxosData.map((utxo: UtxosProviderData) => ({
    address_address: addr,
    hash: utxo.txHash,
    index: utxo.outputIndex,
    blockHash: utxo.blockHash,
    utxodata_dataHash: utxo.datumHash,
    utxodata_inlineDatum: null,
    utxodata_referenceScriptHash: utxo.scriptRef,
    totalLovelace: totalLovelace,
    validFrom: validFrom,
    validTo: validTo,
    hasAssets: hasAssets,
  }));
}

/** 
 * Map Address Assets
 * Converts provider address asset data into AddressAssetRow format
 * @param addr address string
 * @param validFrom validFrom
 * @param validTo validTo
 * @param AssetAssets address assets from provider
 * @returns {AddressAssetRow[]} mapped address asset rows
 */
export function mapAddressAssets(addr: string, validFrom: string, validTo: string, AssetAssets: AmountProviderData[]): AddressAssetRow[] {
  return AssetAssets
    .filter((asset: AmountProviderData) => asset.unit !== 'lovelace')
    .map((asset: AmountProviderData) => {
      const { policyId, assetName } = parseAssetUnit(asset.unit);
      return {
        address_address: addr,
        unit: asset.unit,
        validFrom: validFrom,
        validTo: validTo,
        asset_quantity: Number(asset.quantity),
        asset_policyId: policyId,
        asset_assetName: assetName,
      };
    });
}

/** 
 * Map UTxO Assets
 * Converts provider address UTxO asset data into UTxOAssetRow format
 * @param addressUtxosData address UTxOs data from provider
 * @param validFrom validFrom
 * @param validTo validTo
 * @returns {UTxOAssetRow[]} mapped UTxO asset rows
 */ 
export function mapAddressUtxoAssets(
  addressUtxosData: UtxosProviderData[],
  validFrom: string, validTo: string,
  ): UTxOAssetRow[] {
  const assets: UTxOAssetRow[] = [];

  addressUtxosData.forEach((utxo: UtxosProviderData) => {
    if (!Array.isArray(utxo.amount)) return;
    
    for (const asset of utxo.amount) {
      if (!asset || !asset.unit || asset.unit === 'lovelace') continue;
      const { policyId, assetName } = parseAssetUnit(asset.unit);
      assets.push({
        utxo_address_address: utxo.address,
        utxo_hash: utxo.txHash,
        utxo_index: utxo.outputIndex,
        unit: asset.unit,
        validFrom: validFrom,
        validTo: validTo,
        asset_quantity: Number(asset.quantity),
        asset_policyId: policyId,
        asset_assetName: assetName,
      });
    }
      });
  return assets;
}

/** 
 * Map Network Information
 * Converts provider network information data into NetworkInfoRow format
 * @param providerNetworkData 
 * @returns {NetworkInfoRow} mapped network information row
 */
export function mapNetworkInfo(providerNetworkData: NetworkInfoProviderData): NetworkInfoRow {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const validToIso = new Date(now + MAX_AGE_MS).toISOString();

  return {
    network: CONFIG.network,
    validFrom: nowIso,
    validTo: validToIso,
    maxSupply: Number(providerNetworkData.supply.max),
    circulatingSupply: Number(providerNetworkData.supply.circulating),
    totalSupply: Number(providerNetworkData.supply.total),
    lockedSupply: Number(providerNetworkData.supply.locked),
    treasurySupply: Number(providerNetworkData.supply.treasury),
    reservesSupply: Number(providerNetworkData.supply.reserves),
    liveStake: Number(providerNetworkData.stake.live),
    activeStake: Number(providerNetworkData.stake.active),
  };
}

/** 
 * Map Block Data
 * Converts provider block data into BlockRow format
 * @param providerBlockData block data from provider
 * @param epochData epoch data for the block's epoch
 * @returns {BlockRow} mapped block row
 */
export function mapBlock(providerBlockData: BlockProviderData, epochData: EpochRow): BlockRow {
  return {
    time: new Date(providerBlockData.time * 1000).toISOString(),
    height: providerBlockData.height,
    hash: providerBlockData.hash,
    slotLeader: String(providerBlockData.slot ?? null),
    epochNumber: epochData.epoch,
    epoch: epochData,
    epochSlot: providerBlockData.epochSlot,
    size: providerBlockData.size,
    txCount: providerBlockData.txCount,
    fees: Number(providerBlockData.fees),
  };
}

/** 
 * Map Epoch Data
 * Converts provider epoch data into EpochRow format
 * @param providerEpochData epoch data from provider
 * @returns {EpochRow} mapped epoch row
 */
export function mapEpoch(providerEpochData: EpochProviderData): EpochRow {
  return {
    epoch: providerEpochData.epoch,
    startTime: providerEpochData.start_time,
    endTime: providerEpochData.end_time,
    firstBlockTime: providerEpochData.first_block_time,
    lastBlockTime: providerEpochData.last_block_time,
    blockCount: providerEpochData.block_count,
    txCount: providerEpochData.tx_count,
    output: providerEpochData.output,
    fees: Number(providerEpochData.fees),
    activeStake: Number(providerEpochData.active_stake),
  };
}

/** 
 * Map Transaction Metadata
 * Converts provider transaction metadata labels into TransactionMetadataRow format
 * @param providerLabels array of metadata label data from provider
 * @returns {TransactionMetadataRow[]} mapped transaction metadata rows
 */
export function mapTransactionMetadata(providerLabels: MetadataLabelTxProviderData[]): TransactionMetadataRow[] {
  const rows: TransactionMetadataRow[] = [];

  for (const [idx, lbl] of providerLabels.entries()) {
    rows.push({
      id: idx,
      tx_hash: lbl.txHash,
      label: lbl.label.toString(),
      payload: lbl.json !== undefined ? JSON.stringify(lbl.json) : null,
    });
  }
  return rows;
}

/** 
 * Map Pool Data
 * Converts provider pool data into PoolRow format
 * @param providerPoolData pool data from provider
 * @returns {PoolRow} mapped pool row
 */
export function mapPool(providerPoolData: PoolProviderData): PoolRow {
  return {
    poolId: providerPoolData.poolId,
    vrfKeyHash: providerPoolData.vrfKeyHash,
    blocksMinted: providerPoolData.blocksMinted,
    blocksEpoch: providerPoolData.blocksEpoch,
    liveStake: Number(providerPoolData.liveStake),
    liveSize: providerPoolData.liveSize,
    liveDelegators: providerPoolData.liveDelegators,
    liveSaturation: providerPoolData.liveSaturation,
    activeStake: Number(providerPoolData.activeStake),
    activeSize: providerPoolData.activeSize,
    pledge: Number(providerPoolData.pledge),
    margin: Number(providerPoolData.margin),
    fixedCost: Number(providerPoolData.fixedCost),
    rewardAccount: providerPoolData.rewardAccount,
  };
}

/** 
 * Map Drep Data
 * Converts provider drep data into DrepRow format
 * @param providerDrepData drep data from provider
 * @returns {DrepRow} mapped drep row
 */
export function mapDrep(providerDrepData: DrepProviderData): DrepRow {
  return {
    drepId  : providerDrepData.drepId,
    hex: providerDrepData.hex,
    amount: Number(providerDrepData.amount),
    hasScript: Boolean(providerDrepData.hasScript),
    lastActiveEpoch: providerDrepData.lastActiveEpoch,
    retired: Boolean(providerDrepData.retired),
    expired: Boolean(providerDrepData.expired),
  };
}

/** 
 * Map Account Data
 * Converts provider account data into AccountRow format
 * @param providerAccountData account data from provider
 * @returns {AccountRow} mapped account row
 */
export function mapAccount(providerAccountData: AccountProviderData): AccountRow {
  const validFrom = new Date().toISOString();
  const validTo = new Date(Date.now() + MAX_AGE_MS).toISOString();
        
  return {
    validFrom: validFrom,
    validTo: validTo,
    stakeAddress: providerAccountData.stakeaddress,
    active: providerAccountData.active,
    activeEpoch: providerAccountData.activeEpoch,
    controlledAmount: Number(providerAccountData.controlledAmount),
    rewardsSum: Number(providerAccountData.rewardsSum),
    withdrawalsSum: Number(providerAccountData.withdrawalsSum),
    reservesSum: Number(providerAccountData.reservesSum),
    treasurySum: Number(providerAccountData.treasurySum),
    withdrawableAmount: Number(providerAccountData.withdrawableAmount),
    hasAddresses: providerAccountData.addresses.length > 0,
  };
}

/** 
 * Map Backend Error
 * Converts BackendError into OData request rejection
 * @param req OData request
 * @param err error object
 * @param ctx context string for error message
 */
export function mapError(req: Request, err: unknown, ctx: string) {
  if (err instanceof BackendError) {
    return req.reject(
      err.statusCode,
      fmt(err.code, ctx, err.message),
      err.target
    );
  }
}

/** 
 * Map Transaction Build Result
 * Converts provider transaction build result into TransactionBuildRow format
 * @param txbuildResult transaction build result from provider
 * @returns {TransactionBuildRow} mapped transaction build row
 */
export function mapBuildResult(txbuildResult: TransactionBuildResult): TransactionBuildRow{
  const buildId = cds.utils.uuid();
  const now = Math.floor(Date.now() / 1000);
  const validFrom = new Date().toISOString();
  const validTo = new Date(Date.now() + MAX_AGE_MS).toISOString();
  const hasInputs = Array.isArray(txbuildResult.inputs) && txbuildResult.inputs.length > 0;
  const hasOutputs = Array.isArray(txbuildResult.outputs) && txbuildResult.outputs.length > 0;

  return {
    id: buildId,
    validFrom: validFrom,
    validTo: validTo,
    builderEngine: txbuildResult.builderEngine,
    network: txbuildResult.network,
    senderAddress: txbuildResult.senderAddress,
    changeAddress: txbuildResult.senderAddress,
    unsignedTxCbor: txbuildResult.unsignedTxCbor,
    txBodyHash: txbuildResult.txBodyHash,
    fee: Number(txbuildResult.feeLovelace),
    size               : txbuildResult.sizeBytes, // size in bytes
    createdAt          : now, // epoch seconds
   // inputs             : txbuildResult.inputs,
   // outputs            : txbuildResult.outputs ? JSON.stringify(txbuildResult.outputs) : null,
    submission         : null,
    hasInputs          : hasInputs, // indicates if build has inputs
    hasOutputs         : hasOutputs, // indicates if build has outputs
    wasSubmitted       : false, // indicates if this build was submitted
  }
  
}

/** 
 * Map Protocol Parameters
 * Converts provider protocol parameters into ProtocolParameterRow format
 * @param providerParams protocol parameters from provider
 * @returns {ProtocolParameterRow} mapped protocol parameter row
 */
export function mapProtocolParameters(providerParams: ProtocolParameters): ProtocolParameterRow {
  return {
    network: providerParams.network,
    epoch: providerParams.epoch,
    minFeeA: providerParams.minFeeA,
    minFeeB: providerParams.minFeeB,
    maxBlockSize: providerParams.maxBlockSize,
    maxTxSize: providerParams.maxTxSize,
    maxBlockHeaderSize: providerParams.maxBlockHeaderSize,
    keyDeposit: providerParams.keyDeposit,
    poolDeposit: providerParams.poolDeposit,
    eMax: providerParams.eMax,
    nOpt: providerParams.nOpt,
    a0: providerParams.a0,
    rho: providerParams.rho,
    tau: providerParams.tau,
    minPoolCost: providerParams.minPoolCost,
    decentralisationParam: providerParams.decentralisationParam,
    extraEntropy: providerParams.extraEntropy,
    protocolMajorVer: providerParams.protocolMajorVer,
    protocolMinorVer: providerParams.protocolMinorVer,
    minUtxo: providerParams.minUtxo,
    nonce: providerParams.nonce,
    costModels: providerParams.costModels,
    priceMem: providerParams.priceMem,
    priceStep: providerParams.priceStep,
    maxTxExMem: providerParams.maxTxExMem,
    maxTxExSteps: providerParams.maxTxExSteps,
    maxBlockExMem: providerParams.maxBlockExMem,
    maxBlockExSteps: providerParams.maxBlockExSteps,
    maxValSize: providerParams.maxValSize,
    collateralPercent: providerParams.collateralPercent,
    maxCollateralInputs: providerParams.maxCollateralInputs,
    coinsPerUtxoSize: providerParams.coinsPerUtxoSize,
    fetchedAt: providerParams.fetchedAt,
    source: providerParams.source,
  };
}

/** 
 * Map Transaction Submission
 * Converts signed transaction CBOR and hash into TransactionSubmissionRow format
 * @param signedTxCbor signed transaction in CBOR hex format
 * @param txHash transaction hash
 * @returns {TransactionSubmissionRow} mapped transaction submission row
 */
export function mapTransactionSubmission(signedTxCbor: string, txHash: string): TransactionSubmissionRow {
  const now = Math.floor(Date.now() / 1000);
  const validFrom = new Date().toISOString();
  const validTo = new Date(Date.now() + MAX_AGE_MS).toISOString();
  return {
    signedTxCbor: signedTxCbor,
    txHash: txHash,
    validFrom: validFrom,
    validTo: validTo,
    submittedAt: now,
  };
}

//-----------------------------------------------------------------------
// Helper Functions
//-----------------------------------------------------------------------

/** 
 * Convert hex string to UTF-8 string, falling back to hex if conversion fails.
 * This helper reduces code duplication and improves performance by centralizing
 * the conversion logic.
 * 
 * @param hex - Hexadecimal string to convert
 * @returns {string} UTF-8 string or original hex if conversion fails
 */
function hexToUtf8(hex: string): string {
  if (!hex) return hex;

  return Buffer.from(hex, 'hex').toString('utf8');
}

/** 
 * Parse asset unit (policyId + assetNameHex) into components.
 * Optimizes repeated parsing logic across multiple mapper functions.
 * @param unit - Asset unit string (56 char policyId + asset name hex)
 * @returns { policyId: string | null; assetName: string | null } Object with policyId and assetName
 */
function parseAssetUnit(unit: string): { policyId: string | null; assetName: string | null } {
  if (unit === 'lovelace') {
    return { policyId: null, assetName: 'lovelace' };
  }

  const policyId = unit.slice(0, 56);
  const assetNameHex = unit.slice(56);
  const assetName = hexToUtf8(assetNameHex);

  return { policyId, assetName };
}

/** 
 * Format error message
 * @param code error code
 * @param ctx context string
 * @param msg error message
 * @returns {string} formatted error message
 */
function fmt(code: string, ctx: string, msg: string): string {
  return `[${code}] ${ctx}: ${msg}`;
}