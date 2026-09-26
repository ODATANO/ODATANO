import cds from '@sap/cds';
import { TextDecoder } from 'node:util';
import blake2b from 'blake2b';
import { bech32 } from 'bech32';
import { safeJSON } from '@cardano-ogmios/client';
import { toCostModelArrV3 } from '@harmoniclabs/cardano-costmodels-ts';
import type { AnyV3CostModel } from '@harmoniclabs/cardano-costmodels-ts/dist/v3/AnyV3CostModel';

const logger = cds.log('mappers');
import {
  Transaction as TransactionProviderData,
  Address as AddressProviderData,
  UTxO as UtxosProviderData,
  TxInputLine as TxInputProviderData,
  TxOutputLine as TxOutputProviderData,
  TxCertificate as TxCertificateProviderData,
  TxWithdrawal as TxWithdrawalProviderData,
  Amount as AmountProviderData,
  NetworkInformation as NetworkInfoProviderData,
  BlockData as BlockProviderData,
  EpochData as EpochProviderData,
  MetadataLabelTx as MetadataLabelTxProviderData,
  PoolData as PoolProviderData,
  DrepData as DrepProviderData,
  AccountData as AccountProviderData,
  AssetInfo as AssetInfoProviderData,
  AssetHistoryEntry as AssetHistoryEntryProviderData,
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
  TransactionCertificate as TransactionCertificateRow,
  TransactionWithdrawal as TransactionWithdrawalRow,
  NetworkInformation as NetworkInfoRow,
  TransactionMetadata as TransactionMetadataRow,
  Block as BlockRow,
  Epoch as EpochRow,
  Pool as PoolRow,
  Drep as DrepRow,
  PoolEpochSnapshot as PoolEpochSnapshotRow,
  DrepEpochSnapshot as DrepEpochSnapshotRow,
  Asset as AssetRow,
  AssetHistory as AssetHistoryRow,
  Account as AccountRow,
  LedgerProtocolParameter as ProtocolParameterRow,
  AddressTransaction as AddressTransactionRow
} from '#cds-models/CardanoODataService';

import type {
  TransactionBuild as TransactionBuildRow,
  TransactionBuildInput as TransactionBuildInputRow,
  TransactionBuildOutput as TransactionBuildOutputRow,
  TransactionSubmission as TransactionSubmissionRow,
  AddressTransactionBuild as AddressTransactionBuildRow,
} from '#cds-models/CardanoTransactionService';

import type {
  AddressSigningRequest as AddressSigningRequestRow,
} from '#cds-models/CardanoSignService';


import type { Request } from '@sap/cds';
import { BackendError } from './errors';
import { ASSET_UNIT_REGEX } from './const';

/** Key of a transaction's input/output rows: chain position, ascending, below 2^53 for any real slot. */
export const TX_SEQ_SLOT_FACTOR = 65536;
export function txSeqOf(slot: number, txIndex: number): number {
  return slot * TX_SEQ_SLOT_FACTOR + txIndex;
}

/** Provider transaction to TransactionRow. */
export function mapTransaction(providerTx: TransactionProviderData): TransactionRow {
  // length check: chain-sync delivers `[]` for metadata-less txs
  const hasMetadata = Array.isArray(providerTx.metadata) && providerTx.metadata.length > 0;
  const hasInputs = Array.isArray(providerTx.inputs) && providerTx.inputs.length > 0;
  const hasOutputs = Array.isArray(providerTx.outputs) && providerTx.outputs.length > 0;

  return {
    hash: providerTx.hash,
    txSeq: txSeqOf(providerTx.slot, providerTx.index),
    blockHash: providerTx.blockHash,
    blockHeight: providerTx.blockHeight ?? null,
    blockTime: providerTx.blockTime ?? null,
    slot: providerTx.slot ?? null,
    txIndex: providerTx.index ?? null,
    fee: providerTx.fee != null ? providerTx.fee : '0',
    deposit: providerTx.deposit != null ? providerTx.deposit : '0',
    size: providerTx.size ?? null,
    hasInputs: hasInputs,
    hasOutputs: hasOutputs,
    hasMetadata: hasMetadata,
  };
}

