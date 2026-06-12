using {odatano.cardano as db} from '../db/schema';
using { Blake2b256, Bech32, AssetUnit, ParsedTransaction } from '../db/types';

/**
 * Cardano OData Service
 *
 * Handles external read-only queries for Cardano blockchain data, including:
 * - Retrieving network information, blocks, epochs, pools, dreps, transactions, accounts, addresses, UTxOs, assets, and metadata
 * - Providing actions for fetching specific data by identifiers (hashes, addresses, etc.) and for retrieving the latest blockchain state (latest block, epoch, protocol parameters)
 *
 * ## Security: Authentication & Authorization
 *
 * All services use `@requires: 'authenticated-user'` (service-level gate).
 * The XSUAA scopes defined in xs-security.json (Read, Transact, Sign) are available
 * for consumer-level role assignment but are NOT enforced per-action in ODATANO itself.
 *
 * This is intentional — ODATANO is a blockchain bridge, not a multi-tenant application.
 * Per-resource ownership checks (IDOR prevention) are deliberately omitted because:
 *
 * 1. **Blockchain security model**: Unsigned transaction CBOR is not exploitable without
 *    the corresponding private key. Viewing a build/signing request does not enable
 *    fund theft — only the key holder can sign and submit.
 *
 * 2. **Cross-address operations are legitimate**: Smart contract interactions routinely
 *    require building transactions for addresses the caller does not own — e.g. script
 *    redemptions, multi-party Plutus workflows, or DApp backends building on behalf of users.
 *    Enforcing sender == authenticated user would break these use cases.
 *
 * 3. **Consumer responsibility**: Consumers deploying ODATANO in multi-user environments
 *    should add their own authorization layer (e.g. `@restrict` annotations, custom
 *    middleware) that maps JWT claims to allowed wallet addresses if needed.
 */
