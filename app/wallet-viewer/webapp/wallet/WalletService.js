sap.ui.define([
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageToast"
], function (JSONModel, MessageToast) {
    "use strict";

    var KNOWN_WALLETS = {
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

    var NETWORK_NAMES = { 0: "Preview", 1: "Mainnet" };
    var NETWORK_IDS = { 0: "preview", 1: "mainnet" };

    var INITIAL_STATE = {
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
        availableWallets: [],
        transactions: [],
        signingRequests: [],
        transactionBuilds: []
    };

    var _instance = null;

    // --- Private helper functions ---

    function hexToBytes(hex) {
        var bytes = new Uint8Array(hex.length / 2);
        for (var i = 0; i < hex.length; i += 2) {
            bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
        }
        return bytes;
    }

    function bytesToHex(bytes) {
        var hex = "";
        for (var i = 0; i < bytes.length; i++) {
            hex += ("0" + bytes[i].toString(16)).slice(-2);
        }
        return hex;
    }

    /**
     * Generic CBOR decoder — handles types needed for Cardano Value:
     * uint (0), byte string (2), text string (3), array (4), map (5)
     */
    function decodeCbor(bytes, offset) {
        if (offset >= bytes.length) return { value: null, offset: offset };

        var firstByte = bytes[offset];
        var majorType = firstByte >> 5;
        var additionalInfo = firstByte & 0x1f;
        offset++;

        // Decode argument (length or value)
        var argument;
        if (additionalInfo < 24) {
            argument = additionalInfo;
        } else if (additionalInfo === 24) {
            argument = bytes[offset++];
        } else if (additionalInfo === 25) {
            argument = (bytes[offset] << 8) | bytes[offset + 1];
            offset += 2;
        } else if (additionalInfo === 26) {
            argument = ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
            offset += 4;
        } else if (additionalInfo === 27) {
            // 8-byte uint — use BigInt then convert to Number (safe for lovelace/quantities)
            var hi = ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
            var lo = ((bytes[offset + 4] << 24) | (bytes[offset + 5] << 16) | (bytes[offset + 6] << 8) | bytes[offset + 7]) >>> 0;
            argument = Number(BigInt(hi) * BigInt(0x100000000) + BigInt(lo));
            offset += 8;
        } else {
            argument = 0;
        }

        var i, item, key, val, arr, map;

        switch (majorType) {
            case 0: // unsigned integer
                return { value: argument, offset: offset };
            case 1: // negative integer
                return { value: -1 - argument, offset: offset };
            case 2: // byte string
                var bstr = bytes.slice(offset, offset + argument);
                return { value: bstr, offset: offset + argument };
            case 3: // text string
                var text = new TextDecoder().decode(bytes.slice(offset, offset + argument));
                return { value: text, offset: offset + argument };
            case 4: // array
                arr = [];
                for (i = 0; i < argument; i++) {
                    item = decodeCbor(bytes, offset);
                    arr.push(item.value);
                    offset = item.offset;
                }
                return { value: arr, offset: offset };
            case 5: // map — return as array of {key, value} pairs
                map = [];
                for (i = 0; i < argument; i++) {
                    key = decodeCbor(bytes, offset);
                    offset = key.offset;
                    val = decodeCbor(bytes, offset);
                    offset = val.offset;
                    map.push({ key: key.value, value: val.value });
                }
                return { value: map, offset: offset };
            default:
                return { value: null, offset: offset };
        }
    }

    /**
     * Try to decode bytes as printable UTF-8, fall back to hex
     */
    function decodeAssetName(nameBytes) {
        if (!nameBytes || nameBytes.length === 0) return "";
        try {
            var text = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
            // Only accept if all chars are printable ASCII/Unicode
            if (/^[\x20-\x7e\u00a0-\uffff]+$/.test(text)) return text;
        } catch { /* not valid UTF-8 */ }
        return bytesToHex(nameBytes);
    }

    /**
     * Parse CIP-30 CBOR-encoded balance into { lovelace, assets[] }
     *
     * CIP-30 getBalance() returns either:
     *   - Simple: CBOR uint (lovelace only)
     *   - Multiasset: CBOR array [uint lovelace, map { bytes policyId: map { bytes assetName: uint quantity } }]
     */
    function parseBalance(balanceCbor) {
        try {
            if (!balanceCbor || balanceCbor.length < 2) return { lovelace: "0", assets: [] };

            var bytes = hexToBytes(balanceCbor);
            var result = decodeCbor(bytes, 0);
            var decoded = result.value;

            // Simple lovelace value (uint)
            if (typeof decoded === "number") {
                return { lovelace: String(decoded), assets: [] };
            }

            // Multiasset: [lovelace, { policyId: { assetName: quantity } }]
            if (Array.isArray(decoded) && decoded.length === 2) {
                var lovelace = String(decoded[0]);
                var multiassetMap = decoded[1]; // array of {key: Uint8Array, value: array of {key, value}}
                var assets = [];

                if (Array.isArray(multiassetMap)) {
                    for (var i = 0; i < multiassetMap.length; i++) {
                        var policyEntry = multiassetMap[i];
                        var policyId = bytesToHex(policyEntry.key);
                        var assetEntries = policyEntry.value;

                        if (Array.isArray(assetEntries)) {
                            for (var j = 0; j < assetEntries.length; j++) {
                                var assetEntry = assetEntries[j];
                                var assetNameHex = bytesToHex(assetEntry.key);
                                var assetName = decodeAssetName(assetEntry.key);
                                var quantity = String(assetEntry.value);

                                assets.push({
                                    policyId: policyId,
                                    assetNameHex: assetNameHex,
                                    assetName: assetName || "(unnamed)",
                                    displayName: assetName || policyId.substring(0, 8) + "...",
                                    quantity: quantity,
                                    unit: policyId + assetNameHex
                                });
                            }
                        }
                    }
                }

                return { lovelace: lovelace, assets: assets };
            }

            return { lovelace: "0", assets: [] };
        } catch {
            return { lovelace: "0", assets: [] };
        }
    }

    function toWords(bytes) {
        var words = [];
        var value = 0;
        var bits = 0;
        for (var i = 0; i < bytes.length; i++) {
            value = (value << 8) | bytes[i];
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

    function bech32Encode(prefix, words) {
        var CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
        var GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

        function polymod(values) {
            var chk = 1;
            for (var j = 0; j < values.length; j++) {
                var b = chk >> 25;
                chk = ((chk & 0x1ffffff) << 5) ^ values[j];
                for (var k = 0; k < 5; k++) {
                    if ((b >> k) & 1) chk ^= GEN[k];
                }
            }
            return chk;
        }

        function hrpExpand(hrp) {
            var ret = [];
            for (var j = 0; j < hrp.length; j++) ret.push(hrp.charCodeAt(j) >> 5);
            ret.push(0);
            for (var k = 0; k < hrp.length; k++) ret.push(hrp.charCodeAt(k) & 31);
            return ret;
        }

        var values = hrpExpand(prefix).concat(words).concat([0, 0, 0, 0, 0, 0]);
        var mod = polymod(values) ^ 1;
        var checksum = [];
        for (var i = 0; i < 6; i++) {
            checksum.push((mod >> (5 * (5 - i))) & 31);
        }

        var combined = words.concat(checksum);
        var result = prefix + "1";
        for (var j = 0; j < combined.length; j++) {
            result += CHARSET[combined[j]];
        }
        return result;
    }

    function hexAddressToBech32(hex) {
        var bytes = hexToBytes(hex);
        if (bytes.length === 0) return hex;

        var header = bytes[0];
        var networkId = header & 0x0f;
        var addrType = (header >> 4) & 0x0f;
        var isMainnet = networkId === 1;
        var isReward = addrType === 0xe || addrType === 0xf;

        var prefix;
        if (isReward) {
            prefix = isMainnet ? "stake" : "stake_test";
        } else {
            prefix = isMainnet ? "addr" : "addr_test";
        }

        var words = toWords(bytes);
        return bech32Encode(prefix, words);
    }

    function normalizeAddress(address) {
        if (address.startsWith("addr") || address.startsWith("stake")) return address;
        if (/^[0-9a-fA-F]+$/.test(address)) return hexAddressToBech32(address);
        return address;
    }

    /**
     * WalletService - Singleton service for CIP-30 wallet interactions
     * @namespace odatanoview.walletviewer.wallet
     */
    var WalletService = {

        _walletModel: null,
        _enabledWallet: null,
        _connectedWalletId: null,

        _init: function () {
            this._walletModel = new JSONModel(JSON.parse(JSON.stringify(INITIAL_STATE)));
            this._walletModel.setDefaultBindingMode("TwoWay");
            this._enabledWallet = null;
            this._connectedWalletId = null;
        },

        getModel: function () {
            return this._walletModel;
        },

        isSupported: function () {
            return typeof window !== "undefined" && "cardano" in window;
        },

        detectWallets: function () {
            var wallets = [];

            if (!this.isSupported() || !window.cardano) {
                this._walletModel.setProperty("/availableWallets", wallets);
                return wallets;
            }

            var id, displayName, walletApi;

            for (id in KNOWN_WALLETS) {
                displayName = KNOWN_WALLETS[id];
                walletApi = window.cardano[id];
                if (walletApi && typeof walletApi.enable === "function") {
                    wallets.push({
                        id: id,
                        name: walletApi.name || displayName,
                        icon: walletApi.icon || "",
                        apiVersion: walletApi.apiVersion || "unknown"
                    });
                }
            }

            var keys = Object.keys(window.cardano);
            for (var i = 0; i < keys.length; i++) {
                var key = keys[i];
                if (KNOWN_WALLETS[key]) continue;
                walletApi = window.cardano[key];
                if (walletApi && typeof walletApi === "object" &&
                    typeof walletApi.enable === "function" &&
                    typeof walletApi.name === "string") {
                    wallets.push({
                        id: key,
                        name: walletApi.name || key,
                        icon: walletApi.icon || "",
                        apiVersion: walletApi.apiVersion || "unknown"
                    });
                }
            }

            this._walletModel.setProperty("/availableWallets", wallets);
            return wallets;
        },

        connect: function (walletId) {
            if (!this.isSupported() || !window.cardano) {
                this._setError("Browser wallets not supported");
                return Promise.resolve(false);
            }

            var walletApi = window.cardano[walletId];
            if (!walletApi) {
                this._setError("Wallet \"" + walletId + "\" not found");
                return Promise.resolve(false);
            }

            this._walletModel.setProperty("/isConnecting", true);
            this._walletModel.setProperty("/error", null);

            var that = this;

            return walletApi.enable().then(function (enabledApi) {
                that._enabledWallet = enabledApi;
                that._connectedWalletId = walletId;

                return Promise.all([
                    enabledApi.getNetworkId(),
                    enabledApi.getUsedAddresses(),
                    enabledApi.getUnusedAddresses(),
                    enabledApi.getChangeAddress(),
                    enabledApi.getRewardAddresses(),
                    enabledApi.getBalance()
                ]);
            }).then(function (results) {
                var networkId = results[0];
                var usedAddresses = results[1];
                var unusedAddresses = results[2];
                var changeAddress = results[3];
                var stakeAddresses = results[4];
                var balanceCbor = results[5];

                var balance = parseBalance(balanceCbor);

                var addresses = usedAddresses.map(function (addr) {
                    return { bech32: normalizeAddress(addr), isUsed: true, isChange: false };
                }).concat(unusedAddresses.map(function (addr) {
                    return { bech32: normalizeAddress(addr), isUsed: false, isChange: false };
                }));

                that._walletModel.setProperty("/isConnected", true);
                that._walletModel.setProperty("/walletName", walletApi.name);
                that._walletModel.setProperty("/walletIcon", walletApi.icon);
                that._walletModel.setProperty("/networkId", networkId);
                that._walletModel.setProperty("/networkName", NETWORK_NAMES[networkId] || "Unknown");
                that._walletModel.setProperty("/addresses", addresses);
                that._walletModel.setProperty("/changeAddress", normalizeAddress(changeAddress));
                that._walletModel.setProperty("/stakeAddresses", stakeAddresses.map(normalizeAddress));
                that._walletModel.setProperty("/balance", balance);

                MessageToast.show("Connected to " + walletApi.name);
                return true;
            }).catch(function (error) {
                var walletError = error || {};
                var isUserRejection =
                    walletError.code === 2 || walletError.code === 3 || walletError.code === -3 ||
                    (walletError.info && walletError.info.indexOf("User declined") >= 0) ||
                    (walletError.info && walletError.info.indexOf("rejected") >= 0);

                var message = isUserRejection
                    ? "Connection cancelled by user"
                    : walletError.message || walletError.info || "Connection failed";

                that._setError(message);
                that._resetConnection();
                return false;
            }).finally(function () {
                that._walletModel.setProperty("/isConnecting", false);
            });
        },

        disconnect: function () {
            this._resetConnection();
            MessageToast.show("Wallet disconnected");
        },

        refresh: function () {
            if (!this._enabledWallet || !this._connectedWalletId) {
                return Promise.resolve();
            }

            var that = this;

            return Promise.all([
                this._enabledWallet.getBalance(),
                this._enabledWallet.getUsedAddresses()
            ]).then(function (results) {
                var balance = parseBalance(results[0]);
                that._walletModel.setProperty("/balance", balance);

                var addresses = results[1].map(function (addr) {
                    return { bech32: normalizeAddress(addr), isUsed: true, isChange: false };
                });
                that._walletModel.setProperty("/addresses", addresses);

                MessageToast.show("Wallet data refreshed");
            }).catch(function () {
                // refresh failed silently
            });
        },

        signTransaction: function (signingRequest, partialSign) {
            if (!this._enabledWallet) {
                return Promise.resolve({ success: false, error: "No wallet connected" });
            }

            return this._enabledWallet.signTx(
                signingRequest.unsignedTxCbor,
                !!partialSign
            ).then(function (witnessSetCbor) {
                return {
                    success: true,
                    signedTxCbor: witnessSetCbor,
                    txHash: signingRequest.txBodyHash
                };
            }).catch(function (error) {
                var walletError = error || {};
                var isUserRejection =
                    walletError.code === 2 || walletError.code === 3 ||
                    (walletError.info && walletError.info.indexOf("User declined") >= 0) ||
                    (walletError.info && walletError.info.indexOf("cancelled") >= 0);

                return {
                    success: false,
                    error: isUserRejection
                        ? "Transaction signing cancelled by user"
                        : walletError.message || walletError.info || "Signing failed"
                };
            });
        },

        getUtxos: function () {
            if (!this._enabledWallet) return Promise.resolve([]);
            return this._enabledWallet.getUtxos().then(function (utxos) {
                return utxos || [];
            }).catch(function () {
                return [];
            });
        },

        getCollateral: function () {
            if (!this._enabledWallet) return Promise.resolve([]);
            return this._enabledWallet.getCollateral().then(function (collateral) {
                return collateral || [];
            }).catch(function () {
                return [];
            });
        },

        isWalletConnected: function (walletId) {
            if (!walletId) return this._walletModel.getProperty("/isConnected");
            return this._connectedWalletId === walletId && this._walletModel.getProperty("/isConnected");
        },

        getNetwork: function () {
            var networkId = this._walletModel.getProperty("/networkId");
            if (networkId === null) return null;
            return NETWORK_IDS[networkId] || "preprod";
        },

        getPrimaryAddress: function () {
            var addresses = this._walletModel.getProperty("/addresses");
            return (addresses && addresses[0] && addresses[0].bech32) || null;
        },

        getChangeAddress: function () {
            return this._walletModel.getProperty("/changeAddress");
        },

        _setError: function (message) {
            this._walletModel.setProperty("/error", message);
            MessageToast.show(message);
        },

        _resetConnection: function () {
            this._enabledWallet = null;
            this._connectedWalletId = null;
            var availableWallets = this._walletModel.getProperty("/availableWallets");
            var state = JSON.parse(JSON.stringify(INITIAL_STATE));
            state.availableWallets = availableWallets;
            this._walletModel.setData(state);
        }
    };

    return {
        getInstance: function () {
            if (!_instance) {
                _instance = Object.create(WalletService);
                _instance._init();
            }
            return _instance;
        }
    };
});
