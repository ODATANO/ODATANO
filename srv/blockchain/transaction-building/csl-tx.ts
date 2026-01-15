import * as CSL from "@emurgo/cardano-serialization-lib-nodejs";
import blake2b from "blake2b";
import type { CardanoTxBuilder } from "./cardano-tx";
import type { TxBuildRequest, TxBuildContext, TxBuildResult, UTxO as OdatanoUtxo } from "../../utils/types";
import logger from "../../utils/logger";
import { assertAdaOnly, getLovelace } from "../../utils/tx-build-helper";
import { LedgerProtocolParameter } from "#cds-models/CardanoODataService";

/**
 * CSLTxBuilder - Implementation of CardanoTxBuilder using cardano-serialization-lib (CSL)
 */
export class CSLTxBuilder implements CardanoTxBuilder {
  public readonly name = "csl";

  public async init(): Promise<void> { }

  /**
   * Build unsigned ADA transfer transaction (CSL)
   */
  public async buildUnsignedAdaTransfer(req: TxBuildRequest, ctx: TxBuildContext): Promise<TxBuildResult> {
    // prepare addresses
    const recipientAddress = CSL.Address.from_bech32(req.recipientAddress);
    const changeAddress = CSL.Address.from_bech32(req.changeAddress ?? req.senderAddress);

    // map ODATANO UTxOs -> CSL TransactionUnspentOutputs
    const cslUtxos = this._mapOdatanoUtxosToCslUtxos(ctx.utxos);

    const protocolParams = ctx.protocolParameters;

    // create Transaction Builder from protocol parameters
    const txb = this._newTxBuilderFromProtocolParams(protocolParams);

    // add recipient & output (lovelace)
    const amount = CSL.BigNum.from_str(String(req.lovelaceAmount));
    const outValue = CSL.Value.new(amount);
    const out = CSL.TransactionOutput.new(recipientAddress, outValue);
    txb.add_output(out);

    // add inputs via coin selection + add change
    txb.add_inputs_from(cslUtxos, CSL.CoinSelectionStrategyCIP2.LargestFirstMultiAsset);
    txb.add_change_if_needed(changeAddress);

    // build unsigned tx
    const unsignedTx = txb.build_tx();
    
    // Export the complete transaction (with empty witness set) for cardano-cli
    const unsignedTxCbor = Buffer.from(unsignedTx.to_bytes()).toString("hex");

    // hash + fee + outputs
    const body = unsignedTx.body();
    const bodyBytes = body.to_bytes();
    const hash = blake2b(32).update(bodyBytes).digest('hex');
    const txBodyHash = hash;
    const feeLovelace = body.fee().to_str();

    const outputs: Array<{ address: string; lovelace: string }> = [];
    const txOuts = body.outputs();
    for (let i = 0; i < txOuts.len(); i++) {
      const o = txOuts.get(i);
      outputs.push({
        address: o.address().to_bech32(),
        lovelace: o.amount().coin().to_str(),
      });
    }

    logger.info(`[CSLTxBuilder] Built unsigned transaction successfully.`);

    return {
      unsignedTxCbor,
      txBodyHash,
      senderAddress: req.senderAddress,
      network: req.network,
      builderEngine: this.name,
      feeLovelace,
      inputs: ctx.utxos.map(u => ({
        txHash: u.txHash,
        index: u.outputIndex,
        lovelace: getLovelace(u).toString(),
      })),
      outputs,
      warnings: [],
    };
  }

  // ---------------------------------------------------------------------------
  // Private Helper Methods
  // ---------------------------------------------------------------------------

  /**
   * Map ODATANO UTxOs to CSL TransactionUnspentOutputs (ADA-only for now).
   * This mirrors your Buildooor mapping logic in spirit.
   */
  private _mapOdatanoUtxosToCslUtxos(utxos: OdatanoUtxo[]): CSL.TransactionUnspentOutputs {
    const outs = CSL.TransactionUnspentOutputs.new();

    for (const u of utxos) {
      assertAdaOnly(u);

      const txHashBytes = Buffer.from(u.txHash, "hex");
      const txHash = CSL.TransactionHash.from_bytes(txHashBytes);
      const input = CSL.TransactionInput.new(txHash, u.outputIndex);

      const addr = CSL.Address.from_bech32(u.address);
      const value = CSL.Value.new(CSL.BigNum.from_str(getLovelace(u).toString()));
      const output = CSL.TransactionOutput.new(addr, value);

      outs.add(CSL.TransactionUnspentOutput.new(input, output));
    }

    return outs;
  }

  /**
   * Create a CSL TransactionBuilder from protocol parameters.
   *
   * @param protocolParams LedgerProtocolParameter
   * @returns CSL.TransactionBuilder
   */

  private _newTxBuilderFromProtocolParams(protocolParams: LedgerProtocolParameter): CSL.TransactionBuilder {
    
    // required values for CSL config
    const minFeeA = protocolParams.minFeeA;
    const minFeeB = protocolParams.minFeeB;
    const poolDeposit = protocolParams.poolDeposit;
    const keyDeposit = protocolParams.keyDeposit;
    const maxTxSize = protocolParams.maxTxSize;
    const maxValueSize = protocolParams.maxValSize;
    const coinsPerUtxoByte = protocolParams.coinsPerUtxoSize;

    const feeAlgo = CSL.LinearFee.new(
      CSL.BigNum.from_str(String(minFeeA)),
      CSL.BigNum.from_str(String(minFeeB)),
    );

    const cfg = CSL.TransactionBuilderConfigBuilder.new()
      .fee_algo(feeAlgo)
      .pool_deposit(CSL.BigNum.from_str(String(poolDeposit)))
      .key_deposit(CSL.BigNum.from_str(String(keyDeposit)))
      .max_tx_size(Number(maxTxSize))
      .max_value_size(Number(maxValueSize))
      .coins_per_utxo_byte(CSL.BigNum.from_str(String(coinsPerUtxoByte)))
      .build();

    return CSL.TransactionBuilder.new(cfg);
  }

}
