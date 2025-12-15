import {
  Transaction as TransactionProviderData,
  Address as AddressProviderData,
  UTxO as UtxosProviderData,
  TxInputLine as TxInputProviderData,
  TxOutputLine as TxOutputProviderData,
  Amount as AmountProviderData,
  Network as NetworkInfoProviderData,
  LatestBlock as LatestBlockProviderData,
  LatestEpoch as LatestEpochProviderData,
  MetadataLabelTx as MetadataLabelTxProviderData,
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
  LatestBlock as LatestBlockRow,
  LatestEpoch as LatestEpochRow,
} from '#cds-models/CardanoODataService';

import type { Request } from '@sap/cds';
import { BackendError } from './errors';
import { ERROR_CODES } from './error-codes';
import { CONFIG } from '../../config/config';

const MAX_AGE_MS = CONFIG.indexTtlMs;
// -----------------------------------------------------------------------------
// Transactions
// -----------------------------------------------------------------------------

export function mapTransaction(providerTx: TransactionProviderData): TransactionRow {
  const blockTimeIso =
    providerTx.blockTime != null
      ? new Date(providerTx.blockTime * 1000).toISOString()
      : null;

  return {
    hash: providerTx.hash,
    blockHash: providerTx.blockHash,
    blockHeight: providerTx.blockHeight ?? null,
    blockTime: blockTimeIso,
    slot: providerTx.slot ?? null,
    txIndex: providerTx.index ?? null,
    fee: providerTx.fee != null ? Number(providerTx.fee) : 0,
    deposit: providerTx.deposit != null ? Number(providerTx.deposit) : 0,
    size: providerTx.size ?? null,
    utxoCount: providerTx.utxoCount ?? null,
    withdrawalCount: providerTx.withdrawalCount ?? null,
    mirCertCount: providerTx.mirCertCount ?? null,
    delegationCount: providerTx.delegationCount ?? null,
    stakeCertCount: providerTx.stakeCertCount ?? null,
    poolUpdateCount: providerTx.poolUpdateCount ?? null,
    poolRetireCount: providerTx.poolRetireCount ?? null,
    assetMintOrBurnCount: providerTx.assetMintOrBurnCount ?? null,
    redeemerCount: providerTx.redeemerCount ?? null,
    validContract: providerTx.validContract ?? null,  
  };
}
// -----------------------------------------------------------------------------
// Transaction Inputs
// -----------------------------------------------------------------------------
export function mapTransactionInputs(txHash: string,  txInputs: TxInputProviderData[]): TransactionInputRow[] {
  if (!Array.isArray(txInputs)) return [];

  return txInputs.map((input, idx: number) => {
    const lovelaceEntry = Array.isArray(input.amount)
      ? input.amount.find((a: AmountProviderData) => a.unit === 'lovelace')
      : null;
    const valueLovelace = lovelaceEntry?.quantity ?? '0';
    const inputIndex = input.outputIndex ?? idx;
    return {
      tx_hash: txHash,
      inputIndex: inputIndex,
      address_address: input.address,
      utxoData_dataHash: input.dataHash || null,
      utxoData_inlineDatum: input.inlineDatum || null,
      utxoData_referenceScriptHash: input.referenceScriptHash || null,
      isCollateral: Boolean(input.isCollateral),
      isReference: Boolean(input.isReference),
    };
  });
}

