// Backend data for another ODATANO instance that uses this one with `backends: ["odatano"]`.
// Every operation returns the provider shape as a JSON string, mapped like a Koios answer.
@requires: 'Read'
service CardanoBackendService @(impl: './cardano-backend-service') {

    // --- blocks and transactions -------------------------------------------------------------
    @odatano.agent: 'read'
    action GetTransaction(hash: String)                                         returns LargeString;
    @odatano.agent: 'read'
    action GetTransactionsBatch(hashes: LargeString)                            returns LargeString;
    @odatano.agent: 'read'
    action GetTransactionMetadata(hash: String)                                 returns LargeString;
    @odatano.agent: 'read'
    action GetBlock(hash: String)                                               returns LargeString;
    @odatano.agent: 'read'
    action GetBlockByHeight(@assert.range: [0, _] height: Integer64)            returns LargeString;
    @odatano.agent: 'read'
    action GetNextBlocks(afterHash: String, @assert.range: [1, 500] count: Integer,
                         @assert.range: [0, _] afterHeight: Integer64)          returns LargeString;
    @odatano.agent: 'read'
    action GetBlockTransactions(blockHash: String)                              returns LargeString;
    @odatano.agent: 'read'
    action GetLatestBlock()                                                     returns LargeString;
    @odatano.agent: 'read'
    action GetCurrentSlot()                                                     returns LargeString;
    @odatano.agent: 'read'
    action GetEpoch(@assert.range: [0, _] epoch: Integer)                       returns LargeString;
    @odatano.agent: 'read'
    action GetLatestEpoch()                                                     returns LargeString;

    // --- addresses and UTxOs ------------------------------------------------------------------
    @odatano.agent: 'read'
    action GetAddress(address: String)                                          returns LargeString;
    @odatano.agent: 'read'
    action GetAddressUtxos(address: String)                                     returns LargeString;
    @odatano.agent: 'read'
    action GetAddressTransactions(address: String, @assert.range: [1, 100] limit: Integer) returns LargeString;
    @odatano.agent: 'read'
    action GetAddressTransactionHashes(address: String, @assert.range: [1, 100] limit: Integer) returns LargeString;
    @odatano.agent: 'read'
    action GetCredentialUtxos(credential: String)                               returns LargeString;
    @odatano.agent: 'read'
    action IsUtxoUnspent(txHash: String, @assert.range: [0, _] outputIndex: Integer) returns LargeString;
    @odatano.agent: 'read'
    action GetUnspentOutputs(refs: LargeString)                                 returns LargeString;

    // --- stake, governance, assets, network ------------------------------------------------
    @odatano.agent: 'read'
    action GetAccount(stakeAddress: String)                                     returns LargeString;
    @odatano.agent: 'read'
    action GetPool(poolId: String)                                              returns LargeString;
    @odatano.agent: 'read'
    action GetPoolIds()                                                         returns LargeString;
    @odatano.agent: 'read'
    action GetPools(ids: LargeString)                                           returns LargeString;
    @odatano.agent: 'read'
    action GetDrep(drepId: String)                                              returns LargeString;
    @odatano.agent: 'read'
    action GetDrepIds()                                                         returns LargeString;
    @odatano.agent: 'read'
    action GetDreps(ids: LargeString)                                           returns LargeString;
    @odatano.agent: 'read'
    action GetAssetInfo(unit: String)                                           returns LargeString;
    @odatano.agent: 'read'
    action GetAssetHistory(unit: String, @assert.range: [1, 100] limit: Integer) returns LargeString;
    @odatano.agent: 'read'
    action GetNetworkInformation()                                              returns LargeString;
    @odatano.agent: 'read'
    action GetProtocolParameters()                                              returns LargeString;

    // --- transactions in flight ------------------------------------------------------------
    @requires     : 'Transact'
    @odatano.agent: 'read'
    action EvaluateTransaction(cbor: LargeString)                               returns LargeString;
    @requires     : 'Transact'
    @odatano.agent: 'grant'
    action SubmitTransaction(cbor: LargeString)                                 returns LargeString;
}
