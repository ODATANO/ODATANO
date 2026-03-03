import blake2b from 'blake2b';
import { bech32 } from 'bech32';
import { toCostModelArrV3 } from '@harmoniclabs/cardano-costmodels-ts';
import {
  Transaction as TransactionProviderData,
  Address as AddressProviderData,
  UTxO as UtxosProviderData,
  TxInputLine as TxInputProviderData,
  TxOutputLine as TxOutputProviderData,
  Amount as AmountProviderData,
  NetworkInformation as NetworkInfoProviderData,
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
import cds from '@sap/cds';

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

  const hasUtxos = Array.isArray(addressData.utxos) && addressData.utxos.length > 0;
  const hasAssets = Array.isArray(addressData.amount) && addressData.amount.length > 0;
  // Transactions are loaded separately via getAddressTransactions() - set to false initially
  // Will be updated when transactions are indexed
  const hasTransactions = false;

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
export function mapAddressTransactions(addr: string, addressTxsData: TransactionProviderData[],validFrom: string, validTo: string): AddressTransactionRow[] {

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
      validFrom: validFrom,
      validTo: validTo,
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
  for (const input of tx.inputs) {
    if (input.address === addr) {
      for (const amount of input.amount) {
        if (amount.unit === 'lovelace') {
          inputLovelace += BigInt(amount.quantity || '0');
        } else {
          // Native asset
          const current = assetBalances.get(amount.unit) || 0n;
          assetBalances.set(amount.unit, current - BigInt(amount.quantity));
        }
      }
    }
  }

  // Process outputs going to this address (add)
  for (const output of tx.outputs) {
    if (output.address === addr) {
      for (const amount of output.amount) {
        if (amount.unit === 'lovelace') {
          outputLovelace += BigInt(amount.quantity || '0');
        } else {
          // Native asset
          const current = assetBalances.get(amount.unit) || 0n;
          assetBalances.set(amount.unit, current + BigInt(amount.quantity));
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
    const lovelace = utxo.amount.find((a) => a.unit === 'lovelace')?.quantity ?? '0';
    const hasAssets = Array.isArray(utxo.amount) && utxo.amount.some((a) => a.unit !== 'lovelace');

    return {
      address_address: addr,
      hash: utxo.txHash,
      index: utxo.outputIndex,
      blockHash: utxo.blockHash,
      utxodata_dataHash: utxo.datumHash,
      utxodata_inlineDatum: null,
      utxodata_referenceScriptHash: utxo.scriptRef,
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
    rows.push({
      id: Number(lbl.label),
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
    drepId: providerDrepData.drepId,
    hex: providerDrepData.hex,
    amount: providerDrepData.amount,
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
export function mapAccount(providerAccountData: AccountProviderData, max_age: number): AccountRow {
  const validFrom = new Date().toISOString();
  const validTo = new Date(Date.now() + max_age).toISOString();

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
    const message = err instanceof Error ? err.message : String(err);
    return req.reject(500, fmt('INTERNAL_ERROR', ctx, message));
}

/** 
 * Map Transaction Build Result
 * Converts provider transaction build result into TransactionBuildRow format
 * @param txbuildResult transaction build result from provider
 * @returns {TransactionBuildRow} mapped transaction build row
 */
export function mapBuildResult(txbuildResult: TransactionBuildResult, max_age: number): TransactionBuildRow {
  const buildId = cds.utils.uuid();
  const now = Math.floor(Date.now() / 1000);
  const validFrom = new Date().toISOString();
  const validTo = new Date(Date.now() + max_age).toISOString();
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
    fee: txbuildResult.feeLovelace,
    size: txbuildResult.sizeBytes, // size in bytes
    createdAt: now, // epoch seconds
    submission: null,
    hasInputs: hasInputs, // indicates if build has inputs
    hasOutputs: hasOutputs, // indicates if build has outputs
    wasSubmitted: false, // indicates if this build was submitted
    scriptHash: txbuildResult.scriptHash ?? null,
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
        result[key] = Array.from(toCostModelArrV3(value as any)).map(Number);
      } else {
        // V1/V2: pass through (already in canonical order)
        result[key] = value;
      }
    } else if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (isV3) {
        result[key] = Array.from(toCostModelArrV3(obj as any)).map(Number);
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
 * Format error message
 * @param code error code
 * @param ctx context string
 * @param msg error message
 * @returns {string} formatted error message
 */
function fmt(code: string, ctx: string, msg: string): string {
  return `[${code}] ${ctx}: ${msg}`;
}