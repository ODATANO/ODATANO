import JSONModel from "sap/ui/model/json/JSONModel";
import MessageToast from "sap/m/MessageToast";

import type {
    EnabledWalletApi,
    AvailableWallet,
    WalletConnectionState,
    WalletBalance,
    WalletAddress,
    SigningRequest,
    SigningResult
} from "./types/cip30";

/**
 * Known wallet identifiers in window.cardano
 */
const KNOWN_WALLETS: Record<string, string> = {
    nami: "Nami",
    eternl: "Eternl",
    flint: "Flint",
    lace: "Lace",
    yoroi: "Yoroi",
    gerowallet: "GeroWallet",
    nufi: "NuFi",
    typhon: "Typhon",
    vespr: "Vespr",
    begin: "Begin"
};

/**
 * Network ID to name mapping
 */
const NETWORK_NAMES: Record<number, string> = {
    0: "Preview",
    1: "Mainnet"
};

/**
 * Network ID to backend network name mapping
 */
const NETWORK_IDS: Record<number, string> = {
    0: "preview",
    1: "mainnet"
};

/**
 * Initial wallet state
 */
const INITIAL_STATE: WalletConnectionState = {
    isConnecting: false,
    isConnected: false,
    walletName: null,
    walletIcon: null,
    networkId: null,
    networkName: null,
    addresses: [],
    changeAddress: null,
    stakeAddresses: [],
    balance: null,
    error: null,
    availableWallets: []
};

/**
 * WalletService - Singleton service for CIP-30 wallet interactions
 *
 * Shared service for use across all frontend applications.
 *
 * Responsibilities:
 * - Detect available browser wallets
 * - Manage wallet connection lifecycle
 * - Retrieve addresses and balance
 * - Sign transactions
 * - Maintain wallet state model for UI binding
 */
export class WalletService {
    private static instance: WalletService | null = null;

    private walletModel: JSONModel;
    private enabledWallet: EnabledWalletApi | null = null;
    private connectedWalletId: string | null = null;

    private constructor() {
        this.walletModel = new JSONModel({ ...INITIAL_STATE });
        this.walletModel.setDefaultBindingMode("TwoWay");
    }

    /**
     * Get singleton instance
     */
    public static getInstance(): WalletService {
        if (!WalletService.instance) {
            WalletService.instance = new WalletService();
        }
        return WalletService.instance;
    }

    /**
     * Get the wallet model for UI binding
     */
    public getModel(): JSONModel {
        return this.walletModel;
    }

    /**
     * Check if browser wallets are supported (window.cardano exists)
     */
    public isSupported(): boolean {
        return typeof window !== "undefined" && "cardano" in window;
    }

    /**
     * Detect available wallets in window.cardano
     */
    public detectWallets(): AvailableWallet[] {
        const wallets: AvailableWallet[] = [];

        if (!this.isSupported() || !window.cardano) {
            this.walletModel.setProperty("/availableWallets", wallets);
            return wallets;
        }

        // Check known wallets first (preserves order)
        for (const [id, displayName] of Object.entries(KNOWN_WALLETS)) {
            const walletApi = window.cardano[id];
            if (walletApi && typeof walletApi.enable === "function") {
                wallets.push({
                    id,
                    name: walletApi.name || displayName,
                    icon: walletApi.icon || "",
                    apiVersion: walletApi.apiVersion || "unknown"
                });
            }
        }

        // Check for any other wallets not in known list
        for (const key of Object.keys(window.cardano)) {
            if (KNOWN_WALLETS[key]) continue; // Already checked

            const walletApi = window.cardano[key];
            if (
                walletApi &&
                typeof walletApi === "object" &&
                typeof walletApi.enable === "function" &&
                typeof walletApi.name === "string"
            ) {
                wallets.push({
                    id: key,
                    name: walletApi.name || key,
                    icon: walletApi.icon || "",
                    apiVersion: walletApi.apiVersion || "unknown"
                });
            }
        }

        this.walletModel.setProperty("/availableWallets", wallets);
        return wallets;
    }

