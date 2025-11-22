'use strict';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------
const MAX_AGE_MS = 1000 * 60 * 60 * 24; // 24h Gültigkeit für Address-Snapshots

// -----------------------------------------------------------------------------
// Transactions
// -----------------------------------------------------------------------------
// Blockfrost / Koios TX → odatano.cardano.Transactions
function mapTransaction(providerTx) {
  if (!providerTx) return null;

  const now = new Date();

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
      inputIndex,                        // key

      sourceTxHash: input.tx_hash,
      sourceOutputIndex: input.output_index,

      // UTxOSlice (flach: utxo_*)
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
// txUtxos → odatano.cardano.TransactionOutputs
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

      // UTxOSlice flach
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

// txUtxos → odatano.cardano.TransactionOutputAssets
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
// bech32 + Blockfrost address response → odatano.cardano.Addresses
function mapAddress(bech32, provider = {}) {
  const data = provider.data || provider; // flexibler

  const now = new Date();
  const validTo = new Date(now.getTime() + MAX_AGE_MS);

  const stakeAddress = data.stake_address || null;
  const type = data.type ?? 'unknown';
  const isScript = data.script === true || data.type === 'script';

  const totalLovelace =
    Array.isArray(data.amount)
      ? data.amount.find(a => a.unit === 'lovelace')?.quantity || '0'
      : '0';

  return {
    bech32,
    stakeAddress,
    type,
    isScript,
    totalLovelace,
    validFrom: now,
    validTo,
  };
}

// bech32 + Blockfrost address response → odatano.cardano.AddressAssets
function mapAddressAssets(bech32, validFrom, validTo, provider = {}) {
  const data = provider.data || provider;
  const amounts = data?.amount;
  if (!Array.isArray(amounts)) return [];

  return amounts
    .filter(a => a.unit !== 'lovelace')
    .map(a => {
      const unit = a.unit;
      const quantity = a.quantity;
      const policyId = unit.slice(0, 56);
      const assetNameHex = unit.slice(56);

      let assetName;
      try {
        assetName = Buffer.from(assetNameHex, 'hex').toString('utf8');
      } catch {
        assetName = assetNameHex;
      }

      return {
        // Association key → FK-Spalte
        bech32_bech32: bech32,
        unit,
        validFrom,
        validTo,
        asset_quantity: quantity,
        asset_policyId: policyId,
        asset_assetName: assetName,
      };
    });
}

// -----------------------------------------------------------------------------
// Error Mapping
// -----------------------------------------------------------------------------
function mapProviderError(err) {
  // Minimaler Default – kannst du mit deiner bestehenden Logik ersetzen
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
  mapError,
};
