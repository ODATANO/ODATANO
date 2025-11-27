'use strict';

const MAX_AGE_MINUTES = process.env.ADDR_MAX_AGE_MIN || 1;
const MAX_AGE_MS = MAX_AGE_MINUTES * 60 * 1000;

// -----------------------------------------------------------------------------
// Transactions
// -----------------------------------------------------------------------------
function mapTransaction(providerTx) {
  if (!providerTx) return null;
  return {
    hash: providerTx.hash,
    blockHash: providerTx.block,
    blockHeight: providerTx.block_height ?? null,
    blockTime: providerTx.block_time
      ? new Date(providerTx.block_time * 1000)
      : null,
    slot: providerTx.slot ?? null,
    txIndex: providerTx.index ?? null,
    fee: providerTx.fees ?? '0',
    deposit: providerTx.deposit ?? '0',
    size: providerTx.size ?? null,
    utxoCount: providerTx.utxo_count ?? null,
    withdrawalCount: providerTx.withdrawal_count ?? null,
    mirCertCount: providerTx.mir_cert_count ?? null,
    delegationCount: providerTx.delegation_count ?? null,
    stakeCertCount: providerTx.stake_cert_count ?? null,
    poolUpdateCount: providerTx.pool_update_count ?? null,
    poolRetireCount: providerTx.pool_retire_count ?? null,
    assetMintOrBurnCount: providerTx.asset_mint_or_burn_count ?? null,
    redeemerCount: providerTx.redeemer_count ?? null,
    validContract: providerTx.valid_contract ?? null,
  };
}

// -----------------------------------------------------------------------------
// Transaction Inputs
// -----------------------------------------------------------------------------
// txUtxos: Blockfrost `txsUtxos` Response
// → odatano.cardano.TransactionInputs (mit UTxOSlice flach als utxo_*)
function mapTransactionInputs(txHash, txUtxos) {
  const inputs = txUtxos?.inputs;
  if (!Array.isArray(inputs)) return [];

  return inputs.map((input, idx) => {
    const lovelaceEntry = Array.isArray(input.amount)
      ? input.amount.find(a => a.unit === 'lovelace')
      : null;

    const valueLovelace = lovelaceEntry?.quantity ?? '0';
    const inputIndex = input.output_index ?? idx;

    return {
      txHash,
      inputIndex,                       
      sourceTxHash: input.tx_hash,
      sourceOutputIndex: input.output_index,
      utxo_address_bech32: input.address,
      utxo_valueLovelace: valueLovelace,
      utxo_datumHash: input.data_hash || null,
      utxo_inlineDatum: input.inline_datum || null,
      utxo_referenceScript: input.reference_script_hash || null,
      utxo_isScript: Boolean(
        input.inline_datum ||
        input.data_hash ||
        input.reference_script_hash
      ),

      isCollateral: Boolean(input.collateral),
      isReference: Boolean(input.reference),
    };
  });
}

// txUtxos → odatano.cardano.TransactionInputAssets
function mapTransactionInputAssets(txHash, txUtxos) {
  const inputs = txUtxos?.inputs;
  if (!Array.isArray(inputs)) return [];

  return inputs.flatMap((input, idx) => {
    if (!Array.isArray(input.amount) || input.amount.length === 0) return [];

    const inputIndex = input.output_index ?? idx;

    return input.amount.map(a => {
      const unit = a.unit;
      const quantity = a.quantity;

      let policyId = null;
      let assetName = null;

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
        // AssetSlice flach
        asset_quantity: quantity,
        asset_policyId: policyId,
        asset_assetName: assetName,
      };
    });
  });
}

// -----------------------------------------------------------------------------
// Transaction Outputs
// -----------------------------------------------------------------------------
function mapTransactionOutputs(txHash, txUtxos) {
  const outputs = txUtxos?.outputs;
  if (!Array.isArray(outputs)) return [];

  return outputs.map((output, idx) => {
    const lovelaceEntry = Array.isArray(output.amount)
      ? output.amount.find(a => a.unit === 'lovelace')
      : null;

    const valueLovelace = lovelaceEntry?.quantity ?? '0';
    const outputIndex = output.output_index ?? idx;

    return {
      txHash,
      outputIndex,
      utxo_address_bech32: output.address,
      utxo_valueLovelace: valueLovelace,
      utxo_datumHash: output.data_hash || null,
      utxo_inlineDatum: output.inline_datum || null,
      utxo_referenceScript: output.reference_script_hash || null,
      utxo_isScript: Boolean(
        output.inline_datum ||
        output.data_hash ||
        output.reference_script_hash
      ),
      consumedByTxHash: output.consumed_by_tx || null,
    };
  });
}

