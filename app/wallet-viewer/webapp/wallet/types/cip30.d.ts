/**
 * CIP-30 Type Definitions for Cardano Browser Wallets
 * Based on: https://cips.cardano.org/cip/CIP-30
 */

/**
 * Cardano namespace injected by browser wallets into window.cardano
 */
export interface CardanoNamespace {
    [walletName: string]: WalletApi | undefined;
}

/**
 * Initial wallet API (before enable() is called)
 */
export interface WalletApi {
    /** Wallet display name (e.g., "Nami", "Eternl") */
    name: string;
    /** Wallet icon as data URI (base64 encoded) */
    icon: string;
    /** CIP-30 API version string */
    apiVersion: string;
    /** Check if wallet is currently enabled for this dApp */
    isEnabled(): Promise<boolean>;
    /** Request permission to connect to the wallet */
    enable(): Promise<EnabledWalletApi>;
}

/**
 * Full wallet API after successful enable() call
 */
export interface EnabledWalletApi {
    /** Get the network ID (0 = preview, 1 = mainnet) */
    getNetworkId(): Promise<number>;
    /** Get UTxOs for the wallet, optionally filtered by amount */
    getUtxos(amount?: string, paginate?: Paginate): Promise<string[] | null>;
    /** Get the wallet's collateral UTxOs for script execution */
    getCollateral(params?: { amount: string }): Promise<string[] | null>;
    /** Get wallet's current balance as CBOR-encoded Value */
    getBalance(): Promise<string>;
    /** Get wallet's used addresses as hex or bech32 */
    getUsedAddresses(paginate?: Paginate): Promise<string[]>;
    /** Get wallet's unused addresses */
    getUnusedAddresses(): Promise<string[]>;
    /** Get wallet's change address for transaction outputs */
    getChangeAddress(): Promise<string>;
    /** Get wallet's reward/stake addresses */
    getRewardAddresses(): Promise<string[]>;
    /** Sign a transaction, returns witness set as CBOR hex */
    signTx(tx: string, partialSign?: boolean): Promise<string>;
    /** Sign arbitrary data per CIP-8 */
    signData(addr: string, payload: string): Promise<DataSignature>;
    /** Submit a fully signed transaction to the network */
    submitTx(tx: string): Promise<string>;
}

/**
 * Pagination parameters for address/utxo queries
 */
export interface Paginate {
    page: number;
    limit: number;
}

/**
 * Data signature result from signData (CIP-8)
 */
export interface DataSignature {
    signature: string;
    key: string;
}

/**
 * Wallet connection state for UI model binding
 */
export interface WalletConnectionState {
    /** Whether a connection attempt is in progress */
    isConnecting: boolean;
    /** Whether a wallet is currently connected */
    isConnected: boolean;
    /** Name of the connected wallet */
    walletName: string | null;
    /** Icon of the connected wallet (data URI) */
    walletIcon: string | null;
    /** Network ID (0 = preview, 1 = mainnet) */
    networkId: number | null;
    /** Human-readable network name */
    networkName: string | null;
    /** List of wallet addresses */
    addresses: WalletAddress[];
    /** Primary change address */
    changeAddress: string | null;
    /** Stake/reward addresses */
    stakeAddresses: string[];
    /** Parsed wallet balance */
    balance: WalletBalance | null;
    /** Error message if connection failed */
    error: string | null;
    /** List of detected available wallets */
    availableWallets: AvailableWallet[];
}

/**
 * Wallet address with metadata
 */
export interface WalletAddress {
    /** Bech32 encoded address */
    bech32: string;
    /** Whether address has been used */
    isUsed: boolean;
    /** Whether this is a change address */
    isChange: boolean;
}

/**
 * Parsed wallet balance
 */
export interface WalletBalance {
    /** ADA balance in lovelace (string for big numbers) */
    lovelace: string;
    /** Native assets held */
    assets: WalletAsset[];
}

/**
 * Native asset in wallet
 */
export interface WalletAsset {
    /** Full unit identifier (policyId + assetName hex) */
    unit: string;
    /** Policy ID (56 hex chars) */
    policyId: string;
    /** Asset name in hex */
    assetName: string;
    /** Asset name decoded as UTF-8 */
    assetNameUtf8: string;
    /** Quantity held (string for big numbers) */
    quantity: string;
}

/**
 * Available wallet info (detected but not connected)
 */
export interface AvailableWallet {
    /** Wallet identifier key in window.cardano */
    id: string;
    /** Display name */
    name: string;
    /** Icon as data URI */
    icon: string;
    /** CIP-30 API version */
    apiVersion: string;
}

/**
 * Transaction signing request from backend
 */
export interface SigningRequest {
    /** Signing request ID */
    signingRequestId: string;
    /** Transaction build ID */
    buildId: string;
    /** Unsigned transaction CBOR (hex) */
    unsignedTxCbor: string;
    /** Transaction body hash for verification */
    txBodyHash: string;
    /** Target network (mainnet/preprod/preview) */
    network: string;
    /** Request expiration timestamp */
    expiresAt: string;
}

/**
 * Transaction signing result
 */
export interface SigningResult {
    /** Whether signing succeeded */
    success: boolean;
    /** Signed transaction CBOR (hex) if successful */
    signedTxCbor?: string;
    /** Transaction hash */
    txHash?: string;
    /** Error message if failed */
    error?: string;
}

/**
 * CIP-30 Error codes
 */
export enum WalletErrorCode {
    /** Invalid request */
    InvalidRequest = -1,
    /** Internal wallet error */
    InternalError = -2,
    /** User refused connection */
    Refused = -3,
    /** User declined to sign */
    UserDeclined = 2,
    /** User cancelled action */
    UserCancelled = 3
}

// Extend global Window interface
declare global {
    interface Window {
        cardano?: CardanoNamespace;
    }
}
