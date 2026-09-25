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

/** 
 * Maximum age for cached/indexed data in milliseconds 
 */

/** 
 * Map Transaction Data
 * Converts provider transaction data into TransactionRow format
 * @param providerTx 
 * @returns {TransactionRow} mapped transaction row 
 */
export function mapTransaction(providerTx: TransactionProviderData): TransactionRow {
  // determine presence of optional data
  // length check matters: the Ogmios chain-sync mapper produced `[]` for metadata-less
  // txs, which the old `Array.isArray` test counted as "has metadata"
  const hasMetadata = Array.isArray(providerTx.metadata) && providerTx.metadata.length > 0;
  const hasInputs = Array.isArray(providerTx.inputs) && providerTx.inputs.length > 0;
  const hasOutputs = Array.isArray(providerTx.outputs) && providerTx.outputs.length > 0;

  return {
    hash: providerTx.hash,
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

/** 
 * Map Transaction Inputs
 * Converts provider transaction input data into TransactionInputRow format
 * @param txHash transaction hash
 * @param txInputs transaction inputs from provider
 * @returns {TransactionInputRow[]} mapped transaction input rows
 */
export function mapTransactionInputs(txHash: string, txInputs: TxInputProviderData[]): TransactionInputRow[] {
  return txInputs.map((input, idx: number) => {
    // Use array index as the input index (position in this transaction's inputs)
    // Note: input.outputIndex is the output index from the ORIGINAL UTxO being spent, not for keying here
    const inputIndex = idx;
    // check presence of address and amount arrays
    const hasAddress = !!input.address?.length;
    const hasAssets = Array.isArray(input.amount) && input.amount.length > 0;

    return {
      tx_hash: txHash,
      inputIndex: inputIndex,
      // `|| null`: unresolved chain-sync inputs carry '' — persist a null FK, not a
      // dangling empty-string Addresses association (lazy-path inputs are never empty)
      address_address: input.address || null,
      utxoData_dataHash: input.dataHash || null,
      utxoData_inlineDatum: input.inlineDatum || null,
      utxoData_referenceScriptHash: input.referenceScriptHash || null,
      // Outpoint of the consumed UTxO — every source carries it in memory (the chain-sync
      // path needs it for resolveInputs), the row just never kept it before.
      spentTxHash: input.txHash || null,
      spentOutputIndex: Number.isInteger(input.outputIndex) ? input.outputIndex : null,
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
  return inputs.flatMap((input, idx) => {
    // Use array index as the input index (must match mapTransactionInputs)
    const inputIndex = idx;

    if (!Array.isArray(input.amount)) return [];

    return input.amount.map(a => {
      const { policyId, assetName } = parseAssetUnit(a.unit);

      return {
        input_tx_hash: txHash,
        input_inputIndex: inputIndex,
        unit: a.unit,
        asset_quantity: a.quantity,
        asset_policyId: policyId,
        asset_assetName: assetName,
      };
    });
  });
}

/**
 * Map Transaction Certificates (crawler coverage, `crawler.certificates`).
 * @param txHash transaction hash
 * @param certificates normalized certificates from the source
 * @returns {TransactionCertificateRow[]} one row per (certIndex, kind)
 */
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

/**
 * Map Transaction Withdrawals (crawler coverage, `crawler.certificates`).
 * @param txHash transaction hash
 * @param withdrawals normalized withdrawals from the source
 * @returns {TransactionWithdrawalRow[]} one row per reward account
 */
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

/** 
 * Map Transaction Outputs
 * Converts provider transaction output data into TransactionOutputRow format
 * @param txHash transaction hash
 * @param txOutputs transaction outputs from provider
 * @returns {TransactionOutputRow[]} mapped transaction output rows
 */
export function mapTransactionOutputs(txHash: string, txOutputs: TxOutputProviderData[]): TransactionOutputRow[] {
  return txOutputs.map((output) => {

    const outputIndex = output.outputIndex;
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
  return outputs.flatMap((output) => {

    const outputIndex = output.outputIndex;
    if (!Array.isArray(output.amount)) return [];

    return output.amount.map(a => {
      const { policyId, assetName } = parseAssetUnit(a.unit);
      return {
        output_tx_hash: txHash,
        output_outputIndex: outputIndex,
        unit: a.unit,
        asset_quantity: a.quantity,
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
  // Transactions are indexed separately in indexAddress() — updated to true after indexing
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

/**
 * Net asset change structure
 */
interface NetAsset {
  unit: string;
  policyId: string;
  assetName: string;
  assetNameHex: string;
  quantity: string;
}

/**
 * Map Address Transactions
 * Converts provider address transaction data into AddressTransactionRow format
 * @param addr address string
 * @param addressTxsData address transactions data from provider
 * @returns {AddressTransactionRow[]} mapped address transaction rows
 *  */
// AddressTransactions is keyed by (address, tx) and the per-tx net amounts are
// immutable once confirmed — no temporal validity. The entity has no
// validFrom/validTo columns, so the previous TTL plumbing was silently dropped.
export function mapAddressTransactions(addr: string, addressTxsData: TransactionProviderData[]): AddressTransactionRow[] {

  return addressTxsData.map((tx: TransactionProviderData) => {
    // Calculate net amounts for this address in this transaction
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

/**
 * Calculate net lovelace and asset changes for an address in a transaction
 * @param addr the address to calculate for
 * @param tx the transaction data
 * @returns object with netLovelace and netAssets array
 */
function calculateNetAmounts(addr: string, tx: TransactionProviderData): { netLovelace: string; netAssets: NetAsset[] } {
  let inputLovelace = 0n;
  let outputLovelace = 0n;
  const assetBalances = new Map<string, bigint>(); // unit -> net quantity

  // Process inputs belonging to this address (subtract)
  for (const input of tx.inputs ?? []) {
    if (input.address === addr) {
      for (const amount of input.amount ?? []) {
        if (amount.unit === 'lovelace') {
          inputLovelace += BigInt(amount.quantity || '0');
        } else {
          // Native asset
          const current = assetBalances.get(amount.unit) || 0n;
          assetBalances.set(amount.unit, current - BigInt(amount.quantity || '0'));
        }
      }
    }
  }

  // Process outputs going to this address (add)
  for (const output of tx.outputs ?? []) {
    if (output.address === addr) {
      for (const amount of output.amount ?? []) {
        if (amount.unit === 'lovelace') {
          outputLovelace += BigInt(amount.quantity || '0');
        } else {
          // Native asset
          const current = assetBalances.get(amount.unit) || 0n;
          assetBalances.set(amount.unit, current + BigInt(amount.quantity || '0'));
        }
      }
    }
  }

  // Convert asset map to array, filtering out zero balances
  const netAssets: NetAsset[] = [];
  for (const [unit, quantity] of assetBalances) {
    if (quantity !== 0n) {
      // Parse unit into policyId and assetName
      // Format: policyId (56 chars) + assetNameHex
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



/** 
 * Map Address UTxOs
 * @param addr address string
 * @param validFrom validFrom
 * @param validTo validTo
 * @param addressUtxosData address UTxOs data from provider 
 * @returns {AddressUTxORow[]} mapped address UTxO rows
 */
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
      // This column is a script HASH (Blake2b256). UTxO.scriptRef is overloaded:
      // Blockfrost/Ogmios give a 56-hex hash (stored as-is); Koios gives the full
      // script CBOR (used by the tx-builder, but it would truncate this hash
      // column) — only persist hash-length values here.
      utxodata_referenceScriptHash: utxo.scriptRef && utxo.scriptRef.length <= 64 ? utxo.scriptRef : null,
      lovelace: lovelace,
      validFrom: validFrom,
      validTo: validTo,
      hasAssets: hasAssets,
    };
  });
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
        asset_quantity: asset.quantity,
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

/** 
 * Map Network Information
 * Converts provider network information data into NetworkInfoRow format
 * @param providerNetworkData 
 * @returns {NetworkInfoRow} mapped network information row
 */
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

/** 
 * Map Block Data
 * Converts provider block data into BlockRow format
 * @param providerBlockData block data from provider
 * @param epochData epoch data for the block's epoch
 * @returns {BlockRow} mapped block row
 */
export function mapBlock(providerBlockData: BlockProviderData, epochData?: EpochRow): BlockRow {
  return {
    time: new Date(providerBlockData.time * 1000).toISOString(),
    height: providerBlockData.height,
    hash: providerBlockData.hash,
    // was `String(x ?? null)` → persisted the literal string "null" when absent
    slotLeader: providerBlockData.slotLeader ?? null,
    epochNumber: epochData?.epoch ?? providerBlockData.epoch,
    epoch: epochData,
    // absolute slot — the crawler's reorg cut axis (same axis as Transactions.slot)
    slot: providerBlockData.slot ?? null,
    epochSlot: providerBlockData.epochSlot,
    size: providerBlockData.size,
    txCount: providerBlockData.txCount,
    fees: providerBlockData.fees ?? '0',
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
    fees: providerEpochData.fees,
    activeStake: providerEpochData.active_stake,
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

  for (const lbl of providerLabels) {
    const id = metadataIdFor(lbl.label);
    if (id === null) {
      // A NaN key would fail the whole bulk write (PostgreSQL: "invalid input syntax
      // for type bigint") and, in the crawler, count towards the poison-block latch.
      logger.warn(`Metadata label ${JSON.stringify(lbl.label)} of tx ${lbl.txHash} is not a uint64 — row skipped`);
      continue;
    }
    rows.push({
      // uint64 label → int64 key, exact (see metadataIdFor); `label` keeps the original string
      id: id as unknown as number,
      tx_hash: lbl.txHash,
      label: lbl.label.toString(),
      // Ogmios' parser deliberately exposes numeric metadata as native bigint.
      // Its matching serializer writes those values as exact JSON number tokens;
      // native JSON.stringify would throw, while Number coercion would truncate.
      payload: lbl.json !== undefined ? safeJSON.stringify(lbl.json) : null,
    });
  }
  return rows;
}

/**
 * Metadata labels are uint64, the `TransactionMetadata.id` key is Integer64 (int64).
 * Labels >= 2^63 are mapped through two's complement (BigInt.asIntN) so they stay
 * unique and in range – preprod tx ee4f7c88… carries label 17802948329108123211,
 * which PostgreSQL rejected as "out of range for type bigint" and halted the
 * crawler. Beyond 2^53 the value is passed as a decimal string so that no
 * precision is lost on the way to the database (CAP accepts strings for
 * Integer64); `label` always keeps the original text.
 *
 * @returns the int64 key, or null when the label is not a non-negative integer
 *   (the caller skips the row — a NaN key would fail the whole bulk write)
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

/**
 * Map a pool observation at an epoch boundary into a snapshot row. Unlike mapPool() this
 * carries no temporal validity: the row is dated by (epoch, snapshotSlot) and stays valid
 * forever, because it states what was true then, not what is cached now.
 * @param providerPoolData pool data from provider
 * @param epoch epoch the snapshot belongs to
 * @param at slot and block time of the block that triggered the snapshot
 * @returns {PoolEpochSnapshotRow} mapped snapshot row
 */
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

/**
 * Map a DRep observation at an epoch boundary into a snapshot row. Non-temporal, same
 * reasoning as mapPoolSnapshot().
 * @param providerDrepData drep data from provider
 * @param epoch epoch the snapshot belongs to
 * @param at slot and block time of the block that triggered the snapshot
 * @returns {DrepEpochSnapshotRow} mapped snapshot row
 */
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

/**
 * Map Pool Data
 * Converts provider pool data into PoolRow format
 * @param providerPoolData pool data from provider
 * @returns {PoolRow} mapped pool row
 */
export function mapPool(providerPoolData: PoolProviderData, max_age: number): PoolRow {
  // temporal stamping: live fields (liveStake/liveSaturation/retired…) change every
  // epoch, so a slice expires after max_age and the index-on-miss read re-fetches.
  // Read the clock ONCE — separate Date.now() calls for validFrom/validTo let the
  // millisecond tick over between them, making the span max_age+1.
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

/**
 * Map Asset Info Data
 * Converts provider asset info into AssetRow format. Provider data is already
 * normalized by the backend mapper into the canonical AssetInfo shape, so this
 * function just stamps temporal validity and JSON-stringifies the on-chain metadata.
 * @param providerAssetInfo canonical asset info from backend
 * @param max_age TTL window in ms for the temporal validity
 * @returns {AssetRow} mapped asset row
 */
export function mapAsset(providerAssetInfo: AssetInfoProviderData, max_age: number): AssetRow {
  // Read the clock once so validTo - validFrom is exactly max_age (see mapPool).
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
 * Fixed validity stamp for a crawler-written bare `Assets` row. Epoch zero, so the row is
 * born expired (hidden by CAP's temporal filter) and its `(validFrom, unit)` key can never
 * collide with a real, wall-clock-stamped slice from mapAsset().
 */
export const BARE_ASSET_STAMP = '1970-01-01T00:00:00.000Z';

/**
 * Map a bare asset row from an asset unit alone — everything derivable without a provider
 * call: policyId, assetNameHex, the decoded name and the CIP-14 fingerprint. Used by the
 * crawler to keep the `Assets` catalogue complete for units it meets in a block, at zero
 * network cost (analytics coverage).
 *
 * The row is stamped as ALREADY EXPIRED (`validTo === validFrom`). That is deliberate: CAP's
 * temporal filter hides it from OData reads, so the first keyed read still counts as a miss
 * and the existing lazy path enriches it through indexAsset() with supply and registry data —
 * while an analytics consumer reading the database directly already sees the full catalogue
 * (and can exclude the placeholders with `validTo > validFrom`).
 *
 * Both stamps are the FIXED epoch sentinel, not `now`. `Assets` is temporal, so its primary
 * key is `(validFrom, unit)`: a wall-clock stamp would make the same unit a new row on every
 * sighting and could collide with a slice the lazy path writes in the same millisecond, which
 * inside the crawler's block transaction means a failed block. With the sentinel the bare row
 * is one fixed, idempotent row per unit that no `mapAsset()` slice can ever alias.
 *
 * @param unit asset unit (policyId + assetNameHex)
 * @returns {AssetRow | null} bare row, or null when the unit is not a native asset unit
 */
export function mapBareAsset(unit: string): AssetRow | null {
  // The canonical definition of a unit — 56 hex policy + 0..32 bytes of name, even length.
  // Reusing it keeps the catalogue from inventing a second, looser notion of "asset unit"
  // than isAssetUnit() enforces on the API surface.
  if (!ASSET_UNIT_REGEX.test(unit)) return null;

  const policyId = unit.slice(0, 56);
  const assetNameHex = unit.slice(56);

  return {
    unit,
    policyId,
    assetNameHex,
    // decodeAssetName falls back to the hex string for non-text and NUL-bearing names
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

/**
 * Map Asset History entries to row format. No temporal stamping — mint/burn
 * events are immutable; UPSERT keyed on (unit, txHash) is idempotent.
 * @param entries asset history events from backend (already canonical)
 * @returns {AssetHistoryRow[]} mapped rows
 */
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

/**
 * Map Drep Data
 * Converts provider drep data into DrepRow format
 * @param providerDrepData drep data from provider
 * @returns {DrepRow} mapped drep row
 */
export function mapDrep(providerDrepData: DrepProviderData, max_age: number): DrepRow {
  // temporal stamping: amount/retired/expired drift over time → slice expires
  // after max_age so the index-on-miss read re-fetches fresh state.
  // Read the clock once so the span is exactly max_age (see mapPool).
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

/** 
 * Map Account Data
 * Converts provider account data into AccountRow format
 * @param providerAccountData account data from provider
 * @returns {AccountRow} mapped account row
 */
export function mapAccount(providerAccountData: AccountProviderData, max_age: number): AccountRow {
  // Read the clock once so validTo - validFrom is exactly max_age (see mapPool).
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
    hasAddresses: providerAccountData.addresses.length > 0,
  };
}

/**
 * Map Backend Error
 * Converts BackendError or unknown error into OData request rejection
 * @param req OData request
 * @param err error object (BackendError or unknown)
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
    // Handle non-BackendError (plain Error, string, etc.)
    // Log full error server-side, but return sanitized message to client
    const internalMsg = err instanceof Error ? err.message : String(err);
    logger.error({ error: internalMsg }, `Unexpected error in ${ctx}`);
    return req.reject(500, fmt('INTERNAL_ERROR', ctx, 'An internal error occurred'));
}

/** 
 * Map Transaction Build Result
 * Converts provider transaction build result into TransactionBuildRow format
 * @param txbuildResult transaction build result from provider
 * @returns {TransactionBuildRow} mapped transaction build row
 */
export function mapBuildResult(txbuildResult: TransactionBuildResult, max_age: number): TransactionBuildRow {
  const buildId = cds.utils.uuid();
  // Read the clock once so validTo - validFrom is exactly max_age (see mapPool).
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
    size: txbuildResult.sizeBytes, // size in bytes
    createdAt: now, // epoch seconds
    submission: null,
    hasInputs: hasInputs, // indicates if build has inputs
    hasOutputs: hasOutputs, // indicates if build has outputs
    wasSubmitted: false, // indicates if this build was submitted
    scriptHash: txbuildResult.scriptHash ?? null,
    mintScriptHash: txbuildResult.mintScriptHash ?? null,
    forcedInputsUsed: txbuildResult.forcedInputsUsed ?? 0,
    referenceInputsUsed: txbuildResult.referenceInputsUsed ?? 0,
  }
}

/** 
 * Map Transaction Build Inputs
 * Converts transaction build result inputs into TransactionBuildInputRow format
 * @param buildId the transaction build ID
 * @param inputs transaction build result inputs
 * @returns {TransactionBuildInputRow[]} mapped transaction build input rows
 */
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

/** 
 * Map Transaction Build Outputs
 * Converts transaction build result outputs into TransactionBuildOutputRow format
 * @param buildId the transaction build ID
 * @param outputs transaction build result outputs
 * @param changeAddress the change address to identify change outputs
 * @returns {TransactionBuildOutputRow[]} mapped transaction build output rows
 */
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
  return {
    signedTxCbor: signedTxCbor,
    txHash: txHash,
    submittedAt: now,
  };
}

/**
 * Map Address Signing Requests
 * Creates AddressSigningRequest row for address-signing request association
 * @param addr bech32 address
 * @param signingRequestId signing request UUID
 * @returns {AddressSigningRequestRow} mapped address signing request row
 */
export function mapAddressSigningRequest(addr: string, signingRequestId: string): AddressSigningRequestRow {
  return {
    address_address: addr,
    signingRequest_id: signingRequestId,
  };
}

/**
 * Map Address Transaction Builds
 * Creates AddressTransactionBuild row for address-build association
 * @param addr bech32 address
 * @param buildId transaction build UUID
 * @returns {AddressTransactionBuildRow} mapped address transaction build row
 */
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
 * Normalize cost models to array format in canonical Plutus parameter order.
 *
 * Blockfrost's cost_models (named keys) has known key-value mapping bugs for
 * PlutusV3 (shifted values in the quotientInteger/remainderInteger region).
 * The Blockfrost backend now prefers cost_models_raw (canonical arrays from the
 * node) which bypasses this issue entirely.
 *
 * For V3 arrays: already in canonical order, just pad to 297 via toCostModelArrV3.
 * For V3 objects (Ogmios named format): toCostModelArrV3(obj) maps via canonical keys.
 * For V1/V2: alphabetical order IS the canonical order (no reordering needed).
 *
 * @param raw - Raw cost models from any backend (Blockfrost, Ogmios, Koios)
 * @returns Object with all cost model values as number arrays in canonical order
 */
export function normalizeCostModels(raw: Record<string, unknown>): Record<string, number[]> {
  const result: Record<string, number[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    const isV3 = key === 'PlutusV3' || key === 'plutus:v3';
    if (Array.isArray(value)) {
      if (isV3) {
        // V3 arrays (from cost_models_raw or Ogmios) are already in canonical Plutus V3 order.
        // toCostModelArrV3 pads to 297 (Chang 2) with defaults if the array is shorter.
        result[key] = Array.from(toCostModelArrV3(value as AnyV3CostModel)).map(Number);
      } else {
        // V1/V2: pass through (already in canonical order)
        result[key] = value;
      }
    } else if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (isV3) {
        result[key] = Array.from(toCostModelArrV3(obj as unknown as AnyV3CostModel)).map(Number);
      } else {
        // V1/V2: alphabetical sort IS correct for those versions
        result[key] = Object.keys(obj as Record<string, number>).sort()
            .map(k => (obj as Record<string, number>)[k]);
      }
    }
  }
  return result;
}

/**
 * Convert hex string to UTF-8 string, falling back to hex if conversion fails.
 * This helper reduces code duplication and improves performance by centralizing
 * the conversion logic.
 * 
 * @param hex - Hexadecimal string to convert
 * @returns {string} UTF-8 string or original hex if conversion fails
 */
function hexToUtf8(hex: string): string {
  return decodeAssetName(hex);
}

// ignoreBOM: a leading U+FEFF is part of the asset name's bytes and must survive the
// round trip (Buffer.toString('utf8') kept it; TextDecoder's default drops it).
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Decode an asset name (hex bytes) into its display string.
 *
 * Asset names are arbitrary bytes. When they are not valid UTF-8, or when they
 * contain U+0000, the hex form is returned unchanged: PostgreSQL rejects NUL in
 * `text` and in the JSON documents @cap-js/postgres uses for bulk INSERT/UPSERT
 * ("unsupported Unicode escape sequence"), which halted the crawler on preprod
 * block 4281919 (asset name ending in 0x00). SQLite accepted the same bytes
 * silently. `assetNameHex` always keeps the exact bytes, so nothing is lost.
 *
 * @param hex - asset name as hex string
 * @returns UTF-8 text, or the hex string when the bytes are not clean text
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
  if (unit.length < 56 || !/^[a-f0-9]+$/i.test(unit)) {
    return { policyId: null, assetName: unit };
  }

  const policyId = unit.slice(0, 56);
  const assetNameHex = unit.slice(56);
  const assetName = assetNameHex.length > 0 ? hexToUtf8(assetNameHex) : '';

  return { policyId, assetName };
}

/**
 * Compute CIP-14 asset fingerprint from policyId and assetName.
 * Algorithm: bech32_encode("asset", blake2b_160(policyId_bytes + assetName_bytes))
 * @param policyIdHex - Policy ID as hex string (56 chars / 28 bytes)
 * @param assetNameHex - Asset name as hex string (variable length)
 * @returns CIP-14 fingerprint string (e.g. "asset1...")
 */
export function computeCip14Fingerprint(policyIdHex: string, assetNameHex: string): string {
  const input = Buffer.from(policyIdHex + assetNameHex, 'hex');
  const out = Buffer.alloc(20);
  blake2b(20).update(input).digest(out);
  const words = bech32.toWords(out);
  return bech32.encode('asset', words);
}

/**
 * Derive an enterprise script address from a script hash and network.
 * Enterprise address = header_byte + 28-byte script hash, bech32-encoded.
 * Header: 0x71 (mainnet, type 7 network 1) or 0x70 (testnet, type 7 network 0).
 */
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

/**
 * Encode a stake credential as a bech32 reward account (stake address).
 * Header: type nibble 0xe (key) / 0xf (script), network nibble 1 (mainnet) / 0 (testnets).
 */
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
 * Decode the Shelley address header (CIP-19) without a provider: type, script flag and,
 * for base addresses, the embedded stake credential re-encoded as a reward account.
 * Byron (base58) and anything unparseable come back as `byron` / `unknown` with no stake.
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

/**
 * Encode a DRep credential as a CIP-129 DRep ID (`drep1…`, 29 bytes).
 * Header byte: high nibble 0x2 = DRep, low nibble 0x2 = key hash / 0x3 = script hash —
 * the inverse of `decodeDrepId` in the Ogmios backend.
 */
export function credentialToDrepId(credentialHex: string, isScript: boolean): string {
  const payload = Buffer.alloc(29);
  payload[0] = isScript ? 0x23 : 0x22;
  Buffer.from(credentialHex, 'hex').copy(payload, 1);
  return bech32.encode('drep', bech32.toWords(payload), 120);
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