    /**
     * Connect to a specific wallet
     */
    public async connect(walletId: string): Promise<boolean> {
        if (!this.isSupported() || !window.cardano) {
            this.setError("Browser wallets not supported");
            return false;
        }

        const walletApi = window.cardano[walletId];
        if (!walletApi) {
            this.setError(`Wallet "${walletId}" not found`);
            return false;
        }

        this.walletModel.setProperty("/isConnecting", true);
        this.walletModel.setProperty("/error", null);

        try {
            // Request permission to connect (opens wallet popup)
            this.enabledWallet = await walletApi.enable();
            this.connectedWalletId = walletId;

            // Get network info
            const networkId = await this.enabledWallet.getNetworkId();

            // Get addresses
            const usedAddresses = await this.enabledWallet.getUsedAddresses();
            const unusedAddresses = await this.enabledWallet.getUnusedAddresses();
            const changeAddress = await this.enabledWallet.getChangeAddress();
            const stakeAddresses = await this.enabledWallet.getRewardAddresses();

            // Parse balance
            const balanceCbor = await this.enabledWallet.getBalance();
            const balance = this.parseBalance(balanceCbor);

            // Build address list
            const addresses: WalletAddress[] = [
                ...usedAddresses.map((addr) => ({
                    bech32: this.normalizeAddress(addr),
                    isUsed: true,
                    isChange: false
                })),
                ...unusedAddresses.map((addr) => ({
                    bech32: this.normalizeAddress(addr),
                    isUsed: false,
                    isChange: false
                }))
            ];

            // Update model
            this.walletModel.setProperty("/isConnected", true);
            this.walletModel.setProperty("/walletName", walletApi.name);
            this.walletModel.setProperty("/walletIcon", walletApi.icon);
            this.walletModel.setProperty("/networkId", networkId);
            this.walletModel.setProperty("/networkName", NETWORK_NAMES[networkId] || "Unknown");
            this.walletModel.setProperty("/addresses", addresses);
            this.walletModel.setProperty("/changeAddress", this.normalizeAddress(changeAddress));
            this.walletModel.setProperty(
                "/stakeAddresses",
                stakeAddresses.map((addr) => this.normalizeAddress(addr))
            );
            this.walletModel.setProperty("/balance", balance);

            MessageToast.show(`Connected to ${walletApi.name}`);
            return true;
        } catch (error: unknown) {
            const walletError = error as { code?: number; message?: string; info?: string };
            const isUserRejection =
                walletError?.code === 2 ||
                walletError?.code === 3 ||
                walletError?.code === -3 ||
                walletError?.info?.includes("User declined") ||
                walletError?.info?.includes("rejected");

            const message = isUserRejection
                ? "Connection cancelled by user"
                : walletError?.message || walletError?.info || "Connection failed";

            this.setError(message);
            this.resetConnection();
            return false;
        } finally {
            this.walletModel.setProperty("/isConnecting", false);
        }
    }

    /**
     * Disconnect from current wallet
     */
    public disconnect(): void {
        this.resetConnection();
        MessageToast.show("Wallet disconnected");
    }

    /**
     * Refresh wallet data (balance, addresses)
     */
    public async refresh(): Promise<void> {
        if (!this.enabledWallet || !this.connectedWalletId) {
            return;
        }

        try {
            // Refresh balance
            const balanceCbor = await this.enabledWallet.getBalance();
            const balance = this.parseBalance(balanceCbor);
            this.walletModel.setProperty("/balance", balance);

            // Refresh addresses
            const usedAddresses = await this.enabledWallet.getUsedAddresses();
            const addresses: WalletAddress[] = usedAddresses.map((addr) => ({
                bech32: this.normalizeAddress(addr),
                isUsed: true,
                isChange: false
            }));
            this.walletModel.setProperty("/addresses", addresses);

            MessageToast.show("Wallet data refreshed");
        } catch (error: unknown) {
            console.warn("Failed to refresh wallet data:", error);
        }
    }

    /**
     * Sign a transaction using the connected wallet
     */
    public async signTransaction(
        signingRequest: SigningRequest,
        partialSign: boolean = false
    ): Promise<SigningResult> {
        if (!this.enabledWallet) {
            return {
                success: false,
                error: "No wallet connected"
            };
        }

        try {
            // CIP-30 signTx expects the unsigned transaction CBOR
            // Returns the witness set (signature) as CBOR hex
            const witnessSetCbor = await this.enabledWallet.signTx(
                signingRequest.unsignedTxCbor,
                partialSign
            );

            return {
                success: true,
                signedTxCbor: witnessSetCbor,
                txHash: signingRequest.txBodyHash
            };
        } catch (error: unknown) {
            const walletError = error as { code?: number; message?: string; info?: string };

            // User rejection has specific error codes
            const isUserRejection =
                walletError?.code === 2 ||
                walletError?.code === 3 ||
                walletError?.info?.includes("User declined") ||
                walletError?.info?.includes("cancelled");

            return {
                success: false,
                error: isUserRejection
                    ? "Transaction signing cancelled by user"
                    : walletError?.message || walletError?.info || "Signing failed"
            };
        }
    }

