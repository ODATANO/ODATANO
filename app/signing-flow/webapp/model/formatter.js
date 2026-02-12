sap.ui.define([], function () {
    "use strict";

    // Standalone helpers — avoid 'this' context issues in UI5 formatters
    function _toAda(lovelace) {
        if (lovelace === null || lovelace === undefined || lovelace === "") return 0;
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
    }

    function _truncHash(hash, prefixLen, suffixLen) {
        if (!hash) return "";
        prefixLen = prefixLen || 8;
        suffixLen = suffixLen || 8;
        if (hash.length <= prefixLen + suffixLen + 3) return hash;
        return hash.substring(0, prefixLen) + "..." + hash.substring(hash.length - suffixLen);
    }

    return {
        formatLovelaceToAda: function (lovelace) {
            return _toAda(lovelace);
        },

        formatLovelaceToAdaWithUnit: function (lovelace) {
            var ada = _toAda(lovelace);
            return new Intl.NumberFormat("en-US", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 6
            }).format(ada) + " ADA";
        },

        truncateHash: function (hash, prefixLength, suffixLength) {
            return _truncHash(hash, prefixLength, suffixLength);
        },

        truncateAddress: function (address) {
            if (!address) return "";
            if (address.startsWith("addr") || address.startsWith("stake")) {
                if (address.length <= 30) return address;
                return address.substring(0, 15) + "..." + address.substring(address.length - 10);
            }
            return _truncHash(address);
        },

        formatTimestamp: function (timestamp) {
            if (!timestamp) return "";
            try {
                return new Date(timestamp).toLocaleString();
            } catch {
                return "";
            }
        },

        formatBytes: function (bytes) {
            if (bytes === null || bytes === undefined) return "0 B";
            var b = typeof bytes === "string" ? parseInt(bytes, 10) : bytes;
            if (isNaN(b)) return "0 B";
            if (b < 1024) return b + " B";
            if (b < 1024 * 1024) return (b / 1024).toFixed(2) + " KB";
            return (b / (1024 * 1024)).toFixed(2) + " MB";
        },

        getSigningRequestStatusState: function (status) {
            var states = {
                "pending": "Warning",
                "signed": "Information",
                "verified": "Information",
                "submitted": "Success",
                "confirmed": "Success",
                "expired": "Error",
                "failed": "Error"
            };
            return states[status || ""] || "None";
        },

        getSigningRequestStatusIcon: function (status) {
            var icons = {
                "pending": "sap-icon://pending",
                "signed": "sap-icon://signature",
                "verified": "sap-icon://accept",
                "submitted": "sap-icon://complete",
                "confirmed": "sap-icon://shield",
                "expired": "sap-icon://lateness",
                "failed": "sap-icon://error"
            };
            return icons[status || ""] || "";
        },

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

        formatCborPreview: function (cbor) {
            if (!cbor) return "";
            if (cbor.length <= 80) return cbor;
            return cbor.substring(0, 80) + "...";
        },

        getVerificationIcon: function (isValid) {
            return isValid ? "sap-icon://accept" : "sap-icon://decline";
        },

        getVerificationState: function (isValid) {
            return isValid ? "Success" : "Error";
        },

        getVerificationText: function (isValid) {
            return isValid ? "Signature Verified" : "Verification Failed";
        },

        getCardanoscanUrl: function (txHash, network) {
            if (!txHash) return "";
            var base = network === "mainnet"
                ? "https://cardanoscan.io"
                : "https://" + (network || "preview") + ".cardanoscan.io";
            return base + "/transaction/" + txHash;
        },

        formatNetworkBadge: function (networkName) {
            return networkName || "Unknown";
        },

        getNetworkState: function (networkName) {
            return networkName === "Mainnet" ? "Success" : "Warning";
        }
    };
});