/** Provider transaction inputs to TransactionInputRows, keyed by position in the tx. */
export function mapTransactionInputs(txSeq: number, txInputs: TxInputProviderData[]): TransactionInputRow[] {
  return txInputs.map((input, idx: number) => {
    // Position in this tx's inputs; input.outputIndex is the spent UTxO's index, not a key here
    const inputIndex = idx;
    const hasAddress = !!input.address?.length;
    const hasAssets = Array.isArray(input.amount) && input.amount.length > 0;

    return {
      txSeq,
      inputIndex: inputIndex,
      // unresolved chain-sync inputs carry '': persist a null FK, not an empty-string association
      address_address: input.address || null,
      utxoData_dataHash: input.dataHash || null,
      utxoData_inlineDatum: input.inlineDatum || null,
      utxoData_referenceScriptHash: input.referenceScriptHash || null,
      // outpoint of the consumed UTxO
      spentTxHash: input.txHash || null,
      spentOutputIndex: Number.isInteger(input.outputIndex) ? input.outputIndex : null,
      isCollateral: Boolean(input.isCollateral),
      isReference: Boolean(input.isReference),
      hasAddresses: hasAddress,
      hasAssets: hasAssets,
    };
  });
}

/** Provider transaction input assets to TransactionInputAssetRows. */
export function mapTransactionInputAssets(
  txSeq: number,
  inputs: TxInputProviderData[]
): TransactionInputAssetRow[] {
  return inputs.flatMap((input, idx) => {
    // must match mapTransactionInputs
    const inputIndex = idx;

    if (!Array.isArray(input.amount)) return [];

    return input.amount.map(a => {
      const { policyId, assetName } = parseAssetUnit(a.unit);

      return {
        input_txSeq: txSeq,
        input_inputIndex: inputIndex,
        unit: a.unit,
        asset_quantity: a.quantity,
        asset_policyId: policyId,
        asset_assetName: assetName,
      };
    });
  });
}

/** Normalized certificates to TransactionCertificateRows, one per (certIndex, kind). */
export function mapTransactionCertificates(
  txHash: string,
  certificates: TxCertificateProviderData[]
): TransactionCertificateRow[] {
  return certificates.map((c) => ({
    tx_hash: txHash,
    certIndex: c.certIndex,
    kind: c.kind,
    stakeAddress: c.stakeAddress || null,
    poolId: c.poolId || null,
    drepId: c.drepId || null,
    deposit: c.deposit != null ? String(c.deposit) : null,
    epoch: c.epoch ?? null,
  }));
}

/** Normalized withdrawals to TransactionWithdrawalRows, one per reward account. */
export function mapTransactionWithdrawals(
  txHash: string,
  withdrawals: TxWithdrawalProviderData[]
): TransactionWithdrawalRow[] {
  return withdrawals
    .filter((w) => !!w.stakeAddress)
    .map((w) => ({
      tx_hash: txHash,
      stakeAddress: w.stakeAddress,
      lovelace: String(w.amount ?? '0'),
    }));
}