    /**
     * Get UTxOs from connected wallet
     */
    public async getUtxos(): Promise<string[]> {
        if (!this.enabledWallet) {
            return [];
        }

        try {
            const utxos = await this.enabledWallet.getUtxos();
            return utxos || [];
        } catch (error) {
            console.warn("Failed to get UTxOs:", error);
            return [];
        }
    }

    /**
     * Get collateral UTxOs from connected wallet
     */
    public async getCollateral(): Promise<string[]> {
        if (!this.enabledWallet) {
            return [];
        }

        try {
            const collateral = await this.enabledWallet.getCollateral();
            return collateral || [];
        } catch (error) {
            console.warn("Failed to get collateral:", error);
            return [];
        }
    }

    /**
     * Check if a specific wallet is currently connected
     */
    public isWalletConnected(walletId?: string): boolean {
        if (!walletId) {
            return this.walletModel.getProperty("/isConnected") as boolean;
        }
        return this.connectedWalletId === walletId && this.walletModel.getProperty("/isConnected");
    }

    /**
     * Get current wallet network as backend network name
     */
    public getNetwork(): string | null {
        const networkId = this.walletModel.getProperty("/networkId") as number | null;
        if (networkId === null) return null;
        return NETWORK_IDS[networkId] || "preprod";
    }

    /**
     * Get the primary (first used) address from the connected wallet
     */
    public getPrimaryAddress(): string | null {
        const addresses = this.walletModel.getProperty("/addresses") as WalletAddress[];
        return addresses?.[0]?.bech32 || null;
    }

    /**
     * Get the change address from the connected wallet
     */
    public getChangeAddress(): string | null {
        return this.walletModel.getProperty("/changeAddress") as string | null;
    }

    // --- Private Helper Methods ---

    private setError(message: string): void {
        this.walletModel.setProperty("/error", message);
        MessageToast.show(message);
    }

    private resetConnection(): void {
        this.enabledWallet = null;
        this.connectedWalletId = null;

        // Reset state but keep available wallets
        const availableWallets = this.walletModel.getProperty("/availableWallets");
        this.walletModel.setData({
            ...INITIAL_STATE,
            availableWallets
        });
    }

    /**
     * Parse CBOR-encoded balance to structured format
     * Note: Simplified implementation - full parsing requires CBOR library
     *
     * CIP-30 balance is encoded as:
     * - Just lovelace: single CBOR integer
     * - With assets: [lovelace, {policyId: {assetName: quantity}}]
     */
    private parseBalance(balanceCbor: string): WalletBalance {
        try {
            // Try to extract lovelace from simple CBOR integer encoding
            const lovelace = this.extractLovelaceFromCbor(balanceCbor);

            return {
                lovelace: lovelace,
                assets: [] // Would need full CBOR parsing for assets
            };
        } catch (e) {
            console.warn("Failed to parse balance CBOR:", e);
            return {
                lovelace: "0",
                assets: []
            };
        }
    }

    /**
     * Extract lovelace value from CBOR-encoded balance
     * This is a simplified parser that handles common cases
     */
    private extractLovelaceFromCbor(cbor: string): string {
        if (!cbor || cbor.length < 2) return "0";

        const bytes = this.hexToBytes(cbor);
        if (bytes.length === 0) return "0";

        // CBOR major type is in high 3 bits of first byte
        const majorType = bytes[0] >> 5;
        const additionalInfo = bytes[0] & 0x1f;

        // Type 0 = unsigned integer (simple lovelace value)
        if (majorType === 0) {
            return this.decodeCborUint(bytes).toString();
        }

        // Type 4 = array (likely [lovelace, multiassets])
        if (majorType === 4) {
            // Skip array header, parse first element (lovelace)
            const arrayLen = additionalInfo;
            if (arrayLen >= 1) {
                // Find where the lovelace integer starts
                let offset = 1;
                if (additionalInfo === 24) offset = 2;
                else if (additionalInfo === 25) offset = 3;
                else if (additionalInfo === 26) offset = 5;
                else if (additionalInfo === 27) offset = 9;

                const lovelaceBytes = bytes.slice(offset);
                if (lovelaceBytes.length > 0 && (lovelaceBytes[0] >> 5) === 0) {
                    return this.decodeCborUint(lovelaceBytes).toString();
                }
            }
        }

        return "0";
    }