@requires: 'authenticated-user'
service CardanoODataService @(impl: './cardano-service') {

    // ---------------------------------------------------------------------------
    // Entity Projections
    // ---------------------------------------------------------------------------

    @readonly
    @title      : 'Network Information'
    @description: 'Projection for Network Information'
    entity NetworkInformation       as projection on db.NetworkInformation;

    @readonly
    @title      : 'Blocks'
    @description: 'Projection for Blocks'
    entity Blocks                   as projection on db.Blocks;

    @readonly
    @title      : 'Epochs'
    @description: 'Projection for Epochs'
    entity Epochs                   as projection on db.Epochs;

    @readonly
    @title      : 'Pools'
    @description: 'Projection for Pools'
    entity Pools                    as projection on db.Pools;

    @readonly
    @title      : 'Dreps'
    @description: 'Projection for Dreps'
    entity Dreps                    as projection on db.Dreps;

    @readonly
    @title      : 'Assets'
    @description: 'Projection for Native-Asset Information'
    entity Assets                   as projection on db.Assets;

    @readonly
    @title      : 'Asset History'
    @description: 'Projection for Native-Asset Mint/Burn History'
    entity AssetHistory             as projection on db.AssetHistory;

    @readonly
    @title      : 'Transactions'
    @description: 'Projection for Transactions'
    entity Transactions             as projection on db.Transactions;

    @readonly
    @title      : 'Transaction Inputs'
    @description: 'Projection for Transaction Inputs'
    entity TransactionInputs        as projection on db.TransactionInputs;

    @readonly
    @title      : 'Transaction Outputs'
    @description: 'Projection for Transaction Outputs'
    entity TransactionOutputs       as projection on db.TransactionOutputs;

    @readonly
    @title      : 'Transaction Input Assets'
    @description: 'Projection for Transaction Input Assets'
    entity TransactionInputAssets   as projection on db.TransactionInputAssets;

    @readonly
    @title      : 'Transaction Output Assets'
    @description: 'Projection for Transaction Output Assets'
    entity TransactionOutputAssets  as projection on db.TransactionOutputAssets;

    @readonly
    @title      : 'Accounts'
    @description: 'Projection for Accounts'
    entity Accounts                 as projection on db.Accounts;

    @readonly
    @title      : 'Addresses'
    @description: 'Projection for Addresses'
    entity Addresses                as projection on db.Addresses;

    @readonly
    @title      : 'Address Assets'
    @description: 'Projection for Address Assets'
    entity AddressAssets            as projection on db.AddressAssets;

    @readonly
    @title      : 'Address UTxOs'
    @description: 'Projection for Address UTxOs'
    entity AddressUTxOs             as projection on db.AddressUTxOs;

    @readonly
    @title : 'Address Transactions'
    @description: 'Projection for Address Transactions'
    entity AddressTransactions     as projection on db.AddressTransactions;

    @readonly
    @title      : 'UTxO Assets'
    @description: 'Projection for UTxO Assets'
    entity UTxOAssets               as projection on db.UTxOAssets;

    @readonly
    @title      : 'Transaction Metadata'
    @description: 'Projection for Transaction Metadata'
    entity TransactionMetadata      as projection on db.TransactionMetadata;

    @readonly
    @title      : 'Ledger Protocol Parameters'
    @description: 'Projection for Ledger Protocol Parameters'
    entity LedgerProtocolParameters as projection on db.LedgerProtocolParameters;

    // ---------------------------------------------------------------------------
    // Actions
    // ---------------------------------------------------------------------------
    @title      : 'Get Network Information'
    @description: 'Retrieve current network information including network type and genesis hash'
    action GetNetworkInformation()                           returns NetworkInformation;

    @title      : 'Get Blocks by Block Hash'
    @description: 'Retrieve block information using the Block Hash'
    action GetBlockByHash(
                          @title: 'Block Hash'
                          @description: 'The unique identifier of the block'
                          hash: Blake2b256)               returns Blocks;

    @title      : 'Get Epochs by Epoch Number'
    @description: 'Retrieve epoch information using the Epoch Number'
    action GetEpochByNumber(
                            @title: 'Epoch Number'
                            @description: 'The sequential number of the epoch'
                            epochNumber: Integer)            returns Epochs;

    @title      : 'Get Pools by Pool Id'
    @description: 'Retrieve pool information using the Pool Id'
    action GetPoolById(
                       @title: 'Pool Id'
                       @description: 'The unique identifier of the stake pool'
                       poolId: String)                       returns Pools;

    @title      : 'Get Dreps by Drep Id'
    @description: 'Retrieve drep information using the Drep Id'
    action GetDrepById(
                       @title: 'Drep Id'
                       @description: 'The unique identifier of the drep'
                       drepId: String)                       returns Dreps;

    @title      : 'Get Asset Info'
    @description: 'Retrieve native-asset information (supply, mint history, CIP-25 + CIP-26 metadata) by unit. Multi-backend (Blockfrost, Koios). Field availability differs slightly per backend — see entity description.'
    action GetAssetInfo(
                        @title: 'Asset Unit'
                        @description: 'Concatenation of policyId (56 hex) and assetNameHex (0-64 hex; ledger caps asset names at 32 bytes)'
                        unit: AssetUnit)                     returns Assets;

    @title      : 'Get Asset Mint/Burn History'
    @description: 'Retrieve recent mint/burn events for a native asset (most recent first). Koios is preferred (provides block timestamps); Blockfrost is the fallback (timestamps null). Always-fresh fetch — UPSERTs entries by (unit, txHash). For full pagination, query the AssetHistory entity directly with $top/$skip after seeding.'
    action GetAssetHistory(
                           @title: 'Asset Unit'
                           @description: 'Concatenation of policyId (56 hex) and assetNameHex (0-64 hex; ledger caps asset names at 32 bytes)'
                           unit: AssetUnit,
                           @title: 'Limit'
                           @description: 'Maximum number of recent events to fetch (default 100, clamped to 1-100)'
                           limit: Integer)                   returns many AssetHistory;

    @title      : 'Get Accounts by Stake Address'
    @description: 'Retrieve account information using the Bech32 Stake Address'
    action GetAccountByStakeAddress(
                                    @title: 'Stake Address'
                                    @description: 'The Bech32 encoded stake address'
                                    stakeAddress: Bech32) returns Accounts;

    @title      : 'Get Transactions by Tx Hash'
    @description: 'Retrieve transaction information using the Transaction Hash'
    action GetTransactionByHash(
                                @title: 'Transaction Hash'
                                @description: 'The unique identifier of the transaction'
                                hash: Blake2b256)         returns Transactions;

    @title      : 'Get Transaction Metadata by Tx Hash'
    @description: 'Retrieve transaction metadata using the Transaction Hash'
    action GetMetadataByTxHash(
                               @title: 'Transaction Hash'
                               @description: 'The unique identifier of the transaction'
                               tx_hash: Blake2b256)       returns many TransactionMetadata;

    @title      : 'Get Addresses by Bech32 Address'
    @description: 'Retrieve address information using the Bech32 Address'
    action GetAddressByBech32(
                              @title: 'Bech32 Address'
                              @description: 'The Bech32 encoded address'
                              address: Bech32)            returns Addresses;

    @title      : 'Get UTxOs by Bech32 Address'
    @description: 'Retrieve UTxO information using the Bech32 Address'
    action GetUTxOsByAddress(
                             @title: 'Bech32 Address'
                             @description: 'The Bech32 encoded address'
                             address: Bech32)             returns many AddressUTxOs;

    @title      : 'Get UTxOs by Payment Credential'
    @description: 'Retrieve UTxOs across all bech32 addresses sharing the given 28-byte payment credential (key hash or script hash). Useful for protocols that write to multiple bech32 forms of the same script (e.g. Indigo CDPs, Liqwid positions). Koios-only — throws ProviderUnavailableError on deployments without Koios. Always fresh, no cache check.'
    action GetUTxOsByCredential(
                                @title: 'Payment Credential'
                                @description: '28-byte payment credential hash as 56-char lowercase hex string'
                                credential: String)       returns many AddressUTxOs;

    @title      : 'Get Assets by Bech32 Address'
    @description: 'Retrieve asset information using the Bech32 Address'
    action GetAssetsByAddress(
                              @title: 'Bech32 Address'
                              @description: 'The Bech32 encoded address'
                              address: Bech32)            returns many AddressAssets;

    @title : 'Get latest Transactions by Bech32 Address'
    @description: 'Retrieve the latest transactions from the Bech32 Address'
    action GetLatestTransactionsByAddress(
                                    @title: 'Bech32 Address'
                                    @description: 'The Bech32 encoded address'
                                    address: Bech32,
                                    @title: 'Limit'
                                    @description: 'The maximum number of transactions to retrieve'
                                    limit: Integer)            returns many AddressTransactions;

    @title      : 'Get Latest Block'
    @description: 'Retrieve the latest block information'
    action GetLatestBlock()                                  returns Blocks;

    @title      : 'Get Latest Epoch'
    @description: 'Retrieve the latest epoch information'
    action GetLatestEpoch()                                  returns Epochs;

    @title      : 'Get Ledger Protocol Parameters'
    @description: 'Retrieve the current ledger protocol parameters'
    action GetLedgerProtocolParameters()                     returns LedgerProtocolParameters;

    @title      : 'Parse Transaction CBOR'
    @description: 'Parse hex-encoded transaction CBOR (signed or unsigned) into structured fields. Pure function, no network call, no DB write.'
    action ParseTransactionCbor(
                                @title: 'Transaction CBOR'
                                @description: 'Hex-encoded transaction CBOR; signed or unsigned. Capped at 128 KiB of hex.'
                                cbor: LargeString)                    returns ParsedTransaction;
}