/** Provider transaction outputs to TransactionOutputRows. */
export function mapTransactionOutputs(txSeq: number, txOutputs: TxOutputProviderData[]): TransactionOutputRow[] {
  return txOutputs.map((output) => {

    const outputIndex = output.outputIndex;
    const hasAddresses = !!output.address?.length;
    const hasAssets = Array.isArray(output.amount) && output.amount.length > 0;

    return {
      txSeq,
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

/** Provider transaction output assets to TransactionOutputAssetRows. */
export function mapTransactionOutputAssets(
  txSeq: number,
  outputs: TxOutputProviderData[]
): TransactionOutputAssetRow[] {
  return outputs.flatMap((output) => {

    const outputIndex = output.outputIndex;
    if (!Array.isArray(output.amount)) return [];

    return output.amount.map(a => {
      const { policyId, assetName } = parseAssetUnit(a.unit);
      return {
        output_txSeq: txSeq,
        output_outputIndex: outputIndex,
        unit: a.unit,
        asset_quantity: a.quantity,
        asset_policyId: policyId,
        asset_assetName: assetName,
      };
    });
  });
}

/** Provider address to a temporal AddressRow valid for `maxAge` ms. */
export function mapAddress(address: string, addressData: AddressProviderData, maxAge: number): AddressRow {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const validToIso = new Date(now + maxAge).toISOString();
  const totalLovelace = Array.isArray(addressData.amount)
    ? (addressData.amount.find((a) => a.unit === 'lovelace')?.quantity ?? '0')
    : '0';

  const utxoCount = Array.isArray(addressData.utxos) ? addressData.utxos.length : 0;
  const hasUtxos = utxoCount > 0;
  const hasAssets = Array.isArray(addressData.amount) && addressData.amount.some((a) => a.unit !== 'lovelace');
  // set to true by indexAddress() once transactions are indexed
  const hasTransactions = false;

  return {
    address,
    stakeAddress: addressData.stakeAddress || null,
    type: addressData.type ?? 'base',
    isScript: addressData.isScript ?? false,
    totalLovelace: totalLovelace,
    utxoCount: utxoCount,
    validFrom: nowIso,
    validTo: validToIso,
    hasAssets: hasAssets,
    hasUTxOs: hasUtxos,
    hasTransactions: hasTransactions,
  };
}

/** Net asset change */
interface NetAsset {
  unit: string;
  policyId: string;
  assetName: string;
  assetNameHex: string;
  quantity: string;
}

/** Provider transactions to AddressTransactionRows with the address's net amounts; non-temporal. */
export function mapAddressTransactions(addr: string, addressTxsData: TransactionProviderData[]): AddressTransactionRow[] {

  return addressTxsData.map((tx: TransactionProviderData) => {
    const { netLovelace, netAssets } = calculateNetAmounts(addr, tx);

    return {
      address_address: addr,
      tx_hash: tx.hash,
      netAmount: netLovelace,
      blockTime: tx.blockTime,
      netAssets: netAssets.length > 0 ? JSON.stringify(netAssets) : null,
      hasAssets: netAssets.length > 0,
    };
  });
}

/** Net lovelace and asset changes of an address in a transaction (outputs minus inputs). */
function calculateNetAmounts(addr: string, tx: TransactionProviderData): { netLovelace: string; netAssets: NetAsset[] } {
  let inputLovelace = 0n;
  let outputLovelace = 0n;
  const assetBalances = new Map<string, bigint>(); // unit -> net quantity

  for (const input of tx.inputs ?? []) {
    if (input.address === addr) {
      for (const amount of input.amount ?? []) {
        if (amount.unit === 'lovelace') {
          inputLovelace += BigInt(amount.quantity || '0');
        } else {
          const current = assetBalances.get(amount.unit) || 0n;
          assetBalances.set(amount.unit, current - BigInt(amount.quantity || '0'));
        }
      }
    }
  }

  for (const output of tx.outputs ?? []) {
    if (output.address === addr) {
      for (const amount of output.amount ?? []) {
        if (amount.unit === 'lovelace') {
          outputLovelace += BigInt(amount.quantity || '0');
        } else {
          const current = assetBalances.get(amount.unit) || 0n;
          assetBalances.set(amount.unit, current + BigInt(amount.quantity || '0'));
        }
      }
    }
  }

  // zero balances are dropped
  const netAssets: NetAsset[] = [];
  for (const [unit, quantity] of assetBalances) {
    if (quantity !== 0n) {
      const policyId = unit.substring(0, 56);
      const assetNameHex = unit.substring(56);
      const assetName = hexToUtf8(assetNameHex);

      netAssets.push({
        unit,
        policyId,
        assetName,
        assetNameHex,
        quantity: quantity.toString()
      });
    }
  }

  return {
    netLovelace: (outputLovelace - inputLovelace).toString(),
    netAssets
  };
}



/** Provider UTxOs to temporal AddressUTxORows. */
export function mapAddressUtxos(addr: string, validFrom: string, validTo: string, addressUtxosData: UtxosProviderData[]): AddressUTxORow[] {

  return addressUtxosData.map((utxo: UtxosProviderData) => {
    const amounts = Array.isArray(utxo.amount) ? utxo.amount : [];
    const lovelace = amounts.find((a) => a.unit === 'lovelace')?.quantity ?? '0';
    const hasAssets = amounts.some((a) => a.unit !== 'lovelace');

    return {
      address_address: addr,
      hash: utxo.txHash,
      index: utxo.outputIndex,
      blockHash: utxo.blockHash,
      utxodata_dataHash: utxo.datumHash,
      utxodata_inlineDatum: utxo.inlineDatum || null,
      // Hash column: Blockfrost/Ogmios give a 56-hex hash, Koios the full script CBOR, so only
      // hash-length values are persisted
      utxodata_referenceScriptHash: utxo.scriptRef && utxo.scriptRef.length <= 64 ? utxo.scriptRef : null,
      lovelace: lovelace,
      validFrom: validFrom,
      validTo: validTo,
      hasAssets: hasAssets,
    };
  });
}

/** Provider address amounts (without lovelace) to temporal AddressAssetRows. */
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
        asset_quantity: asset.quantity,
        asset_policyId: policyId,
        asset_assetName: assetName,
      };
    });
}

/** Native assets of provider UTxOs to temporal UTxOAssetRows. */
export function mapAddressUtxoAssets(
  addressUtxosData: UtxosProviderData[],
  validFrom: string, validTo: string,
): UTxOAssetRow[] {
  const assets: UTxOAssetRow[] = [];

  addressUtxosData.forEach((utxo: UtxosProviderData) => {
    const amounts = Array.isArray(utxo.amount) ? utxo.amount : [];
    for (const asset of amounts) {
      if (!asset || !asset.unit || asset.unit === 'lovelace') continue;
      const { policyId, assetName } = parseAssetUnit(asset.unit);
      assets.push({
        utxo_address_address: utxo.address,
        utxo_hash: utxo.txHash,
        utxo_index: utxo.outputIndex,
        unit: asset.unit,
        validFrom: validFrom,
        validTo: validTo,
        asset_quantity: asset.quantity,
        asset_policyId: policyId,
        asset_assetName: assetName,
      });
    }
  });
  return assets;
}