    /**
     * Decode CBOR unsigned integer
     */
    private decodeCborUint(bytes: Uint8Array): bigint {
        if (bytes.length === 0) return BigInt(0);

        const additionalInfo = bytes[0] & 0x1f;

        if (additionalInfo < 24) {
            return BigInt(additionalInfo);
        } else if (additionalInfo === 24 && bytes.length >= 2) {
            return BigInt(bytes[1]);
        } else if (additionalInfo === 25 && bytes.length >= 3) {
            return BigInt((bytes[1] << 8) | bytes[2]);
        } else if (additionalInfo === 26 && bytes.length >= 5) {
            return BigInt(
                (bytes[1] << 24) | (bytes[2] << 16) | (bytes[3] << 8) | bytes[4]
            );
        } else if (additionalInfo === 27 && bytes.length >= 9) {
            let value = BigInt(0);
            for (let i = 1; i <= 8; i++) {
                value = (value << BigInt(8)) | BigInt(bytes[i]);
            }
            return value;
        }

        return BigInt(0);
    }

    /**
     * Convert hex string to byte array
     */
    private hexToBytes(hex: string): Uint8Array {
        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < hex.length; i += 2) {
            bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
        }
        return bytes;
    }

    /**
     * Normalize address format (handles both hex and bech32)
     * CIP-30 wallets may return addresses in hex format which needs conversion to bech32
     */
    private normalizeAddress(address: string): string {
        // Already bech32 format
        if (address.startsWith("addr") || address.startsWith("stake")) {
            return address;
        }

        // Hex format - convert to bech32
        if (/^[0-9a-fA-F]+$/.test(address)) {
            return this.hexAddressToBech32(address);
        }

        return address;
    }

    /**
     * Convert hex-encoded Cardano address to bech32 format
     * Cardano addresses have a header byte that indicates type and network
     */
    private hexAddressToBech32(hex: string): string {
        const bytes = this.hexToBytes(hex);
        if (bytes.length === 0) return hex;

        // Header byte: high nibble = address type, low nibble = network
        const header = bytes[0];
        const networkId = header & 0x0f;
        const addrType = (header >> 4) & 0x0f;
        const isMainnet = networkId === 1;

        // Determine bech32 prefix based on address type
        // Types 0xe, 0xf are reward/stake addresses
        const isReward = addrType === 0xe || addrType === 0xf;

        let prefix: string;
        if (isReward) {
            prefix = isMainnet ? "stake" : "stake_test";
        } else {
            prefix = isMainnet ? "addr" : "addr_test";
        }

        // Convert to 5-bit words and encode
        const words = this.toWords(bytes);
        return this.bech32Encode(prefix, words);
    }

    /**
     * Convert byte array to 5-bit words for bech32 encoding
     */
    private toWords(bytes: Uint8Array): number[] {
        const words: number[] = [];
        let value = 0;
        let bits = 0;

        for (const byte of bytes) {
            value = (value << 8) | byte;
            bits += 8;
            while (bits >= 5) {
                bits -= 5;
                words.push((value >> bits) & 0x1f);
            }
        }

        if (bits > 0) {
            words.push((value << (5 - bits)) & 0x1f);
        }

        return words;
    }

    /**
     * Bech32 encode with human-readable prefix and data words
     */
    private bech32Encode(prefix: string, words: number[]): string {
        const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

        const polymod = (values: number[]): number => {
            const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
            let chk = 1;
            for (const v of values) {
                const b = chk >> 25;
                chk = ((chk & 0x1ffffff) << 5) ^ v;
                for (let i = 0; i < 5; i++) {
                    if ((b >> i) & 1) chk ^= GEN[i];
                }
            }
            return chk;
        };

        const hrpExpand = (hrp: string): number[] => {
            const ret: number[] = [];
            for (const c of hrp) {
                ret.push(c.charCodeAt(0) >> 5);
            }
            ret.push(0);
            for (const c of hrp) {
                ret.push(c.charCodeAt(0) & 31);
            }
            return ret;
        };

        const createChecksum = (hrp: string, data: number[]): number[] => {
            const values = hrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
            const mod = polymod(values) ^ 1;
            const ret: number[] = [];
            for (let i = 0; i < 6; i++) {
                ret.push((mod >> (5 * (5 - i))) & 31);
            }
            return ret;
        };

        const checksum = createChecksum(prefix, words);
        const combined = words.concat(checksum);

        let result = prefix + "1";
        for (const w of combined) {
            result += CHARSET[w];
        }

        return result;
    }
}

/**
 * Get the singleton WalletService instance
 */
export function getWalletService(): WalletService {
    return WalletService.getInstance();
}