export function mapTransactionInputAssets(
  txHash: string,
  inputs: TxInputProviderData[]
): TransactionInputAssetRow[] {
  if (!Array.isArray(inputs)) return [];

  return inputs.flatMap((input, idx) => {
    if (!Array.isArray(input.amount) || input.amount.length === 0) return [];

    const inputIndex = input.outputIndex ?? idx;

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

export function mapTransactionOutputAssets(
  txHash: string,
  outputs: TxOutputProviderData[]
): TransactionOutputAssetRow[] {
  if (!Array.isArray(outputs)) return [];
  return outputs.flatMap((output, idx) => {
    if (!Array.isArray(output.amount) || output.amount.length === 0) return [];

    const outputIndex = output.outputIndex ?? idx;

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
// Transaction Outputs
// -----------------------------------------------------------------------------

export function mapTransactionOutputs(txHash: string, txOutputs: TxOutputProviderData[]): TransactionOutputRow[] {

  if (!Array.isArray(txOutputs)) return [];

  return txOutputs.map((output, idx: number) => {

    const lovelaceEntry = Array.isArray(output.amount)
      ? output.amount.find((a) => a.unit === 'lovelace')
      : null;
    const valueLovelace = lovelaceEntry?.quantity ?? '0';
    const outputIndex = output.outputIndex ?? idx;

    return {
      tx_hash: txHash,
      outputIndex: outputIndex,
      address_address: output.address,
      utxo_dataHash: output.dataHash || null,
      utxo_inlineDatum: output.inlineDatum || null,
      utxo_referenceScriptHash: output.referenceScriptHash || null,
    };
  });
}

// -----------------------------------------------------------------------------
// Addresses
// -----------------------------------------------------------------------------

export function mapAddress(address: string, addressData: AddressProviderData): AddressRow {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const validToIso = new Date(now + MAX_AGE_MS).toISOString();

  const totalLovelace =
    Array.isArray(addressData?.amount)
      ? Number(addressData.amount.find((a) => a.unit === 'lovelace')?.quantity || 0)
      : 0;

  return {
    address,
    stakeAddress: addressData.stakeAddress || null,
    type: addressData.type,
    isScript: addressData.isScript,
    totalLovelace: totalLovelace,
    validFrom: nowIso,
    validTo: validToIso,
  };
}

export function mapAddressUtxos(addr: string, validFrom: string, validTo: string, addressUtxosData: UtxosProviderData[]): AddressUTxORow[] {

  if (!Array.isArray(addressUtxosData)) return [];
  
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

export function mapAddressAssets(addr: string, validTo: string, validFrom: string, AssetAssets: AmountProviderData[]): AddressAssetRow[] {
 
  if (!Array.isArray(AssetAssets)) return [];

  return AssetAssets
    .filter((asset: AmountProviderData) => asset.unit !== 'lovelace')
    .map((asset: AmountProviderData) => {
      const { policyId, assetName } = parseAssetUnit(asset.unit);
      return {
        address_address: addr,
        unit: asset.unit,
        validFrom: validFrom,
        validTo,
        asset_quantity: Number(asset.quantity),
        asset_policyId: policyId,
        asset_assetName: assetName,
      };
    });
}

export function mapNetworkInfo(providerNetworkData: NetworkInfoProviderData): NetworkInfoRow {
  
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const validToIso = new Date(now + MAX_AGE_MS).toISOString();

  return {
    network: CONFIG.network,
    validFrom: nowIso,
    validTo: validToIso,
    maxSupply: Number(providerNetworkData.supply.max),
    circulatingSupply: Number( providerNetworkData.supply.circulating),
    totalSupply:  Number(providerNetworkData.supply.total),
    lockedSupply: Number(providerNetworkData.supply.locked),
    treasurySupply: Number(providerNetworkData.supply.treasury),
    reservesSupply: Number(providerNetworkData.supply.reserves),
    liveStake: Number(providerNetworkData.stake.live),
    activeStake: Number(providerNetworkData.stake.active),
  };
}

export function mapLatestBlock(providerBlockData: LatestBlockProviderData,latestEpochData: LatestEpochRow) : LatestBlockRow {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const validToIso = new Date(now + MAX_AGE_MS).toISOString();
  return {
    validFrom: nowIso,
    validTo: validToIso,
    time: new Date(providerBlockData.time * 1000).toISOString(),
    height: providerBlockData.height,
    hash: providerBlockData.hash,  
    slotLeader: String(providerBlockData.slot ?? null),
    epochNumber: latestEpochData.epoch,
    epoch: latestEpochData, 
    epochSlot: providerBlockData.epochSlot,
    size: providerBlockData.size,
    txCount: providerBlockData.txCount,
    fees: Number(providerBlockData.fees),
  };
} 

export function mapLatestEpoch(providerEpochData: LatestEpochProviderData) : LatestEpochRow {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const validToIso = new Date(now + MAX_AGE_MS).toISOString();
  return {
    validFrom: nowIso,
    validTo: validToIso,
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

export function mapTransactionMetadata(
  providerLabels: MetadataLabelTxProviderData[],
): TransactionMetadataRow[] {
  if (!Array.isArray(providerLabels)) return [];

  const rows: TransactionMetadataRow[] = [];

  for (const lbl of providerLabels) {
    const numericLabel = Number(lbl.label);

    if (Number.isNaN(numericLabel)) {
      continue;
    }

    rows.push({
      tx_hash: lbl.txHash,
      label: numericLabel.toString(),
      payload: lbl.json !== undefined ? JSON.stringify(lbl.json) : null,
    });
  }


  return rows;
}

export function mapError(req: Request, err: unknown, ctx: string) {
  const r = req as any;

  if (err instanceof BackendError) {
    return req.reject(
      err.statusCode,
      fmt(err.code, ctx, err.message),
      err.target
    );
  }
  return req.reject(
    500,
    fmt(ERROR_CODES.INTERNAL_ERROR, ctx, 'Internal server error')
  );
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