/** Provider network information to a temporal NetworkInfoRow. */
export function mapNetworkInfo(providerNetworkData: NetworkInfoProviderData, max_age: number, network: string): NetworkInfoRow {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const validToIso = new Date(now + max_age).toISOString();

  return {
    network: network,
    validFrom: nowIso,
    validTo: validToIso,
    maxSupply: providerNetworkData.supply.max,
    circulatingSupply: providerNetworkData.supply.circulating,
    totalSupply: providerNetworkData.supply.total,
    lockedSupply: providerNetworkData.supply.locked,
    treasurySupply: providerNetworkData.supply.treasury,
    reservesSupply: providerNetworkData.supply.reserves,
    liveStake: providerNetworkData.stake.live,
    activeStake: providerNetworkData.stake.active,
  };
}

/** Provider block to BlockRow. */
export function mapBlock(providerBlockData: BlockProviderData, epochData?: EpochRow): BlockRow {
  return {
    time: new Date(providerBlockData.time * 1000).toISOString(),
    height: providerBlockData.height,
    hash: providerBlockData.hash,
    slotLeader: providerBlockData.slotLeader ?? null,
    epochNumber: epochData?.epoch ?? providerBlockData.epoch,
    epoch: epochData,
    // absolute slot: the crawler's reorg cut axis (same as Transactions.slot)
    slot: providerBlockData.slot ?? null,
    epochSlot: providerBlockData.epochSlot,
    size: providerBlockData.size,
    txCount: providerBlockData.txCount,
    fees: providerBlockData.fees ?? '0',
  };
}

/** Provider epoch to EpochRow. */
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
    fees: providerEpochData.fees,
    activeStake: providerEpochData.active_stake,
  };
}

/** Provider metadata labels to TransactionMetadataRows; non-uint64 labels are skipped. */
export function mapTransactionMetadata(providerLabels: MetadataLabelTxProviderData[]): TransactionMetadataRow[] {
  const rows: TransactionMetadataRow[] = [];

  for (const lbl of providerLabels) {
    const id = metadataIdFor(lbl.label);
    if (id === null) {
      // a NaN key would fail the whole bulk write on PostgreSQL
      logger.warn(`Metadata label ${JSON.stringify(lbl.label)} of tx ${lbl.txHash} is not a uint64 — row skipped`);
      continue;
    }
    rows.push({
      // exact int64 key (see metadataIdFor); `label` keeps the original string
      id: id as unknown as number,
      tx_hash: lbl.txHash,
      label: lbl.label.toString(),
      // Ogmios exposes numeric metadata as bigint; safeJSON writes exact number tokens
      payload: lbl.json !== undefined ? safeJSON.stringify(lbl.json) : null,
    });
  }
  return rows;
}

/**
 * uint64 metadata label to the int64 `TransactionMetadata.id` key: labels >= 2^63 wrap via two's complement,
 * values beyond 2^53 are passed as a decimal string (CAP accepts strings for Integer64).
 * @returns the key, or null when the label is not a non-negative integer
 */
export function metadataIdFor(label: string | number): number | string | null {
  let big: bigint;
  if (typeof label === 'number') {
    if (!Number.isFinite(label)) return null;
    big = BigInt(Math.trunc(label));
  } else {
    const text = String(label).trim();
    if (!/^\d+$/.test(text)) return null;
    big = BigInt(text);
  }
  const wrapped = BigInt.asIntN(64, big);
  const safe = wrapped >= BigInt(Number.MIN_SAFE_INTEGER) && wrapped <= BigInt(Number.MAX_SAFE_INTEGER);
  return safe ? Number(wrapped) : wrapped.toString();
}

/** Pool observation at an epoch boundary to a non-temporal PoolEpochSnapshotRow dated by (epoch, snapshotSlot). */
export function mapPoolSnapshot(
  providerPoolData: PoolProviderData,
  epoch: number,
  at: { slot: number; time: number },
): PoolEpochSnapshotRow {
  return {
    poolId: providerPoolData.poolId,
    epoch,
    snapshotSlot: at.slot,
    snapshotTime: at.time,
    blocksMinted: providerPoolData.blocksMinted,
    blocksEpoch: providerPoolData.blocksEpoch,
    liveStake: providerPoolData.liveStake,
    liveSize: Number(providerPoolData.liveSize),
    liveSaturation: Number(providerPoolData.liveSaturation),
    liveDelegators: providerPoolData.liveDelegators,
    activeStake: providerPoolData.activeStake,
    activeSize: Number(providerPoolData.activeSize),
    pledge: providerPoolData.pledge,
    margin: Number(providerPoolData.margin),
    fixedCost: providerPoolData.fixedCost,
  };
}

