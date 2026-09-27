/**
 * Cardano Backend Service
 *
 * The data a CardanoBackend needs, for another ODATANO instance that uses this one as its
 * backend (`backends: ["odatano"]`). Every operation answers the provider shape as a JSON
 * string (`value`), so the caller maps it exactly like a Koios or Blockfrost answer.
 * Stored blocks and transactions come from this instance's index; everything else goes
 * through its own backends and crawled data, as the read service does. Nothing is persisted
 * for the caller.
 */
@requires: 'authenticated-user'
service CardanoBackendService @(impl: './cardano-backend-service') {

    // --- blocks and transactions -------------------------------------------------------------
    action GetTransaction(hash: String)                                         returns LargeString;
    action GetTransactionsBatch(hashes: LargeString)                            returns LargeString;
    action GetTransactionMetadata(hash: String)                                 returns LargeString;
    action GetBlock(hash: String)                                               returns LargeString;
    action GetBlockByHeight(height: Integer64)                                  returns LargeString;
    action GetNextBlocks(afterHash: String, count: Integer, afterHeight: Integer64) returns LargeString;
    action GetBlockTransactions(blockHash: String)                              returns LargeString;
    action GetLatestBlock()                                                     returns LargeString;
    action GetCurrentSlot()                                                     returns LargeString;
    action GetEpoch(epoch: Integer)                                             returns LargeString;
    action GetLatestEpoch()                                                     returns LargeString;

    // --- addresses and UTxOs ------------------------------------------------------------------
    action GetAddress(address: String)                                          returns LargeString;
    action GetAddressUtxos(address: String)                                     returns LargeString;
    action GetAddressTransactions(address: String, limit: Integer)              returns LargeString;
    action GetAddressTransactionHashes(address: String, limit: Integer)         returns LargeString;
    action GetCredentialUtxos(credential: String)                               returns LargeString;
    action IsUtxoUnspent(txHash: String, outputIndex: Integer)                  returns LargeString;
    action GetUnspentOutputs(refs: LargeString)                                 returns LargeString;

    // --- stake, governance, assets, network ------------------------------------------------
    action GetAccount(stakeAddress: String)                                     returns LargeString;
    action GetPool(poolId: String)                                              returns LargeString;
    action GetPoolIds()                                                         returns LargeString;
    action GetPools(ids: LargeString)                                           returns LargeString;
    action GetDrep(drepId: String)                                              returns LargeString;
    action GetDrepIds()                                                         returns LargeString;
    action GetDreps(ids: LargeString)                                           returns LargeString;
    action GetAssetInfo(unit: String)                                           returns LargeString;
    action GetAssetHistory(unit: String, limit: Integer)                        returns LargeString;
    action GetNetworkInformation()                                              returns LargeString;
    action GetProtocolParameters()                                              returns LargeString;

    // --- transactions in flight ------------------------------------------------------------
    action EvaluateTransaction(cbor: LargeString)                               returns LargeString;
    action SubmitTransaction(cbor: LargeString)                                 returns LargeString;
}
