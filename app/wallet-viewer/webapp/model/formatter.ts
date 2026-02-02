/**
 * Formatter functions for Cardano wallet viewer
 * @namespace odatanoview.walletviewer.model.formatter
 */
export default {
    /**
     * Convert lovelace to ADA - returns NUMBER for ObjectNumber binding
     * 1 ADA = 1,000,000 lovelace
     */
    formatLovelaceToAda(lovelace: any): number {
        if (lovelace === null || lovelace === undefined || lovelace === "") {
            return 0;
        }

        try {
            // Handle various input types from OData V4
            let amount: number;
            if (typeof lovelace === "string") {
                // Remove commas and other formatting characters
                amount = parseFloat(lovelace.replace(/,/g, ""));
            } else if (typeof lovelace === "number") {
                amount = lovelace;
            } else if (typeof lovelace === "object" && lovelace !== null) {
                // OData might pass as object - try to extract value
                amount = parseFloat(String(lovelace));
            } else {
                amount = parseFloat(String(lovelace));
            }

            if (isNaN(amount)) {
                return 0;
            }
            return Math.round((amount / 1_000_000) * 100) / 100;
        } catch {
            return 0;
        }
    },

    /**
     * Format lovelace to ADA with unit suffix (for Text elements)
     */
    formatLovelaceToAdaWithUnit(lovelace: string | number | null | undefined): string {
        const ada = this.formatLovelaceToAda(lovelace);
        return new Intl.NumberFormat("en-US", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 6
        }).format(ada) + " ADA";
    },

    /**
     * Format large numbers with abbreviations (K, M, B, T)
     */
    formatLargeNumber(value: string | number | null | undefined): string {
        if (value === null || value === undefined || value === "") {
            return "0";
        }

        const num = typeof value === "string" ? parseFloat(value) : value;

        if (isNaN(num)) {
            return "0";
        }

        if (num >= 1_000_000_000_000) {
            return (num / 1_000_000_000_000).toFixed(2) + "T";
        }
        if (num >= 1_000_000_000) {
            return (num / 1_000_000_000).toFixed(2) + "B";
        }
        if (num >= 1_000_000) {
            return (num / 1_000_000).toFixed(2) + "M";
        }
        if (num >= 1_000) {
            return (num / 1_000).toFixed(2) + "K";
        }

        return num.toFixed(2);
    },

    /**
     * Truncate long hashes for display
     */
    truncateHash(hash: string | null | undefined, prefixLength: number = 8, suffixLength: number = 8): string {
        if (!hash) return "";
        if (hash.length <= prefixLength + suffixLength + 3) return hash;
        return `${hash.substring(0, prefixLength)}...${hash.substring(hash.length - suffixLength)}`;
    },

    /**
     * Truncate address for display (shows prefix and suffix)
     */
    truncateAddress(address: string | null | undefined): string {
        if (!address) return "";
        // For bech32 addresses, show more of the prefix (addr1/stake1)
        if (address.startsWith("addr") || address.startsWith("stake")) {
            if (address.length <= 30) return address;
            return `${address.substring(0, 15)}...${address.substring(address.length - 10)}`;
        }
        return this.truncateHash(address);
    },

    /**
     * Format Unix timestamp to readable date
     */
    formatBlockTime(timestamp: number | string | null | undefined): string {
        if (!timestamp) return "";
        const ts = typeof timestamp === "string" ? parseInt(timestamp, 10) : timestamp;
        if (isNaN(ts)) return "";

        const date = new Date(ts * 1000);
        return date.toLocaleString();
    },

    /**
     * Format Unix timestamp to ISO date string
     */
    formatBlockTimeISO(timestamp: number | string | null | undefined): string {
        if (!timestamp) return "";
        const ts = typeof timestamp === "string" ? parseInt(timestamp, 10) : timestamp;
        if (isNaN(ts)) return "";

        const date = new Date(ts * 1000);
        return date.toISOString();
    },

    /**
     * Get address type display text
     */
    getAddressTypeText(type: string | null | undefined): string {
        const types: Record<string, string> = {
            "base": "Base Address",
            "enterprise": "Enterprise Address",
            "pointer": "Pointer Address",
            "reward": "Reward Address",
            "script": "Script Address",
            "unknown": "Unknown Type"
        };
        return types[type || "unknown"] || type || "Unknown";
    },

    /**
     * Determine status state based on boolean
     */
    getBooleanState(value: boolean | null | undefined): string {
        return value === true ? "Success" : "None";
    },

    /**
     * Format boolean as Yes/No
     */
    formatBoolean(value: boolean | null | undefined): string {
        if (value === null || value === undefined) return "-";
        return value ? "Yes" : "No";
    },

    /**
     * Get state color for submission status
     */
    getSubmissionStatusState(status: string | null | undefined): string {
        const states: Record<string, string> = {
            "pending": "Warning",
            "submitted": "Information",
            "confirmed": "Success",
            "failed": "Error",
            "rejected": "Error"
        };
        return states[status || ""] || "None";
    },

    /**
     * Format bytes to human readable size
     */
    formatBytes(bytes: number | string | null | undefined): string {
        if (bytes === null || bytes === undefined) return "0 B";
        const b = typeof bytes === "string" ? parseInt(bytes, 10) : bytes;
        if (isNaN(b)) return "0 B";

        if (b < 1024) return `${b} B`;
        if (b < 1024 * 1024) return `${(b / 1024).toFixed(2)} KB`;
        if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(2)} MB`;
        return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }
};