/** DRep observation at an epoch boundary to a non-temporal DrepEpochSnapshotRow. */
export function mapDrepSnapshot(
  providerDrepData: DrepProviderData,
  epoch: number,
  at: { slot: number; time: number },
): DrepEpochSnapshotRow {
  return {
    drepId: providerDrepData.drepId,
    epoch,
    snapshotSlot: at.slot,
    snapshotTime: at.time,
    amount: providerDrepData.amount,
    hasScript: providerDrepData.hasScript,
    lastActiveEpoch: providerDrepData.lastActiveEpoch,
    retired: providerDrepData.retired,
    expired: providerDrepData.expired,
  };
}

/** Provider pool to a temporal PoolRow valid for `max_age` ms. */
export function mapPool(providerPoolData: PoolProviderData, max_age: number): PoolRow {
  // one clock read, so validTo - validFrom is exactly max_age
  const now = Date.now();
  const validFrom = new Date(now).toISOString();
  const validTo = new Date(now + max_age).toISOString();
  return {
    poolId: providerPoolData.poolId,
    vrfKeyHash: providerPoolData.vrfKeyHash,
    blocksMinted: providerPoolData.blocksMinted,
    blocksEpoch: providerPoolData.blocksEpoch,
    liveStake: providerPoolData.liveStake,
    liveSize: providerPoolData.liveSize,
    liveDelegators: providerPoolData.liveDelegators,
    liveSaturation: providerPoolData.liveSaturation,
    activeStake: providerPoolData.activeStake,
    activeSize: providerPoolData.activeSize,
    pledge: providerPoolData.pledge,
    margin: Number(providerPoolData.margin),
    fixedCost: providerPoolData.fixedCost,
    rewardAccount: providerPoolData.rewardAccount,
    validFrom,
    validTo,
  };
}

/** Canonical asset info to a temporal AssetRow valid for `max_age` ms; on-chain metadata is JSON-stringified. */
export function mapAsset(providerAssetInfo: AssetInfoProviderData, max_age: number): AssetRow {
  // one clock read (see mapPool)
  const now = Date.now();
  const validFrom = new Date(now).toISOString();
  const validTo = new Date(now + max_age).toISOString();

  return {
    unit: providerAssetInfo.unit,
    policyId: providerAssetInfo.policyId,
    assetNameHex: providerAssetInfo.assetNameHex,
    assetName: providerAssetInfo.assetName,
    fingerprint: providerAssetInfo.fingerprint,
    totalSupply: providerAssetInfo.totalSupply,
    mintOrBurnCount: providerAssetInfo.mintOrBurnCount,
    initialMintTxHash: providerAssetInfo.initialMintTxHash,
    initialMintTime: providerAssetInfo.initialMintTime,
    onchainMetadata: providerAssetInfo.onchainMetadata
      ? JSON.stringify(providerAssetInfo.onchainMetadata)
      : null,
    registryName: providerAssetInfo.registryName,
    registryTicker: providerAssetInfo.registryTicker,
    registryDecimals: providerAssetInfo.registryDecimals,
    registryDescription: providerAssetInfo.registryDescription,
    registryUrl: providerAssetInfo.registryUrl,
    registryLogo: providerAssetInfo.registryLogo,
    validFrom,
    validTo,
  };
}

/**
 * Fixed validity stamp for a crawler-written bare `Assets` row: epoch zero, so the row is born expired
 * (hidden by CAP's temporal filter) and its `(validFrom, unit)` key never collides with a mapAsset() slice.
 */
export const BARE_ASSET_STAMP = '1970-01-01T00:00:00.000Z';

/**
 * Bare AssetRow from the unit alone (policyId, assetNameHex, decoded name, CIP-14 fingerprint), no provider call.
 * Stamped `validTo === validFrom` with the fixed sentinel: hidden from OData reads, so the first keyed read
 * still misses and the lazy path enriches it; one idempotent row per unit inside the crawler's block tx.
 * @returns the row, or null when the unit is not a native asset unit
 */
export function mapBareAsset(unit: string): AssetRow | null {
  // same unit definition isAssetUnit() enforces on the API
  if (!ASSET_UNIT_REGEX.test(unit)) return null;

  const policyId = unit.slice(0, 56);
  const assetNameHex = unit.slice(56);

  return {
    unit,
    policyId,
    assetNameHex,
    // hex fallback for non-text and NUL-bearing names
    assetName: assetNameHex.length > 0 ? decodeAssetName(assetNameHex) : '',
    fingerprint: computeCip14Fingerprint(policyId, assetNameHex),
    totalSupply: null,
    mintOrBurnCount: null,
    initialMintTxHash: null,
    initialMintTime: null,
    onchainMetadata: null,
    registryName: null,
    registryTicker: null,
    registryDecimals: null,
    registryDescription: null,
    registryUrl: null,
    registryLogo: null,
    validFrom: BARE_ASSET_STAMP,
    validTo: BARE_ASSET_STAMP,
  };
}

