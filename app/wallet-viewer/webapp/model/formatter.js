sap.ui.define([], function () {
    "use strict";

    return {
        /**
         * Convert lovelace to ADA - returns NUMBER for ObjectNumber binding
         * 1 ADA = 1,000,000 lovelace
         */
        formatLovelaceToAda: function (lovelace) {
            if (lovelace === null || lovelace === undefined || lovelace === "") {
                return 0;
            }
            try {
                var amount;
                if (typeof lovelace === "string") {
                    amount = parseFloat(lovelace.replace(/,/g, ""));
                } else if (typeof lovelace === "number") {
                    amount = lovelace;
                } else {
                    amount = parseFloat(String(lovelace));
                }
                if (isNaN(amount)) return 0;
                return Math.round((amount / 1000000) * 100) / 100;
            } catch {
                return 0;
            }
        },

        /**
         * Format lovelace to ADA with unit suffix (for Text elements)
         */
        formatLovelaceToAdaWithUnit: function (lovelace) {
            var ada = this.formatLovelaceToAda(lovelace);
            return new Intl.NumberFormat("en-US", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 6
            }).format(ada) + " ADA";
        },

        /**
         * Format large numbers with abbreviations (K, M, B, T)
         */
        formatLargeNumber: function (value) {
            if (value === null || value === undefined || value === "") return "0";
            var num = typeof value === "string" ? parseFloat(value) : value;
            if (isNaN(num)) return "0";

            if (num >= 1000000000000) return (num / 1000000000000).toFixed(2) + "T";
            if (num >= 1000000000) return (num / 1000000000).toFixed(2) + "B";
            if (num >= 1000000) return (num / 1000000).toFixed(2) + "M";
            if (num >= 1000) return (num / 1000).toFixed(2) + "K";
            return num.toFixed(2);
        },

        /**
         * Truncate long hashes for display
         */
        truncateHash: function (hash, prefixLength, suffixLength) {
            if (!hash) return "";
            prefixLength = prefixLength || 8;
            suffixLength = suffixLength || 8;
            if (hash.length <= prefixLength + suffixLength + 3) return hash;
            return hash.substring(0, prefixLength) + "..." + hash.substring(hash.length - suffixLength);
        },

        /**
         * Truncate address for display (shows prefix and suffix)
         */
        truncateAddress: function (address) {
            if (!address) return "";
            if (address.startsWith("addr") || address.startsWith("stake")) {
                if (address.length <= 30) return address;
                return address.substring(0, 15) + "..." + address.substring(address.length - 10);
            }
            return this.truncateHash(address);
        },

        /**
         * Format Unix timestamp to readable date
         */
        formatBlockTime: function (timestamp) {
            if (!timestamp) return "";
            var ts = typeof timestamp === "string" ? parseInt(timestamp, 10) : timestamp;
            if (isNaN(ts)) return "";
            return new Date(ts * 1000).toLocaleString();
        },

        /**
         * Format Unix timestamp to ISO date string
         */
        formatBlockTimeISO: function (timestamp) {
            if (!timestamp) return "";
            var ts = typeof timestamp === "string" ? parseInt(timestamp, 10) : timestamp;
            if (isNaN(ts)) return "";
            return new Date(ts * 1000).toISOString();
        },

        /**
         * Get address type display text
         */
        getAddressTypeText: function (type) {
            var types = {
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
        getBooleanState: function (value) {
            return value === true ? "Success" : "None";
        },

        /**
         * Format boolean as Yes/No
         */
        formatBoolean: function (value) {
            if (value === null || value === undefined) return "-";
            return value ? "Yes" : "No";
        },

        /**
         * Get state color for submission status
         */
        getSubmissionStatusState: function (status) {
            var states = {
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
        formatBytes: function (bytes) {
            if (bytes === null || bytes === undefined) return "0 B";
            var b = typeof bytes === "string" ? parseInt(bytes, 10) : bytes;
            if (isNaN(b)) return "0 B";
            if (b < 1024) return b + " B";
            if (b < 1024 * 1024) return (b / 1024).toFixed(2) + " KB";
            if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(2) + " MB";
            return (b / (1024 * 1024 * 1024)).toFixed(2) + " GB";
        },

        /**
         * Get state color for signing request status
         */
        getSigningRequestStatusState: function (status) {
            var states = {
                "pending": "Warning",
                "signed": "Information",
                "verified": "Information",
                "submitted": "Success",
                "expired": "Error",
                "failed": "Error"
            };
            return states[status || ""] || "None";
        },

        /**
         * Get icon for signing request status
         */
        getSigningRequestStatusIcon: function (status) {
            var icons = {
                "pending": "sap-icon://pending",
                "signed": "sap-icon://signature",
                "verified": "sap-icon://accept",
                "submitted": "sap-icon://complete",
                "expired": "sap-icon://lateness",
                "failed": "sap-icon://error"
            };
            return icons[status || ""] || "";
        },

        /**
         * Format ISO timestamp to readable date
         */
        formatTimestamp: function (timestamp) {
            if (!timestamp) return "";
            try {
                return new Date(timestamp).toLocaleString();
            } catch {
                return "";
            }
        }
    };
});
