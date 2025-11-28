// srv/utils/mappers.ts

const MAX_AGE_MINUTES = Number(process.env.ADDR_MAX_AGE_MIN ?? 1);
const MAX_AGE_MS = MAX_AGE_MINUTES * 60 * 1000;

// -----------------------------------------------------------------------------
// Transactions
// -----------------------------------------------------------------------------

export function mapTransaction(providerTx: any) {

  const blockTimeIso = providerTx.block_time
    ? new Date(providerTx.block_time * 1000).toISOString()
    : null;

  return {
    hash: providerTx.hash,
    blockHash: providerTx.block,
    blockHeight: providerTx.block_height ?? null,
    blockTime: blockTimeIso, // string | null
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
// → TransactionInputs (mit UTxOSlice flach als utxo_*)
export function mapTransactionInputs(txHash: string, txUtxos: any) {
  const inputs = txUtxos?.inputs;
  if (!Array.isArray(inputs)) return [];

  return inputs.map((input: any, idx: number) => {
    const lovelaceEntry = Array.isArray(input.amount)
      ? input.amount.find((a: any) => a.unit === 'lovelace')
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

// txUtxos → TransactionInputAssets
export function mapTransactionInputAssets(txHash: string, txUtxos: any) {
  const inputs = txUtxos?.inputs;
  if (!Array.isArray(inputs)) return [];

  return inputs.flatMap((input: any, idx: number) => {
    if (!Array.isArray(input.amount) || input.amount.length === 0) return [];

    const inputIndex = input.output_index ?? idx;

    return input.amount.map((a: any) => {
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

export function mapTransactionOutputs(txHash: string, txUtxos: any) {
  const outputs = txUtxos?.outputs;
  if (!Array.isArray(outputs)) return [];

  return outputs.map((output: any, idx: number) => {
    const lovelaceEntry = Array.isArray(output.amount)
      ? output.amount.find((a: any) => a.unit === 'lovelace')
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

export function mapTransactionOutputAssets(txHash: string, txUtxos: any) {
  const outputs = txUtxos?.outputs;
  if (!Array.isArray(outputs)) return [];

  return outputs.flatMap((output: any, idx: number) => {
    if (!Array.isArray(output.amount) || output.amount.length === 0) return [];

    const outputIndex = output.output_index ?? idx;

    return output.amount.map((a: any) => {
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
// UTxOs aus Outputs
// -----------------------------------------------------------------------------

export function mapUTxOsFromOutputs(txHash: string, txUtxos: any) {
  const outputs = txUtxos?.outputs;
  if (!Array.isArray(outputs)) return [];

  return outputs.map((output: any, idx: number) => {
    const lovelaceEntry = Array.isArray(output.amount)
      ? output.amount.find((a: any) => a.unit === 'lovelace')
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

export function mapAddress(address: string, data: any) {
  console.log('data', data);

  const nowIso = new Date().toISOString();
  const validToIso = new Date(Date.now() + MAX_AGE_MS).toISOString();

  const totalLovelace =
    Array.isArray(data.amount)
      ? data.amount.find((a: any) => a.unit === 'lovelace')?.quantity || '0'
      : '0';

  return {
    address,
    stakeAddress: data.stakeAddress || null,
    type: data.type ?? 'unknown',
    isScript: data.script === true || data.type === 'script',
    totalLovelace,
    validFrom: nowIso,   
    validTo: validToIso,
  };
}

export function mapAddressUtxos(addr: string, validTo: string, provider: any = {}) {
  const data = provider.data;
  const nowIso = new Date().toISOString();

  if (!Array.isArray(data)) return [];

  return data.map((a: any) => ({
    address_address: addr,
    hash: a.tx_hash,
    index: a.output_index,
    blockHash: a.block,
    utxodata_dataHash: a.data_hash,
    utxodata_inlineDatum: a.inline_datum,
    utxodata_referenceScriptHash: a.reference_script_hash,
    validFrom: nowIso,
    validTo,
  }));
}

export function mapAddressAssets(addr: string, validTo: string, provider: any = {}) {
  const amounts = provider.data?.amount;
  const nowIso = new Date().toISOString();

  if (!Array.isArray(amounts)) return [];

  return amounts
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