/** Asset history events to non-temporal AssetHistoryRows (immutable, keyed on unit + txHash). */
export function mapAssetHistory(entries: AssetHistoryEntryProviderData[]): AssetHistoryRow[] {
  return entries.map((e) => ({
    unit: e.unit,
    txHash: e.txHash,
    action: e.action,
    quantity: e.quantity,
    blockTime: e.blockTime,
    blockHeight: e.blockHeight,
  }));
}

/** Provider DRep to a temporal DrepRow valid for `max_age` ms. */
export function mapDrep(providerDrepData: DrepProviderData, max_age: number): DrepRow {
  // one clock read (see mapPool)
  const now = Date.now();
  const validFrom = new Date(now).toISOString();
  const validTo = new Date(now + max_age).toISOString();
  return {
    drepId: providerDrepData.drepId,
    hex: providerDrepData.hex,
    amount: providerDrepData.amount,
    hasScript: Boolean(providerDrepData.hasScript),
    lastActiveEpoch: providerDrepData.lastActiveEpoch,
    retired: Boolean(providerDrepData.retired),
    expired: Boolean(providerDrepData.expired),
    validFrom,
    validTo,
  };
}

/** Provider account to a temporal AccountRow valid for `max_age` ms. */
export function mapAccount(providerAccountData: AccountProviderData, max_age: number): AccountRow {
  // one clock read (see mapPool)
  const now = Date.now();
  const validFrom = new Date(now).toISOString();
  const validTo = new Date(now + max_age).toISOString();

  return {
    validFrom: validFrom,
    validTo: validTo,
    stakeAddress: providerAccountData.stakeaddress,
    active: providerAccountData.active,
    activeEpoch: providerAccountData.activeEpoch,
    controlledAmount: providerAccountData.controlledAmount,
    rewardsSum: providerAccountData.rewardsSum,
    withdrawalsSum: providerAccountData.withdrawalsSum,
    reservesSum: providerAccountData.reservesSum,
    treasurySum: providerAccountData.treasurySum,
    withdrawableAmount: providerAccountData.withdrawableAmount,
    poolId_poolId: providerAccountData.poolId ?? null,
    drepId_drepId: providerAccountData.drepId ?? null,
    hasAddresses: providerAccountData.addresses.length > 0,
  };
}

/** Rejects the OData request for a BackendError; unknown errors are logged and answered as a sanitized 500. */
export function mapError(req: Request, err: unknown, ctx: string) {
    if (err instanceof BackendError) {
      return req.reject(
        err.statusCode,
        fmt(err.code, ctx, err.message),
        err.target
      );
    }
    const internalMsg = err instanceof Error ? err.message : String(err);
    logger.error({ error: internalMsg }, `Unexpected error in ${ctx}`);
    return req.reject(500, fmt('INTERNAL_ERROR', ctx, 'An internal error occurred'));
}

/** Build result to a temporal TransactionBuildRow with a fresh build id. */
export function mapBuildResult(txbuildResult: TransactionBuildResult, max_age: number): TransactionBuildRow {
  const buildId = cds.utils.uuid();
  // one clock read (see mapPool)
  const nowMs = Date.now();
  const now = Math.floor(nowMs / 1000);
  const validFrom = new Date(nowMs).toISOString();
  const validTo = new Date(nowMs + max_age).toISOString();
  const hasInputs = Array.isArray(txbuildResult.inputs) && txbuildResult.inputs.length > 0;
  const hasOutputs = Array.isArray(txbuildResult.outputs) && txbuildResult.outputs.length > 0;

  return {
    id: buildId,
    validFrom: validFrom,
    validTo: validTo,
    builderEngine: txbuildResult.builderEngine,
    network: txbuildResult.network,
    senderAddress: txbuildResult.senderAddress,
    changeAddress: txbuildResult.changeOutput?.address ?? txbuildResult.senderAddress,
    unsignedTxCbor: txbuildResult.unsignedTxCbor,
    txBodyHash: txbuildResult.txBodyHash,
    fee: txbuildResult.feeLovelace,
    size: txbuildResult.sizeBytes, // bytes
    createdAt: now, // epoch seconds
    submission: null,
    hasInputs: hasInputs,
    hasOutputs: hasOutputs,
    wasSubmitted: false,
    scriptHash: txbuildResult.scriptHash ?? null,
    mintScriptHash: txbuildResult.mintScriptHash ?? null,
    forcedInputsUsed: txbuildResult.forcedInputsUsed ?? 0,
    referenceInputsUsed: txbuildResult.referenceInputsUsed ?? 0,
  }
}