function mapTransactionOutputAssets(txHash, txUtxos) {
  const outputs = txUtxos?.outputs;
  if (!Array.isArray(outputs)) return [];

  return outputs.flatMap((output, idx) => {
    if (!Array.isArray(output.amount) || output.amount.length === 0) return [];

    const outputIndex = output.output_index ?? idx;

    return output.amount.map(a => {
      const unit = a.unit;
      const quantity = a.quantity;

      let policyId = null;
      let assetName = null;

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
        outputIndex,
        unit,
        asset_quantity: quantity,
        asset_policyId: policyId,
        asset_assetName: assetName,
      };
    });
  });
}

// -----------------------------------------------------------------------------
// UTxOs (Current Set) – optional, aber praktisch
// -----------------------------------------------------------------------------
// txUtxos → odatano.cardano.UTxOs
function mapUTxOsFromOutputs(txHash, txUtxos) {
  const outputs = txUtxos?.outputs;
  if (!Array.isArray(outputs)) return [];

  return outputs.map((output, idx) => {
    const lovelaceEntry = Array.isArray(output.amount)
      ? output.amount.find(a => a.unit === 'lovelace')
      : null;

    const valueLovelace = lovelaceEntry?.quantity ?? '0';
    const outputIndex = output.output_index ?? idx;

    const spent = Boolean(output.consumed_by_tx);

    return {
      txHash,
      outputIndex,
      utxo_address_bech32: output.address,
      utxo_valueLovelace: valueLovelace,
      utxo_datumHash: output.data_hash || null,
      utxo_inlineDatum: output.inline_datum || null,
      utxo_referenceScript: output.reference_script_hash || null,
      utxo_isScript: Boolean(
        output.inline_datum ||
        output.data_hash ||
        output.reference_script_hash
      ),
      spent,
    };
  });
}

// -----------------------------------------------------------------------------
// Addresses
// -----------------------------------------------------------------------------
function mapAddress(address, provider = {}) {
  const data = provider.data;
  const validTo = new Date(new Date().getTime() + MAX_AGE_MS);
  const now = new Date();
  // total address lovelance
  const totalLovelace =
    Array.isArray(data.amount)
      ? data.amount.find(a => a.unit === 'lovelace')?.quantity || '0'
      : '0';

  return {
    address: address,
    stakeAddress: data.stakeAddress || null,
    type: data.type ?? 'unknown',
    isScript:  data.script === true || data.type === 'script',
    totalLovelace: totalLovelace,
    validFrom: now,
    validTo: validTo,
  };
}

function mapAddressUtxos(addr, validTo, provider = {}) {
  const data = provider.data;
  const now = new Date();
  if (!Array.isArray(data)) return [];
  return data
    .map(a => {
      return {
        address_address: addr,
        hash:  a.tx_hash,
        index: a.output_index,
        blockHash: a.block,
        utxodata_dataHash: a.data_hash,
        utxodata_inlineDatum: a.inline_datum,
        utxodata_referenceScriptHash: a.reference_script_hash,
        validFrom: now,
        validTo: validTo,
      };
    });
}

function mapAddressAssets(addr, validTo, provider = {}) {
  const amounts = provider.data?.amount;
  const now = new Date();
  if (!Array.isArray(amounts)) return [];

  return amounts
    .filter(a => a.unit !== 'lovelace')
    .map(a => {
      const assetNameHex = a.unit.slice(56);

      let assetName;
      try {
        assetName = Buffer.from(assetNameHex, 'hex').toString('utf8');
      } catch {
        assetName = assetNameHex;
      }

      return {
        address_address: addr,
        unit: a.unit,
        validFrom: now,
        validTo: validTo,
        asset_quantity:  a.quantity,
        asset_policyId:  a.unit.slice(0, 56),
        asset_assetName: assetName
      };
    });
}

// -----------------------------------------------------------------------------
// Error Mapping
// -----------------------------------------------------------------------------
function mapProviderError(err) {
  return {
    status: err.status || err.code || 500,
    message: err.message || String(err),
  };
}

function mapError(req, err, ctx) {
  const mapped = mapProviderError(err);
  const status = mapped.status || 500;
  const message = mapped.message || `${ctx} operation failed`;
  return req.error(status, `${ctx}: ${message}`);
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------
module.exports = {
  mapTransaction,
  mapTransactionInputs,
  mapTransactionInputAssets,
  mapTransactionOutputs,
  mapTransactionOutputAssets,
  mapUTxOsFromOutputs,
  mapAddress,
  mapAddressAssets,
  mapAddressUtxos,
  mapError,
};
