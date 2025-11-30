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
  MetadataLabel as MetadataLabelProviderData,
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
  Metadata as MetadataRow,
  MetadataLabel as MetadataLabelsRow,
} from '#cds-models/CardanoODataService';
import { tx } from '@sap/cds';
import e from 'express';

const MAX_AGE_MINUTES = Number(process.env.ADDR_MAX_AGE_MIN ?? 1);
const MAX_AGE_MS = MAX_AGE_MINUTES * 60 * 1000;

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
    blockTime: blockTimeIso, // string | null 
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
      ? input.amount.find((a: any) => a.unit === 'lovelace')
      : null;
    const valueLovelace = lovelaceEntry?.quantity ?? '0';
    const inputIndex = input.outputIndex ?? idx;
    return {
      txHash: txHash,
      inputIndex: inputIndex,
      sourceTxHash: input.txHash,
      sourceOutputIndex: input.outputIndex,
      utxo_address_bech32: input.address,
      utxo_valueLovelace: Number(valueLovelace),
      utxo_datumHash: input.dataHash || null,
      utxo_inlineDatum: input.inlineDatum || null,
      utxo_referenceScript: input.referenceScriptHash || null,
      utxo_isScript: Boolean(
        input.inlineDatum ||
        input.dataHash ||
        input.referenceScriptHash
      ),
      isCollateral: Boolean(input.isCollateral),
      isReference: Boolean(input.isReference),
    };
  });
}

export function mapTransactionAssets(
  txHash: string,
  inputs: TxInputProviderData[]
): TransactionInputAssetRow[] {
  if (!Array.isArray(inputs)) return [];

  return inputs.flatMap((input, idx) => {
    if (!Array.isArray(input.amount) || input.amount.length === 0) return [];

    const inputIndex = input.outputIndex ?? idx;

    return input.amount.map(a => {
      const unit = a.unit;
      const quantity = a.quantity;

      let policyId: string | null = null;
      let assetName: string | null = null;

      if (unit === 'lovelace') {
        assetName = 'lovelace';
      } else {
        const policy = unit.slice(0, 56);
        const assetNameHex = unit.slice(56);
        policyId = policy;

        try {
          assetName = Buffer.from(assetNameHex, 'hex').toString('utf8');
        } catch {
          assetName = assetNameHex;
        }
      }

      return {
        txHash,
        inputIndex,
        unit,
        asset_quantity: Number(quantity),
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
      txHash: txHash,
      output_index: outputIndex,
      utxo_address_bech32: output.address,
      utxo_valueLovelace: Number(valueLovelace),
      utxo_datumHash: output.dataHash || null,
      utxo_inlineDatum: output.inlineDatum || null,
      utxo_referenceScript: output.referenceScriptHash || null,
      utxo_isScript: Boolean(
        output.inlineDatum ||
        output.dataHash ||
        output.referenceScriptHash
      ),
    };
  });
}

// -----------------------------------------------------------------------------
// Addresses
// -----------------------------------------------------------------------------

export function mapAddress(address: string, addressData: AddressProviderData): AddressRow {
  const nowIso = new Date().toISOString();
  const validToIso = new Date(Date.now() + MAX_AGE_MS).toISOString();
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

export function mapAddressUtxos(addr: string, validTo: string, addressUtxosData: UtxosProviderData[]): AddressUTxORow[] {
  const nowIso = new Date().toISOString();

  if (!Array.isArray(addressUtxosData)) return [];

  return addressUtxosData.map((a: any) => ({
    address_address: addr,
    hash: a.tx_hash,
    index: a.output_index,
    blockHash: a.block_hash,
    utxodata_dataHash: a.data_hash,
    utxodata_inlineDatum: a.inline_datum,
    utxodata_referenceScriptHash: a.reference_script_hash,
    validFrom: nowIso,
    validTo,
  }));
}

export function mapAddressAssets(addr: string, validTo: string, AssetAssets: AmountProviderData[]): AddressAssetRow[] {
  const nowIso = new Date().toISOString();

  if (!Array.isArray(AssetAssets)) return [];

  return AssetAssets
    .filter((a: any) => a.unit !== 'lovelace')
    .map((a: any) => {
      const assetNameHex = a.unit.slice(56);

      let assetName: string;
      try {
        assetName = Buffer.from(assetNameHex, 'hex').toString('utf8');
      } catch {
        assetName = assetNameHex;
      }

      return {
        address_address: addr,
        unit: a.unit,
        validFrom: nowIso,
        validTo,
        asset_quantity: a.quantity,
        asset_policyId: a.unit.slice(0, 56),
        asset_assetName: assetName,
      };
    });
}

export function mapNetworkInfo(providerNetworkData: NetworkInfoProviderData): NetworkInfoRow {
  return {
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

export function mapLatestBlock(providerBlockData: LatestBlockProviderData) {
  return {
    blockHeight: providerBlockData.height,
    blockHash: providerBlockData.hash,  
    slot: providerBlockData.slot,
    epoch: providerBlockData.epoch,
    epochSlot: providerBlockData.epochSlot,
    slotInEpoch: providerBlockData.slot,
    blockTime: new Date(providerBlockData.time * 1000).toISOString(),
  };
} 

export function mapLatestEpoch(providerEpochData: LatestEpochProviderData) {
  return {
    epoch: providerEpochData.epoch,
    startTime: new Date(providerEpochData.start_time * 1000).toISOString(),
    endTime: new Date(providerEpochData.end_time * 1000).toISOString(),
    blockCount: providerEpochData.block_count,
    txCount: providerEpochData.tx_count,
    output: Number(providerEpochData.output),
    fees: Number(providerEpochData.fees),
    activeStake: Number(providerEpochData.active_stake),
  };
}

export function mapMetadataLabels(
  providerLabels: MetadataLabelProviderData[]
): MetadataLabelsRow[] {
  if (!Array.isArray(providerLabels)) return [];

  const rows: MetadataLabelsRow[] = [];

  for (const lbl of providerLabels) {
    const numericLabel = Number(lbl.label);

    if (Number.isNaN(numericLabel)) {
      continue;
    }

    rows.push({
      label: numericLabel.toString() as MetadataLabelsRow['label'],
      cip10: lbl.cip10 ?? '',
      count: lbl.count ?? 0,
    });
  }

  return rows;
}

export function mapMetadataFromLabelTxs(
  providerLabelTxs: MetadataLabelTxProviderData[]
): MetadataRow[] {
  if (!Array.isArray(providerLabelTxs)) return [];

  const rows: MetadataRow[] = [];

  for (const txMeta of providerLabelTxs) {
    const numericLabel = Number(txMeta.label);
    if (Number.isNaN(numericLabel)) continue;

    rows.push({
      txHash_hash: txMeta.txHash as MetadataRow['txHash_hash'],
      label_label: numericLabel.toString() as MetadataLabelsRow['label'],
      payloadJson:
        txMeta.json !== undefined
          ? JSON.stringify(txMeta.json)
          : null,
    });
  }

  return rows;
}

// -----------------------------------------------------------------------------
// Error Mapping
// -----------------------------------------------------------------------------

function mapProviderError(err: any) {
  return {
    status: err.status || err.code || 500,
    message: err.message || String(err),
  };
}

export function mapError(req: any, err: any, ctx: string) {
  const mapped = mapProviderError(err);
  const status = mapped.status || 500;
  const message = mapped.message || `${ctx} operation failed`;
  return req.error(status, `${ctx}: ${message}`);
}