/** Build result inputs to TransactionBuildInputRows. */
export function mapBuildInputs(buildId: string, inputs: Array<{ txHash: string; index: number; lovelace: string; address?: string }>): TransactionBuildInputRow[] {
  return inputs.map((input, idx) => ({
    build_id: buildId,
    inputIndex: idx,
    txHash: input.txHash,
    outputIndex: input.index,
    address: input.address || null,
    lovelace: input.lovelace,
    hasAssets: false, // simple ADA transfers don't have assets
  }));
}

/** Build result outputs to TransactionBuildOutputRows; `changeAddress` marks the change output. */
export function mapBuildOutputs(buildId: string, outputs: Array<{ address: string; lovelace: string }>, changeAddress?: string): TransactionBuildOutputRow[] {
  return outputs.map((output, idx) => ({
    build_id: buildId,
    outputIndex: idx,
    address: output.address,
    lovelace: output.lovelace,
    isChange: changeAddress ? output.address === changeAddress : false,
    hasAssets: false, // simple ADA transfers don't have assets
  }));
}

/** Provider protocol parameters to ProtocolParameterRow. */
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

/** Signed tx CBOR and hash to a TransactionSubmissionRow stamped now (epoch seconds). */
export function mapTransactionSubmission(signedTxCbor: string, txHash: string): TransactionSubmissionRow {
  const now = Math.floor(Date.now() / 1000);
  return {
    signedTxCbor: signedTxCbor,
    txHash: txHash,
    submittedAt: now,
  };
}

/** Address to signing-request association row. */
export function mapAddressSigningRequest(addr: string, signingRequestId: string): AddressSigningRequestRow {
  return {
    address_address: addr,
    signingRequest_id: signingRequestId,
  };
}

/** Address to transaction-build association row. */
export function mapAddressTransactionBuild(addr: string, buildId: string): AddressTransactionBuildRow {
  return {
    address_address: addr,
    txBuild_id: buildId,
  };
}

//-----------------------------------------------------------------------
// Helper Functions
//-----------------------------------------------------------------------

/**
 * Cost models to number arrays in canonical Plutus parameter order. V3 goes through toCostModelArrV3
 * (canonical keys, padded to 297); for V1/V2 alphabetical key order is the canonical order.
 */
export function normalizeCostModels(raw: Record<string, unknown>): Record<string, number[]> {
  const result: Record<string, number[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    const isV3 = key === 'PlutusV3' || key === 'plutus:v3';
    if (Array.isArray(value)) {
      if (isV3) {
        // already canonical; toCostModelArrV3 pads short arrays to 297 with defaults
        result[key] = Array.from(toCostModelArrV3(value as AnyV3CostModel)).map(Number);
      } else {
        result[key] = value;
      }
    } else if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (isV3) {
        result[key] = Array.from(toCostModelArrV3(obj as unknown as AnyV3CostModel)).map(Number);
      } else {
        result[key] = Object.keys(obj as Record<string, number>).sort()
            .map(k => (obj as Record<string, number>)[k]);
      }
    }
  }
  return result;
}

/** Hex to UTF-8 display string, hex fallback (see decodeAssetName). */
function hexToUtf8(hex: string): string {
  return decodeAssetName(hex);
}

// ignoreBOM: a leading U+FEFF is part of the asset name's bytes and must survive the round trip
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Asset name (hex bytes) to its display string; the hex is returned unchanged for invalid UTF-8 or
 * names containing U+0000 (PostgreSQL rejects NUL in `text`). `assetNameHex` always keeps the exact bytes.
 */
export function decodeAssetName(hex: string): string {
  if (!hex) return hex;
  let text: string;
  try {
    text = strictUtf8.decode(Buffer.from(hex, 'hex'));
  } catch {
    return hex;
  }
  return text.includes('\u0000') ? hex : text;
}

/** Split an asset unit into policyId and decoded assetName; `lovelace` and malformed units get a null policyId. */
function parseAssetUnit(unit: string): { policyId: string | null; assetName: string | null } {
  if (unit === 'lovelace') {
    return { policyId: null, assetName: 'lovelace' };
  }
  if (unit.length < 56 || !/^[a-f0-9]+$/i.test(unit)) {
    return { policyId: null, assetName: unit };
  }

  const policyId = unit.slice(0, 56);
  const assetNameHex = unit.slice(56);
  const assetName = assetNameHex.length > 0 ? hexToUtf8(assetNameHex) : '';

  return { policyId, assetName };
}

