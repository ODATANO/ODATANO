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
} from './types';

import {
  Address as AddressRow,
  AddressAsset as AddressAssetRow,
  AddressUTxO as AddressUTxORow,
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
} from '#cds-models/CardanoODataService';

import type { Request } from '@sap/cds';
import { BackendError } from './errors';
import { CONFIG } from '../../config/config';

const MAX_AGE_MS = CONFIG.indexTtlMs;
// -----------------------------------------------------------------------------
// Transactions
// -----------------------------------------------------------------------------

export function mapTransaction(providerTx: TransactionProviderData): TransactionRow {
  // Determine presence of optional data
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
// -----------------------------------------------------------------------------
// Transaction Inputs
// -----------------------------------------------------------------------------
export function mapTransactionInputs(txHash: string, txInputs: TxInputProviderData[]): TransactionInputRow[] {
  return txInputs.map((input, idx: number) => {
    
    // Determine input index, defaulting to array index if not provided
    const inputIndex = input.outputIndex ?? idx;
    // Check presence of address and amount arrays
    const hasAddress = Array.isArray(input.address) && input.address.length > 0;
    const hasAmount = Array.isArray(input.amount) && input.amount.length > 0;

    return {
      tx_hash: txHash,
      inputIndex: inputIndex,
      address_address: input.address,
      utxoData_dataHash: input.dataHash || null,
      utxoData_inlineDatum: input.inlineDatum || null,
      utxoData_referenceScriptHash: input.referenceScriptHash || null,
      isCollateral: Boolean(input.isCollateral),
      isReference: Boolean(input.isReference),
      hasAddress: hasAddress,
      hasAmount: hasAmount,
    };
  });
}

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

// -----------------------------------------------------------------------------
// Transaction Outputs
// -----------------------------------------------------------------------------

export function mapTransactionOutputs(txHash: string, txOutputs: TxOutputProviderData[]): TransactionOutputRow[] {
  return txOutputs.map((output, idx: number) => {

    const outputIndex = output.outputIndex ?? idx;
    const hasAddress = Array.isArray(output.address) && output.address.length > 0;
    const hasAmount = Array.isArray(output.amount) && output.amount.length > 0;

    return {
      tx_hash: txHash,
      outputIndex: outputIndex,
      address_address: output.address,
      utxo_dataHash: output.dataHash || null,
      utxo_inlineDatum: output.inlineDatum || null,
      utxo_referenceScriptHash: output.referenceScriptHash || null,
      hasAddresses: hasAddress,
      hasAmounts: hasAmount,
    };
  });
}

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
// -----------------------------------------------------------------------------
// Addresses
// -----------------------------------------------------------------------------

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

export function mapAddressUtxos(addr: string, validFrom: string, validTo: string, addressUtxosData: UtxosProviderData[]): AddressUTxORow[] {
    return addressUtxosData.map((utxo: UtxosProviderData) => ({
    address_address: addr,
    hash: utxo.txHash,
    index: utxo.outputIndex,
    blockHash: utxo.blockHash,
    utxodata_dataHash: utxo.datumHash,
    utxodata_inlineDatum: null,
    utxodata_referenceScriptHash: utxo.scriptRef,
    validFrom: validFrom,
    validTo: validTo,
  }));
}

export function mapAddressAssets(addr: string, validFrom: string, validTo: string, AssetAssets: AmountProviderData[]): AddressAssetRow[] {

  if (!Array.isArray(AssetAssets)) {
    return [];
  }

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

// -----------------------------------------------------------------------------
// Network Information
// -----------------------------------------------------------------------------
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

// -----------------------------------------------------------------------------
// Blocks
// -----------------------------------------------------------------------------
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

// -----------------------------------------------------------------------------
// Epochs
// -----------------------------------------------------------------------------
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

// -----------------------------------------------------------------------------
// Transaction Metadata
// -----------------------------------------------------------------------------
export function mapTransactionMetadata(
  providerLabels: MetadataLabelTxProviderData[],
): TransactionMetadataRow[] {

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

// -----------------------------------------------------------------------------
// Pools
// -----------------------------------------------------------------------------
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

// -----------------------------------------------------------------------------
// DREPs
// -----------------------------------------------------------------------------
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

// -----------------------------------------------------------------------------
// Accounts
// -----------------------------------------------------------------------------
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
  };
}

// -----------------------------------------------------------------------------
// Error Mapping
// -----------------------------------------------------------------------------
export function mapError(req: Request, err: unknown, ctx: string) {
  if (err instanceof BackendError) {
    return req.reject(
      err.statusCode,
      fmt(err.code, ctx, err.message),
      err.target
    );
  }
}

// -----------------------------------------------------------------------------
// Helper Functions
// -----------------------------------------------------------------------------

/**
 * Convert hex string to UTF-8 string, falling back to hex if conversion fails.
 * This helper reduces code duplication and improves performance by centralizing
 * the conversion logic.
 * 
 * @param hex - Hexadecimal string to convert
 * @returns UTF-8 string or original hex on error
 */
function hexToUtf8(hex: string): string {
  if (!hex) return hex;

  return Buffer.from(hex, 'hex').toString('utf8');
}

/**
 * Parse asset unit (policyId + assetNameHex) into components.
 * Optimizes repeated parsing logic across multiple mapper functions.
 * 
 * @param unit - Asset unit string (56 char policyId + asset name hex)
 * @returns Object with policyId and assetName
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

function fmt(code: string, ctx: string, msg: string) {
  return `[${code}] ${ctx}: ${msg}`;
}