/** CIP-14 fingerprint: bech32("asset", blake2b_160(policyId_bytes + assetName_bytes)). */
export function computeCip14Fingerprint(policyIdHex: string, assetNameHex: string): string {
  const input = Buffer.from(policyIdHex + assetNameHex, 'hex');
  const out = Buffer.alloc(20);
  blake2b(20).update(input).digest(out);
  const words = bech32.toWords(out);
  return bech32.encode('asset', words);
}

/** Enterprise script address: header 0x71 (mainnet) / 0x70 (testnet) + 28-byte script hash, bech32. */
export function scriptHashToEnterpriseAddress(
  scriptHashHex: string,
  network: 'mainnet' | 'preprod' | 'preview'
): string {
  const headerByte = network === 'mainnet' ? 0x71 : 0x70;
  const payload = Buffer.alloc(29);
  payload[0] = headerByte;
  Buffer.from(scriptHashHex, 'hex').copy(payload, 1);
  const words = bech32.toWords(payload);
  const hrp = network === 'mainnet' ? 'addr' : 'addr_test';
  return bech32.encode(hrp, words, 120);
}

/** Stake credential to bech32 reward account; header nibbles 0xe key / 0xf script, network 1 mainnet / 0 testnets. */
export function credentialToStakeAddress(
  credentialHex: string,
  isScript: boolean,
  network: 'mainnet' | 'preprod' | 'preview'
): string {
  const header = (isScript ? 0xf0 : 0xe0) | (network === 'mainnet' ? 0x01 : 0x00);
  const payload = Buffer.alloc(29);
  payload[0] = header;
  Buffer.from(credentialHex, 'hex').copy(payload, 1);
  const hrp = network === 'mainnet' ? 'stake' : 'stake_test';
  return bech32.encode(hrp, bech32.toWords(payload), 120);
}

export interface DecodedAddress {
  type: 'base' | 'pointer' | 'enterprise' | 'reward' | 'byron' | 'unknown';
  /** Payment credential is a script hash. */
  isScript: boolean;
  /** Reward account (bech32) of a base address; null for every other type. */
  stakeAddress: string | null;
  /** Network nibble of the header (1 = mainnet, 0 = testnets); null when not a Shelley address. */
  networkId: number | null;
}

/**
 * Decode the CIP-19 Shelley address header: type, script flag and, for base addresses, the embedded
 * stake credential as a reward account. Byron (base58) and unparseable input yield `byron` / `unknown`.
 */
export function decodeShelleyAddress(address: string): DecodedAddress {
  const none: DecodedAddress = { type: 'unknown', isScript: false, stakeAddress: null, networkId: null };
  if (typeof address !== 'string' || !address.length) return none;
  let bytes: Buffer;
  try {
    const decoded = bech32.decode(address, 120);
    if (decoded.prefix !== 'addr' && decoded.prefix !== 'addr_test' && decoded.prefix !== 'stake' && decoded.prefix !== 'stake_test') return none;
    bytes = Buffer.from(bech32.fromWords(decoded.words));
  } catch {
    // Byron addresses are base58 and start with Ae2 / DdzFF (mainnet) or 2cWKM… (testnets)
    return /^(Ae2|DdzFF|2cWKM|37btj|KjgoiX)/.test(address) ? { ...none, type: 'byron' } : none;
  }
  if (!bytes.length) return none;
  const header = bytes[0];
  const type = header >> 4;
  const networkId = header & 0x0f;
  const net = networkId === 1 ? 'mainnet' : 'preview';
  switch (type) {
    case 0: case 1: case 2: case 3: {
      const stakeAddress = bytes.length >= 57
        ? credentialToStakeAddress(bytes.subarray(29, 57).toString('hex'), type >= 2, net)
        : null;
      return { type: 'base', isScript: type === 1 || type === 3, stakeAddress, networkId };
    }
    case 4: case 5:
      return { type: 'pointer', isScript: type === 5, stakeAddress: null, networkId };
    case 6: case 7:
      return { type: 'enterprise', isScript: type === 7, stakeAddress: null, networkId };
    case 14: case 15:
      return { type: 'reward', isScript: type === 15, stakeAddress: address, networkId };
    default:
      return { ...none, networkId };
  }
}

/** DRep credential to CIP-129 DRep ID (29 bytes): header 0x22 key hash / 0x23 script hash. */
export function credentialToDrepId(credentialHex: string, isScript: boolean): string {
  const payload = Buffer.alloc(29);
  payload[0] = isScript ? 0x23 : 0x22;
  Buffer.from(credentialHex, 'hex').copy(payload, 1);
  return bech32.encode('drep', bech32.toWords(payload), 120);
}

/** `[code] ctx: msg` */
function fmt(code: string, ctx: string, msg: string): string {
  return `[${code}] ${ctx}: ${msg}`;
}
