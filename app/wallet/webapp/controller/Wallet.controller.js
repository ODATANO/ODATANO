sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageBox",
    "sap/m/MessageToast",
    "sap/ui/core/Fragment",
    "sap/base/Log",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "odatanoview/wallet/service/WalletService",
    "odatanoview/wallet/model/formatter"
], function (Controller, JSONModel, MessageBox, MessageToast, Fragment, Log, Filter, FilterOperator, WalletService, formatter) {
    "use strict";

    // Bech32 address: prefix + "1" + bech32 chars (lowercase alphanumeric except 1, b, i, o)
    var BECH32_ADDRESS_RE = /^addr(_test)?1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{38,98}$/;
    // UUID v4 (signing request IDs)
    var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    function isValidBech32Address(s) {
        return typeof s === "string" && BECH32_ADDRESS_RE.test(s);
    }

    function isValidUuid(s) {
        return typeof s === "string" && UUID_RE.test(s);
    }

    var INITIAL_FLOW_STATE = {
        selectedTab: "dashboard",
        requests: { pending: [], verified: [], submitted: [] },
        counts: { pending: 0, verified: 0, submitted: 0 },
        selectedRequest: null,

        // Build form
        txType: "simple",
        senderAddress: "",
        recipientAddress: "",
        adaAmount: "",
        changeAddress: "",
        metadataJson: "",
        recipientAddressState: "None",
        recipientAddressStateText: "",
        amountState: "None",
        amountStateText: "",
        canBuild: false,
        buildBusy: false,
        buildError: null,

        // Build result
        build: null,
        buildInputs: [],
        buildOutputs: [],
        lovelaceAmount: null,

        // Signing state
        signingBusy: false,
        signBusy: false,
        signedTxCbor: null,
        manualCborInput: "",
        manualCborError: null,
        signMessage: null,
        signMessageType: "None",
        networkMismatch: false,

        // Verification / Submission
        verifyBusy: false,
        submitBusy: false,
        submitError: null,
        submissionPolling: false,

        // Expiration
        expirationText: "",
        expirationState: "Success",

        // Inspector
        inspectorByteCount: 0,
        inspectorInputCount: 0,
        inspectorOutputCount: 0
    };

    return Controller.extend("odatanoview.wallet.controller.Wallet", {

        formatter: formatter,

        // ===== Lifecycle =====

        onInit: function () {
            this._walletService = WalletService.getInstance();
            this._sendAdaDialog = null;

            this._flowModel = new JSONModel(JSON.parse(JSON.stringify(INITIAL_FLOW_STATE)));
            this.getView().setModel(this._flowModel, "flow");

            this._sendModel = new JSONModel({
                senderAddress: "",
                recipientAddress: "",
                adaAmount: "",
                availableBalance: "0",
                recipientAddressState: "None",
                recipientAddressStateText: "",
                amountState: "None",
                amountStateText: "",
                canContinue: false,
                error: null
            });
            this.getView().setModel(this._sendModel, "sendModel");

            this._expirationInterval = null;
            this._statusPollingInterval = null;
            this._expiresAtTimestamp = 0;
            this._requestLoadGeneration = 0;

            var that = this;
            this.getOwnerComponent().getRouter().getRoute("wallet").attachPatternMatched(function () {
                that._loadHsmStatus();
            });
        },

        onExit: function () {
            this._clearExpirationTimer();
            this._clearStatusPolling();
        },

        // ===== Connection =====

        _loadHsmStatus: function () {
            var oSignModel = this.getView().getModel("sign");
            var oHsmModel = this.getOwnerComponent().getModel("hsm");
            if (!oSignModel || !oHsmModel) return;

            oHsmModel.setProperty("/loading", true);

            oSignModel.getMetaModel().requestObject("/").then(function () {
                var oAction = oSignModel.bindContext("/GetHsmStatus(...)");
                oAction.execute("$direct").then(function () {
                    var oResult = oAction.getBoundContext().getObject();
                    oHsmModel.setProperty("/connected", oResult.connected || false);
                    oHsmModel.setProperty("/keyId", oResult.keyId || null);
                    oHsmModel.setProperty("/keyLabel", oResult.keyLabel || null);
                    oHsmModel.setProperty("/publicKeyHash", oResult.publicKeyHash || null);
                    oHsmModel.setProperty("/cardanoAddress", oResult.cardanoAddress || null);
                }).catch(function () {
                    oHsmModel.setProperty("/connected", false);
                }).finally(function () {
                    oHsmModel.setProperty("/loading", false);
                });
            });
        },

        onRefreshHsmStatus: function () {
            this._loadHsmStatus();
        },

        onHsmConnect: function () {
            var oHsmModel = this.getOwnerComponent().getModel("hsm");
            this._connectWithHsmAddress({
                connected: oHsmModel.getProperty("/connected"),
                keyId: oHsmModel.getProperty("/keyId"),
                keyLabel: oHsmModel.getProperty("/keyLabel"),
                publicKeyHash: oHsmModel.getProperty("/publicKeyHash"),
                cardanoAddress: oHsmModel.getProperty("/cardanoAddress")
            });
        },

        onManualAddressConnect: function () {
            var oWalletModel = this._walletService.getModel();
            var sAddress = (oWalletModel.getProperty("/manualAddress") || "").trim();

            if (!isValidBech32Address(sAddress)) {
                MessageBox.error("Please enter a valid Cardano address (addr_test1... or addr1...)");
                return;
            }

            var bIsTestnet = sAddress.startsWith("addr_test");
            oWalletModel.setProperty("/isConnected", true);
            oWalletModel.setProperty("/connectedVia", "manual");
            oWalletModel.setProperty("/walletName", "Manual Address");
            oWalletModel.setProperty("/walletIcon", "sap-icon://enter-more");
            oWalletModel.setProperty("/networkId", bIsTestnet ? 0 : 1);
            oWalletModel.setProperty("/networkName", bIsTestnet ? "Preview" : "Mainnet");
            oWalletModel.setProperty("/addresses", [{ bech32: sAddress, isUsed: true }]);
            oWalletModel.setProperty("/changeAddress", sAddress);
            oWalletModel.setProperty("/balance", { lovelace: "0", assets: [] });

            this._loadHsmBalance(sAddress);
            this._initFlowForWallet();
            this._loadDashboardData();
            this._loadAndCategorizeRequests();
        },

        _connectWithHsmAddress: function (oHsmResult) {
            var oWalletModel = this._walletService.getModel();
            var sAddress = oHsmResult.cardanoAddress;
            var bIsTestnet = sAddress && sAddress.startsWith("addr_test");

            oWalletModel.setProperty("/isConnected", true);
            oWalletModel.setProperty("/connectedVia", "hsm");
            oWalletModel.setProperty("/walletName", "HSM (" + (oHsmResult.keyLabel || "key") + ")");
            oWalletModel.setProperty("/walletIcon", "sap-icon://key");
            oWalletModel.setProperty("/networkId", bIsTestnet ? 0 : 1);
            oWalletModel.setProperty("/networkName", bIsTestnet ? "Preview" : "Mainnet");
            oWalletModel.setProperty("/addresses", [{ bech32: sAddress, isUsed: true }]);
            oWalletModel.setProperty("/changeAddress", sAddress);
            oWalletModel.setProperty("/balance", { lovelace: "0", assets: [] });

            this._loadHsmBalance(sAddress);
            this._initFlowForWallet();
            this._loadDashboardData();
            this._loadAndCategorizeRequests();
        },

        _loadHsmBalance: function (sAddress) {
            var oDataModel = this.getOwnerComponent().getModel();
            var oWalletModel = this._walletService.getModel();

            var oAction = oDataModel.bindContext("/GetAddressByBech32(...)");
            oAction.setParameter("address", sAddress);
            oAction.execute().then(function () {
                var oAddrBinding = oDataModel.bindContext("/Addresses('" + sAddress + "')");
                oAddrBinding.requestObject().then(function () {
                    var oAddr = oAddrBinding.getBoundContext().getObject();
                    oWalletModel.setProperty("/balance/lovelace", (oAddr && oAddr.totalLovelace) || "0");
                });
            }).catch(function () { /* silently ignore */ });
        },

        onWalletSelect: function (oEvent) {
            var oItem = oEvent.getParameter("listItem");
            var sWalletId = oItem ? oItem.getBindingContext("wallet").getProperty("id") : null;

            if (sWalletId) {
                var that = this;
                this._walletService.connect(sWalletId).then(function (bConnected) {
                    if (bConnected) {
                        that._walletService.getModel().setProperty("/connectedVia", "wallet");
                        that._initFlowForWallet();
                        that._loadDashboardData();
                        that._loadAndCategorizeRequests();
                    }
                });
            }
        },

        onDisconnect: function () {
            this._walletService.disconnect();
            this._resetFlow();
        },

        onRefreshWallet: function () {
            var that = this;
            this._walletService.refresh().then(function () {
                that._loadDashboardData();
                that._loadAndCategorizeRequests();
            });
        },

        _initFlowForWallet: function () {
            this._flowModel.setProperty("/senderAddress", this._walletService.getPrimaryAddress() || "");
            this._flowModel.setProperty("/changeAddress", this._walletService.getChangeAddress() || "");
        },

        // ===== Tab Navigation =====

        onTabSelect: function (oEvent) {
            var sKey = oEvent.getParameter("key");
            this._flowModel.setProperty("/selectedTab", sKey);
            this._clearSelectedRequest();

            if (sKey === "dashboard") {
                this._loadDashboardData();
            } else if (sKey !== "build") {
                this._loadAndCategorizeRequests();
            }
        },

        _switchToTab: function (sKey) {
            this._flowModel.setProperty("/selectedTab", sKey);
            var oTabBar = this.byId("mainTabBar");
            if (oTabBar) {
                oTabBar.setSelectedKey(sKey);
            }
        },

        // ===== Dashboard =====

        _loadDashboardData: function () {
            if (this._dashboardLoading) return;
            this._dashboardLoading = true;
            var that = this;
            // Ensure default OData model metadata is ready before calling actions
            var oDataModel = this.getView().getModel();
            if (oDataModel && oDataModel.getMetaModel) {
                oDataModel.getMetaModel().requestObject("/").then(function () {
                    that._loadUtxos();
                    that._loadTransactions();
                    that._loadAssets();
                }).catch(function () {
                    // Metadata failed — try loading directly as fallback
                    that._loadUtxos();
                    that._loadTransactions();
                    that._loadAssets();
                }).finally(function () {
                    that._dashboardLoading = false;
                });
            } else {
                this._loadUtxos();
                this._loadTransactions();
                this._loadAssets();
                this._dashboardLoading = false;
            }
            this._loadTransactionBuilds();
        },

        _loadUtxos: function () {
            var sPrimaryAddress = this._walletService.getPrimaryAddress();
            if (!sPrimaryAddress) return;

            var oDataModel = this.getView().getModel();
            if (!oDataModel) return;

            var that = this;
            var oAction = oDataModel.bindContext("/GetUTxOsByAddress(...)");
            oAction.setParameter("address", sPrimaryAddress);
            oAction.execute().then(function () {
                var oResult = oAction.getBoundContext().getObject();
                var aRaw = Array.isArray(oResult) ? oResult : (oResult && oResult.value ? oResult.value : []);

                var aUtxos = aRaw.map(function (oUtxo) {
                    var aAssets = [];
                    if (oUtxo.assets && Array.isArray(oUtxo.assets)) {
                        aAssets = oUtxo.assets.map(function (a) {
                            return {
                                unit: a.unit || "",
                                asset_policyId: (a.asset && a.asset.policyId) || a.asset_policyId || "",
                                asset_assetName: (a.asset && a.asset.assetName) || a.asset_assetName || "",
                                asset_quantity: (a.asset && a.asset.quantity) || a.asset_quantity || "0"
                            };
                        });
                    }
                    return {
                        hash: oUtxo.hash || "",
                        index: oUtxo.index || 0,
                        lovelace: oUtxo.lovelace || "0",
                        assets: aAssets,
                        expanded: false
                    };
                });
                // Deduplicate by hash+index (safety net for temporal DB versions)
                var oSeen = {};
                aUtxos = aUtxos.filter(function (oUtxo) {
                    var sKey = oUtxo.hash + "#" + oUtxo.index;
                    if (oSeen[sKey]) return false;
                    oSeen[sKey] = true;
                    return true;
                });
                that._walletService.getModel().setProperty("/utxos", aUtxos);
            }).catch(function (oError) {
                Log.warning("Failed to load UTxOs: " + (oError && oError.message));
            });
        },

        _loadAssets: function () {
            var sPrimaryAddress = this._walletService.getPrimaryAddress();
            if (!sPrimaryAddress) return;

            var oDataModel = this.getView().getModel();
            if (!oDataModel) return;

            var that = this;
            var oAction = oDataModel.bindContext("/GetAssetsByAddress(...)");
            oAction.setParameter("address", sPrimaryAddress);
            oAction.execute().then(function () {
                var oResult = oAction.getBoundContext().getObject();
                var aRaw = Array.isArray(oResult) ? oResult : (oResult && oResult.value ? oResult.value : []);
                var aAssets = aRaw.map(function (a) {
                    return {
                        policyId: (a.asset && a.asset.policyId) || a.asset_policyId || "",
                        assetName: (a.asset && a.asset.assetName) || a.asset_assetName || "",
                        displayName: (a.asset && a.asset.assetName) || a.asset_assetName || "(unnamed)",
                        quantity: (a.asset && a.asset.quantity) || a.asset_quantity || "0",
                        unit: a.unit || ""
                    };
                });
                that._walletService.getModel().setProperty("/assetsSummary", aAssets);
            }).catch(function (oError) {
                Log.warning("Failed to load assets: " + (oError && oError.message));
            });
        },

        _loadTransactions: function () {
            var sPrimaryAddress = this._walletService.getPrimaryAddress();
            if (!sPrimaryAddress) return;

            var oDataModel = this.getView().getModel();
            if (!oDataModel) return;

            var that = this;
            var oAction = oDataModel.bindContext("/GetLatestTransactionsByAddress(...)");
            oAction.setParameter("address", sPrimaryAddress);
            oAction.setParameter("limit", 20);
            oAction.execute().then(function () {
                var oResult = oAction.getBoundContext().getObject();
                var aRaw = Array.isArray(oResult) ? oResult : (oResult && oResult.value ? oResult.value : []);

                var aTransactions = aRaw.map(function (oData) {
                    var aAssets = [];
                    if (oData.netAssets) {
                        try { aAssets = JSON.parse(oData.netAssets); } catch (e) { aAssets = []; } // eslint-disable-line no-unused-vars
                    }
                    return {
                        txHash: oData.tx_hash || "",
                        timestamp: oData.blockTime || 0,
                        amount: String(oData.netAmount || 0),
                        hasAssets: oData.hasAssets || false,
                        assets: aAssets,
                        expanded: false,
                        isPending: false
                    };
                });
                that._walletService.getModel().setProperty("/transactions", aTransactions);
            }).catch(function (oError) {
                // Log error for debugging, don't crash the app
                Log.warning("Failed to load transactions: " + (oError && oError.message));
            });
        },

        _loadSigningRequests: function () {
            var sPrimaryAddress = this._walletService.getPrimaryAddress();
            if (!sPrimaryAddress) return;

            var oSignModel = this.getView().getModel("sign");
            if (!oSignModel) return;

            var that = this;
            if (!isValidBech32Address(sPrimaryAddress)) return;
            var oListBinding = oSignModel.bindList("/AddressSigningRequests", undefined, undefined,
                [new Filter("address_address", FilterOperator.EQ, sPrimaryAddress)], {
                $expand: "signingRequest"
            });
            oListBinding.requestContexts(0, 100).then(function (aContexts) {
                var aSigningRequests = aContexts.map(function (oCtx) {
                    var oSr = oCtx.getObject().signingRequest || {};
                    return {
                        id: oSr.id || "",
                        status: oSr.status || "unknown",
                        network: oSr.network || "",
                        createdAt: oSr.createdAt || "",
                        expiresAt: oSr.expiresAt || "",
                        signerType: oSr.signerType || "",
                        signerInfo: oSr.signerInfo || "",
                        txBodyHash: oSr.txBodyHash || ""
                    };
                });
                that._walletService.getModel().setProperty("/signingRequests", aSigningRequests);
            }).catch(function () {
                that._walletService.getModel().setProperty("/signingRequests", []);
            });
        },

        _loadTransactionBuilds: function () {
            var sPrimaryAddress = this._walletService.getPrimaryAddress();
            if (!sPrimaryAddress) return;

            var oTxModel = this.getView().getModel("tx");
            if (!oTxModel) return;

            var that = this;
            if (!isValidBech32Address(sPrimaryAddress)) return;
            var oListBinding = oTxModel.bindList("/AddressTransactionBuilds", undefined, undefined,
                [new Filter("address_address", FilterOperator.EQ, sPrimaryAddress)], {
                $expand: "txBuild"
            });
            oListBinding.requestContexts(0, 100).then(function (aContexts) {
                var aBuilds = aContexts.map(function (oCtx) {
                    var oBuild = oCtx.getObject().txBuild || {};
                    return {
                        id: oBuild.id || "",
                        network: oBuild.network || "",
                        senderAddress: oBuild.senderAddress || "",
                        changeAddress: oBuild.changeAddress || "",
                        fee: oBuild.fee || "0",
                        size: oBuild.size || 0,
                        createdAt: oBuild.createdAt || "",
                        wasSubmitted: oBuild.wasSubmitted || false,
                        txBodyHash: oBuild.txBodyHash || ""
                    };
                });
                that._walletService.getModel().setProperty("/transactionBuilds", aBuilds);
            }).catch(function () {
                that._walletService.getModel().setProperty("/transactionBuilds", []);
            });
        },

        // ===== Send ADA (Quick Dialog → Build Tab) =====

        onSendAda: function () {
            var sPrimaryAddress = this._walletService.getPrimaryAddress();
            var sBalance = this._walletService.getModel().getProperty("/balance/lovelace");

            if (!sPrimaryAddress) {
                MessageBox.warning("No address found in wallet");
                return;
            }

            this._sendModel.setData({
                senderAddress: sPrimaryAddress,
                recipientAddress: "",
                adaAmount: "",
                availableBalance: sBalance || "0",
                recipientAddressState: "None",
                recipientAddressStateText: "",
                amountState: "None",
                amountStateText: "",
                canContinue: false,
                error: null
            });

            var that = this;
            if (!this._sendAdaDialog) {
                Fragment.load({
                    id: this.getView().getId(),
                    name: "odatanoview.wallet.view.fragment.SendAda",
                    controller: this
                }).then(function (oDialog) {
                    that._sendAdaDialog = oDialog;
                    that.getView().addDependent(oDialog);
                    oDialog.open();
                });
            } else {
                this._sendAdaDialog.open();
            }
        },

        onSendRecipientChange: function (oEvent) {
            var sValue = (oEvent.getParameter("newValue") || "").trim();
            var bech32Charset = /^[a-z0-9_]+$/;

            if (!sValue) {
                this._sendModel.setProperty("/recipientAddressState", "None");
                this._sendModel.setProperty("/recipientAddressStateText", "");
            } else if (!sValue.startsWith("addr1") && !sValue.startsWith("addr_test1")) {
                this._sendModel.setProperty("/recipientAddressState", "Error");
                this._sendModel.setProperty("/recipientAddressStateText", "Must start with addr1 or addr_test1");
            } else if (!bech32Charset.test(sValue)) {
                this._sendModel.setProperty("/recipientAddressState", "Error");
                this._sendModel.setProperty("/recipientAddressStateText", "Contains invalid characters");
            } else if (sValue.length < 58) {
                this._sendModel.setProperty("/recipientAddressState", "Warning");
                this._sendModel.setProperty("/recipientAddressStateText", "Address seems incomplete");
            } else {
                this._sendModel.setProperty("/recipientAddressState", "Success");
                this._sendModel.setProperty("/recipientAddressStateText", "");
            }

            this._validateSendForm();
        },

        onSendAmountChange: function (oEvent) {
            var sValue = oEvent.getParameter("newValue");
            var nNumValue = parseFloat(sValue);
            var nAvailableAda = Number(BigInt(this._sendModel.getProperty("/availableBalance") || "0")) / 1000000;

            if (!sValue) {
                this._sendModel.setProperty("/amountState", "None");
                this._sendModel.setProperty("/amountStateText", "");
            } else if (isNaN(nNumValue) || nNumValue <= 0) {
                this._sendModel.setProperty("/amountState", "Error");
                this._sendModel.setProperty("/amountStateText", "Must be a positive number");
            } else if (nNumValue < 1) {
                this._sendModel.setProperty("/amountState", "Warning");
                this._sendModel.setProperty("/amountStateText", "Minimum is typically ~1 ADA");
            } else if (nNumValue > nAvailableAda) {
                this._sendModel.setProperty("/amountState", "Error");
                this._sendModel.setProperty("/amountStateText", "Exceeds available balance");
            } else {
                this._sendModel.setProperty("/amountState", "Success");
                this._sendModel.setProperty("/amountStateText", "");
            }

            this._validateSendForm();
        },

        _validateSendForm: function () {
            var sAddr = this._sendModel.getProperty("/recipientAddress") || "";
            var sAmt = this._sendModel.getProperty("/adaAmount") || "";

            var bIsValid =
                sAddr.length >= 58 &&
                (sAddr.startsWith("addr1") || sAddr.startsWith("addr_test1")) &&
                /^[a-z0-9_]+$/.test(sAddr) &&
                parseFloat(sAmt) > 0 &&
                this._sendModel.getProperty("/recipientAddressState") !== "Error" &&
                this._sendModel.getProperty("/amountState") !== "Error";

            this._sendModel.setProperty("/canContinue", bIsValid);
        },

        onContinueSend: function () {
            if (this._sendAdaDialog) {
                this._sendAdaDialog.close();
            }

            // Prefill Build tab form from Send ADA dialog values
            this._flowModel.setProperty("/recipientAddress", this._sendModel.getProperty("/recipientAddress"));
            this._flowModel.setProperty("/adaAmount", this._sendModel.getProperty("/adaAmount"));
            this._flowModel.setProperty("/recipientAddressState", "Success");
            this._flowModel.setProperty("/recipientAddressStateText", "");
            this._flowModel.setProperty("/amountState", "Success");
            this._flowModel.setProperty("/amountStateText", "");
            this._flowModel.setProperty("/canBuild", true);

            // Switch to Build tab and auto-build
            this._switchToTab("build");
            this.onBuildTransaction();
        },

        onCancelSend: function () {
            if (this._sendAdaDialog) {
                this._sendAdaDialog.close();
            }
        },

        // ===== Build Tab =====

        onTransactionTypeChange: function () {
            this._validateBuildForm();
        },

        onRecipientAddressChange: function (oEvent) {
            var sValue = (oEvent.getParameter("value") || oEvent.getParameter("newValue") || "").trim();
            this._flowModel.setProperty("/recipientAddress", sValue);
            var bech32Charset = /^[a-z0-9_]+$/;

            if (!sValue) {
                this._flowModel.setProperty("/recipientAddressState", "None");
                this._flowModel.setProperty("/recipientAddressStateText", "");
            } else if (!sValue.startsWith("addr1") && !sValue.startsWith("addr_test1")) {
                this._flowModel.setProperty("/recipientAddressState", "Error");
                this._flowModel.setProperty("/recipientAddressStateText", "Must start with addr1 or addr_test1");
            } else if (!bech32Charset.test(sValue)) {
                this._flowModel.setProperty("/recipientAddressState", "Error");
                this._flowModel.setProperty("/recipientAddressStateText", "Contains invalid characters");
            } else if (sValue.length < 58) {
                this._flowModel.setProperty("/recipientAddressState", "Warning");
                this._flowModel.setProperty("/recipientAddressStateText", "Address seems incomplete");
            } else {
                this._flowModel.setProperty("/recipientAddressState", "Success");
                this._flowModel.setProperty("/recipientAddressStateText", "");
            }

            this._validateBuildForm();
        },

        onAmountChange: function (oEvent) {
            var sValue = oEvent.getParameter("value") || oEvent.getParameter("newValue") || "";
            this._flowModel.setProperty("/adaAmount", sValue);
            var nNumValue = parseFloat(sValue);
            var sBalance = this._walletService.getModel().getProperty("/balance/lovelace") || "0";
            var nAvailableAda = parseInt(sBalance, 10) / 1000000;

            if (!sValue) {
                this._flowModel.setProperty("/amountState", "None");
                this._flowModel.setProperty("/amountStateText", "");
            } else if (isNaN(nNumValue) || nNumValue <= 0) {
                this._flowModel.setProperty("/amountState", "Error");
                this._flowModel.setProperty("/amountStateText", "Must be a positive number");
            } else if (nNumValue < 1) {
                this._flowModel.setProperty("/amountState", "Warning");
                this._flowModel.setProperty("/amountStateText", "Minimum is typically ~1 ADA");
            } else if (nNumValue > nAvailableAda) {
                this._flowModel.setProperty("/amountState", "Error");
                this._flowModel.setProperty("/amountStateText", "Exceeds available balance");
            } else {
                this._flowModel.setProperty("/amountState", "Success");
                this._flowModel.setProperty("/amountStateText", "");
            }

            this._validateBuildForm();
        },

        _validateBuildForm: function () {
            var sRecipient = this._flowModel.getProperty("/recipientAddress") || "";
            var sAmount = this._flowModel.getProperty("/adaAmount") || "";

            var bIsValid =
                sRecipient.length >= 58 &&
                (sRecipient.startsWith("addr1") || sRecipient.startsWith("addr_test1")) &&
                /^[a-z0-9_]+$/.test(sRecipient) &&
                parseFloat(sAmount) > 0 &&
                this._flowModel.getProperty("/recipientAddressState") !== "Error" &&
                this._flowModel.getProperty("/amountState") !== "Error";

            this._flowModel.setProperty("/canBuild", bIsValid);
        },

        onBuildTransaction: function () {
            var oTxModel = this.getView().getModel("tx");
            if (!oTxModel) return;

            var sTxType = this._flowModel.getProperty("/txType");
            var sSender = this._flowModel.getProperty("/senderAddress");
            var sRecipient = this._flowModel.getProperty("/recipientAddress");
            var nAda = parseFloat(this._flowModel.getProperty("/adaAmount"));
            var sLovelace = Math.floor(nAda * 1000000).toString();
            var sChange = this._flowModel.getProperty("/changeAddress") || sSender;

            this._flowModel.setProperty("/buildBusy", true);
            this._flowModel.setProperty("/buildError", null);
            this._flowModel.setProperty("/build", null);
            this._flowModel.setProperty("/lovelaceAmount", sLovelace);

            var sActionName = sTxType === "metadata"
                ? "/BuildTransactionWithMetadata(...)"
                : "/BuildSimpleAdaTransaction(...)";

            var oBuildAction = oTxModel.bindContext(sActionName);
            oBuildAction.setParameter("senderAddress", sSender);
            oBuildAction.setParameter("recipientAddress", sRecipient);
            oBuildAction.setParameter("lovelaceAmount", sLovelace);
            oBuildAction.setParameter("changeAddress", sChange);

            if (sTxType === "metadata") {
                oBuildAction.setParameter("metadataJson", this._flowModel.getProperty("/metadataJson") || "{}");
            }

            var that = this;
            oBuildAction.execute().then(function () {
                var oBuild = oBuildAction.getBoundContext().getObject();
                if (!oBuild || !oBuild.id) {
                    throw new Error("Build failed - no build ID returned");
                }

                that._flowModel.setProperty("/build", {
                    id: oBuild.id,
                    fee: oBuild.fee || "0",
                    txBodyHash: oBuild.txBodyHash || "",
                    unsignedTxCbor: oBuild.unsignedTxCbor || "",
                    network: oBuild.network || "",
                    size: oBuild.size || 0,
                    builderEngine: oBuild.builderEngine || "",
                    senderAddress: oBuild.senderAddress || "",
                    changeAddress: oBuild.changeAddress || ""
                });

                var sCbor = oBuild.unsignedTxCbor || "";
                that._flowModel.setProperty("/inspectorByteCount", Math.floor(sCbor.length / 2));
                that._loadBuildDetails(oTxModel, oBuild.id);
                that._loadUtxos();
            }).catch(function (oError) {
                that._flowModel.setProperty("/buildError", (oError && oError.message) || "Transaction build failed");
            }).finally(function () {
                that._flowModel.setProperty("/buildBusy", false);
            });
        },

        _loadBuildDetails: function (oTxModel, sBuildId) {
            var that = this;

            var oInputList = oTxModel.bindList("/TransactionBuildInputs", undefined, undefined, undefined, {
                $filter: "build_id eq '" + sBuildId + "'"
            });
            oInputList.requestContexts(0, 50).then(function (aContexts) {
                var aInputs = aContexts.map(function (oCtx) {
                    var o = oCtx.getObject();
                    return { txHash: o.txHash || "", outputIndex: o.outputIndex || 0, address: o.address || "", lovelace: o.lovelace || "0" };
                });
                that._flowModel.setProperty("/buildInputs", aInputs);
                that._flowModel.setProperty("/inspectorInputCount", aInputs.length);
            }).catch(function () {
                that._flowModel.setProperty("/buildInputs", []);
                that._flowModel.setProperty("/inspectorInputCount", 0);
            });

            var oOutputList = oTxModel.bindList("/TransactionBuildOutputs", undefined, undefined, undefined, {
                $filter: "build_id eq '" + sBuildId + "'"
            });
            oOutputList.requestContexts(0, 50).then(function (aContexts) {
                var aOutputs = aContexts.map(function (oCtx) {
                    var o = oCtx.getObject();
                    return { address: o.address || "", lovelace: o.lovelace || "0", isChange: o.isChange || false };
                });
                that._flowModel.setProperty("/buildOutputs", aOutputs);
                that._flowModel.setProperty("/inspectorOutputCount", aOutputs.length);
            }).catch(function () {
                that._flowModel.setProperty("/buildOutputs", []);
                that._flowModel.setProperty("/inspectorOutputCount", 0);
            });
        },

        // ===== Build → Pending =====

        onContinueToSigning: function () {
            var oSignModel = this.getView().getModel("sign");
            var sBuildId = this._flowModel.getProperty("/build/id");
            if (!oSignModel || !sBuildId) return;

            this._flowModel.setProperty("/signingBusy", true);
            var oSigningAction = oSignModel.bindContext("/CreateSigningRequest(...)");
            oSigningAction.setParameter("buildId", sBuildId);

            var that = this;
            oSigningAction.execute().then(function () {
                var oSR = oSigningAction.getBoundContext().getObject();
                if (!oSR || !oSR.id) throw new Error("Failed to create signing request");

                var sNewId = oSR.id;
                return that._loadAndCategorizeRequests().then(function () {
                    that._switchToTab("pending");

                    var aPending = that._flowModel.getProperty("/requests/pending") || [];
                    for (var i = 0; i < aPending.length; i++) {
                        if (aPending[i].id === sNewId) {
                            var oNewReq = JSON.parse(JSON.stringify(aPending[i]));
                            that._selectRequest(oNewReq);
                            that._startExpirationCountdown(oNewReq.expiresAt);
                            break;
                        }
                    }
                });
            }).catch(function (oError) {
                MessageBox.error((oError && oError.message) || "Failed to create signing request");
            }).finally(function () {
                that._flowModel.setProperty("/signingBusy", false);
            });
        },

        // ===== HSM Sign =====

        onSignBuildWithHsm: function () {
            var oSignModel = this.getView().getModel("sign");
            var sBuildId = this._flowModel.getProperty("/build/id");
            if (!oSignModel || !sBuildId) return;

            this._flowModel.setProperty("/signingBusy", true);
            this._performHsmSign(oSignModel, sBuildId, "signingBusy");
        },

        onSignPendingWithHsm: function () {
            var oSignModel = this.getView().getModel("sign");
            var sBuildId = this._flowModel.getProperty("/build/id")
                || this._flowModel.getProperty("/selectedRequest/build_id");
            if (!oSignModel || !sBuildId) {
                MessageBox.warning("No build available. Please build a transaction first.");
                return;
            }

            this._flowModel.setProperty("/signBusy", true);
            this._flowModel.setProperty("/signMessage", "Signing with HSM...");
            this._flowModel.setProperty("/signMessageType", "Information");
            this._performHsmSign(oSignModel, sBuildId, "signBusy");
        },

        _performHsmSign: function (oSignModel, sBuildId, sBusyProp) {
            var oHsmAction = oSignModel.bindContext("/SignWithHsm(...)");
            oHsmAction.setParameter("buildId", sBuildId);

            var that = this;
            oHsmAction.execute().then(function () {
                var oSR = oHsmAction.getBoundContext().getObject();
                if (!oSR || !oSR.id) throw new Error("HSM signing failed");

                var sNewId = oSR.id;
                var sSignedCbor = null;

                return that._loadSignedCborForRequest(oSignModel, sNewId).then(function () {
                    sSignedCbor = that._flowModel.getProperty("/signedTxCbor");
                    MessageToast.show("Signed with HSM!");
                    return that._loadAndCategorizeRequests();
                }).then(function () {
                    that._switchToTab("verified");

                    var aVerified = that._flowModel.getProperty("/requests/verified") || [];
                    for (var i = 0; i < aVerified.length; i++) {
                        if (aVerified[i].id === sNewId) {
                            var oVerifiedReq = JSON.parse(JSON.stringify(aVerified[i]));
                            if (that._hsmVerification) {
                                oVerifiedReq.verification = that._hsmVerification;
                            }
                            that._selectRequest(oVerifiedReq);
                            break;
                        }
                    }
                    if (sSignedCbor) {
                        that._flowModel.setProperty("/signedTxCbor", sSignedCbor);
                    }
                    if (that._hsmVerification) {
                        that._flowModel.setProperty("/selectedRequest/verification", that._hsmVerification);
                        that._hsmVerification = null;
                    }
                });
            }).catch(function (oError) {
                var sMsg = (oError && oError.message) || "HSM signing failed";
                if (sBusyProp === "signBusy") {
                    that._flowModel.setProperty("/signMessage", sMsg);
                    that._flowModel.setProperty("/signMessageType", "Error");
                } else {
                    MessageBox.error(sMsg);
                }
            }).finally(function () {
                that._flowModel.setProperty("/" + sBusyProp, false);
            });
        },

        _loadSignedCborForRequest: function (oSignModel, sSigningRequestId) {
            var that = this;
            if (!isValidUuid(sSigningRequestId)) {
                return Promise.reject(new Error("Invalid signing request ID"));
            }
            var sUrl = oSignModel.getServiceUrl() +
                "SignatureVerifications?$filter=signingRequest_id eq '" + encodeURIComponent(sSigningRequestId) +
                "'&$select=signedTxCbor,isValid,witnessCount,signerKeyHashes,txBodyHash&$top=1";
            return fetch(sUrl, { headers: { "Accept": "application/json" } })
                .then(function (response) { return response.json(); })
                .then(function (data) {
                    if (data.value && data.value.length > 0) {
                        var oVerif = data.value[0];
                        if (oVerif.signedTxCbor) {
                            that._flowModel.setProperty("/signedTxCbor", oVerif.signedTxCbor);
                        }
                        var aKeyHashes = [];
                        if (oVerif.signerKeyHashes) {
                            try { aKeyHashes = JSON.parse(oVerif.signerKeyHashes); } catch (e) { aKeyHashes = []; } // eslint-disable-line no-unused-vars
                        }
                        that._hsmVerification = {
                            isValid: oVerif.isValid || false,
                            witnessCount: oVerif.witnessCount || 0,
                            signerKeyHashes: aKeyHashes,
                            txBodyHash: oVerif.txBodyHash || ""
                        };
                    } else {
                        that._hsmVerification = null;
                    }
                }).catch(function () {
                    that._hsmVerification = null;
                });
        },

        // ===== Request Loading & Selection =====

        _loadAndCategorizeRequests: function () {
            var sPrimaryAddress = this._walletService.getPrimaryAddress();
            if (!sPrimaryAddress) return Promise.resolve();

            var oSignModel = this.getView().getModel("sign");
            if (!oSignModel) return Promise.resolve();

            // Race condition guard: discard stale results
            var iGeneration = ++this._requestLoadGeneration;
            var that = this;
            if (!isValidBech32Address(sPrimaryAddress)) return Promise.resolve();
            var oListBinding = oSignModel.bindList("/AddressSigningRequests", undefined, undefined,
                [new Filter("address_address", FilterOperator.EQ, sPrimaryAddress)], {
                $expand: "signingRequest"
            });

            return oListBinding.requestContexts(0, 100).then(function (aContexts) {
                if (iGeneration !== that._requestLoadGeneration) return;

                var aAll = aContexts.map(function (oCtx) { return oCtx.getObject().signingRequest || {}; });

                var aPending = [], aVerified = [], aSubmitted = [];
                var sortDesc = function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); };

                aAll.forEach(function (oSr) {
                    if (!oSr || !oSr.id) return;
                    var r = {
                        id: oSr.id, build_id: oSr.build_id || "", status: oSr.status || "unknown",
                        createdAt: oSr.createdAt || "", expiresAt: oSr.expiresAt || "",
                        txBodyHash: oSr.txBodyHash || "", unsignedTxCbor: oSr.unsignedTxCbor || "",
                        cip30TxCbor: oSr.cip30TxCbor || "", network: oSr.network || "",
                        cardanoCliCommand: oSr.cardanoCliCommand || "",
                        signerType: oSr.signerType || "", signerInfo: oSr.signerInfo || ""
                    };
                    switch (r.status) {
                        case "pending": aPending.push(r); break;
                        case "verified": aVerified.push(r); break;
                        case "submitted": case "confirmed": case "expired": case "failed":
                            aSubmitted.push(r); break;
                    }
                });

                aPending.sort(sortDesc); aVerified.sort(sortDesc); aSubmitted.sort(sortDesc);

                that._flowModel.setProperty("/requests/pending", aPending);
                that._flowModel.setProperty("/requests/verified", aVerified);
                that._flowModel.setProperty("/requests/submitted", aSubmitted);
                that._flowModel.setProperty("/counts/pending", aPending.length);
                that._flowModel.setProperty("/counts/verified", aVerified.length);
                that._flowModel.setProperty("/counts/submitted", aSubmitted.length);

                // Also populate wallet>/signingRequests (replaces separate _loadSigningRequests call)
                var aSigningRequests = aAll.filter(function (oSr) { return oSr.id; }).map(function (oSr) {
                    return {
                        id: oSr.id || "", status: oSr.status || "unknown",
                        network: oSr.network || "", createdAt: oSr.createdAt || "",
                        expiresAt: oSr.expiresAt || "", signerType: oSr.signerType || "",
                        signerInfo: oSr.signerInfo || "", txBodyHash: oSr.txBodyHash || ""
                    };
                });
                that._walletService.getModel().setProperty("/signingRequests", aSigningRequests);
            }).catch(function () {
                if (iGeneration !== that._requestLoadGeneration) return;
                that._flowModel.setProperty("/requests/pending", []);
                that._flowModel.setProperty("/requests/verified", []);
                that._flowModel.setProperty("/requests/submitted", []);
                that._flowModel.setProperty("/counts/pending", 0);
                that._flowModel.setProperty("/counts/verified", 0);
                that._flowModel.setProperty("/counts/submitted", 0);
            });
        },

        onRefreshRequests: function () {
            this._loadAndCategorizeRequests();
            MessageToast.show("Refreshing...");
        },

        onPendingRequestSelect: function (oEvent) {
            var oCtx = (oEvent.getParameter("listItem") || {}).getBindingContext && oEvent.getParameter("listItem").getBindingContext("flow");
            if (!oCtx) return;
            var oRequest = JSON.parse(JSON.stringify(oCtx.getObject()));
            this._selectRequest(oRequest);
            this._startExpirationCountdown(oRequest.expiresAt);
        },

        onVerifiedRequestSelect: function (oEvent) {
            var oCtx = (oEvent.getParameter("listItem") || {}).getBindingContext && oEvent.getParameter("listItem").getBindingContext("flow");
            if (!oCtx) return;
            this._selectRequest(JSON.parse(JSON.stringify(oCtx.getObject())));
        },

        onSubmittedRequestSelect: function (oEvent) {
            var oCtx = (oEvent.getParameter("listItem") || {}).getBindingContext && oEvent.getParameter("listItem").getBindingContext("flow");
            if (!oCtx) return;
            var oRequest = JSON.parse(JSON.stringify(oCtx.getObject()));
            this._selectRequest(oRequest);
            if (oRequest.status === "submitted" || oRequest.status === "confirmed") {
                this._loadSubmissionDetails(oRequest.id);
            }
        },

        _selectRequest: function (oRequest) {
            this._clearSelectedRequest();
            oRequest.networkMismatch = this._walletService.getNetwork() !== null && this._walletService.getNetwork() !== oRequest.network;
            if (!oRequest.verification) { oRequest.verification = { isValid: false, witnessCount: 0, signerKeyHashes: [], txBodyHash: "" }; }
            if (!oRequest.submission) { oRequest.submission = { id: "", txHash: "", status: "" }; }

            this._flowModel.setProperty("/selectedRequest", oRequest);
            this._flowModel.setProperty("/networkMismatch", oRequest.networkMismatch);
            this._flowModel.setProperty("/inspectorByteCount", Math.floor((oRequest.cip30TxCbor || oRequest.unsignedTxCbor || "").length / 2));
        },

        _clearSelectedRequest: function () {
            this._clearExpirationTimer();
            this._clearStatusPolling();
            this._flowModel.setProperty("/selectedRequest", null);
            this._flowModel.setProperty("/signBusy", false);
            this._flowModel.setProperty("/signMessage", null);
            this._flowModel.setProperty("/signMessageType", "None");
            this._flowModel.setProperty("/manualCborInput", "");
            this._flowModel.setProperty("/manualCborError", null);
            this._flowModel.setProperty("/submitError", null);
            this._flowModel.setProperty("/signedTxCbor", null);
            this._flowModel.setProperty("/networkMismatch", false);
            this._flowModel.setProperty("/verifyBusy", false);
            this._flowModel.setProperty("/expirationText", "");
            this._flowModel.setProperty("/expirationState", "Success");
        },

        _loadSubmissionDetails: function (sSigningRequestId) {
            var oSignModel = this.getView().getModel("sign");
            if (!oSignModel) return;

            var that = this;
            var oSrBinding = oSignModel.bindContext("/SigningRequests('" + sSigningRequestId + "')", undefined, { $expand: "submission" });
            oSrBinding.requestObject().then(function () {
                var oSr = oSrBinding.getBoundContext().getObject();
                if (oSr && oSr.submission) {
                    that._flowModel.setProperty("/selectedRequest/submission", {
                        id: oSr.submission.id || "", txHash: oSr.submission.txHash || "",
                        status: oSr.submission.status || "submitted", submittedAt: oSr.submission.submittedAt || ""
                    });
                    if (oSr.submission.status === "submitted") {
                        that._startStatusPolling(oSr.submission.id);
                    }
                }
            }).catch(function () { /* ignore */ });
        },

        // ===== Sign Actions =====

        onSignSelectedWithWallet: function () {
            var oSelectedRequest = this._flowModel.getProperty("/selectedRequest");
            if (!oSelectedRequest) return;

            this._flowModel.setProperty("/signBusy", true);
            this._flowModel.setProperty("/signMessage", "Requesting signature from wallet...");
            this._flowModel.setProperty("/signMessageType", "Information");

            var that = this;
            this._walletService.signTransaction({
                unsignedTxCbor: oSelectedRequest.cip30TxCbor || oSelectedRequest.unsignedTxCbor,
                txBodyHash: oSelectedRequest.txBodyHash
            }, true).then(function (oResult) {
                if (!oResult.success || !oResult.signedTxCbor) throw new Error(oResult.error || "Signing failed");

                that._flowModel.setProperty("/signedTxCbor", oResult.signedTxCbor);
                that._flowModel.setProperty("/signMessage", "Signed! Verifying...");
                that._flowModel.setProperty("/signMessageType", "Success");

                that._performVerificationForSelected(
                    oResult.signedTxCbor, "browser-wallet",
                    that._walletService.getModel().getProperty("/walletName") || ""
                );
            }).catch(function (oError) {
                that._flowModel.setProperty("/signMessage", (oError && oError.message) || "Signing failed");
                that._flowModel.setProperty("/signMessageType", "Error");
            }).finally(function () {
                that._flowModel.setProperty("/signBusy", false);
            });
        },

        onSubmitManualCborForSelected: function () {
            var sCbor = (this._flowModel.getProperty("/manualCborInput") || "").trim();
            if (!sCbor || sCbor.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(sCbor)) {
                this._flowModel.setProperty("/manualCborError", "Invalid hex: must be an even number of hex characters");
                return;
            }
            this._flowModel.setProperty("/manualCborError", null);
            this._flowModel.setProperty("/signedTxCbor", sCbor);
            MessageToast.show("Signed CBOR accepted, verifying...");
            this._performVerificationForSelected(sCbor, "cardano-cli", "manual-paste");
        },

        // ===== Verify =====

        _performVerificationForSelected: function (sSignedCbor, sSignerType, sSignerInfo) {
            var oSignModel = this.getView().getModel("sign");
            var oSelectedRequest = this._flowModel.getProperty("/selectedRequest");
            if (!oSignModel || !oSelectedRequest) return;

            this._flowModel.setProperty("/verifyBusy", true);
            var oVerifyAction = oSignModel.bindContext("/VerifySignature(...)");
            oVerifyAction.setParameter("signingRequestId", oSelectedRequest.id);
            oVerifyAction.setParameter("signedTxCbor", sSignedCbor);
            oVerifyAction.setParameter("signerType", sSignerType || "browser-wallet");
            oVerifyAction.setParameter("signerInfo", sSignerInfo || "");

            var that = this;
            oVerifyAction.execute().then(function () {
                var oResult = oVerifyAction.getBoundContext().getObject();
                var aKeyHashes = [];
                if (oResult.signerKeyHashes) {
                    try { aKeyHashes = JSON.parse(oResult.signerKeyHashes); } catch (e) { aKeyHashes = []; } // eslint-disable-line no-unused-vars
                }

                if (oResult && oResult.isValid) {
                    MessageToast.show("Signature verified successfully");
                    that._loadAndCategorizeRequests().then(function () {
                        that._switchToTab("verified");
                        var aVerified = that._flowModel.getProperty("/requests/verified") || [];
                        for (var i = 0; i < aVerified.length; i++) {
                            if (aVerified[i].id === oSelectedRequest.id) {
                                var oVerifiedReq = JSON.parse(JSON.stringify(aVerified[i]));
                                oVerifiedReq.verification = { isValid: true, witnessCount: oResult.witnessCount || 0, signerKeyHashes: aKeyHashes, txBodyHash: oResult.txBodyHash || "" };
                                that._selectRequest(oVerifiedReq);
                                that._flowModel.setProperty("/signedTxCbor", sSignedCbor);
                                break;
                            }
                        }
                    });
                } else {
                    that._flowModel.setProperty("/signMessage", "Verification failed: " + ((oResult && oResult.errorMessage) || "Unknown error"));
                    that._flowModel.setProperty("/signMessageType", "Error");
                }
            }).catch(function (oError) {
                that._flowModel.setProperty("/signMessage", "Verification error: " + ((oError && oError.message) || "Unknown"));
                that._flowModel.setProperty("/signMessageType", "Error");
            }).finally(function () {
                that._flowModel.setProperty("/verifyBusy", false);
            });
        },

        // ===== Submit =====

        onSubmitSelectedTransaction: function () {
            var oSignModel = this.getView().getModel("sign");
            var oSelectedRequest = this._flowModel.getProperty("/selectedRequest");
            var sSignedCbor = this._flowModel.getProperty("/signedTxCbor");

            if (!oSignModel || !oSelectedRequest) return;
            if (!sSignedCbor) {
                this._flowModel.setProperty("/submitError", "No signed transaction data available. Please sign the transaction first.");
                return;
            }

            this._flowModel.setProperty("/submitBusy", true);
            this._flowModel.setProperty("/submitError", null);

            var oSubmitAction = oSignModel.bindContext("/SubmitVerifiedTransaction(...)");
            oSubmitAction.setParameter("signingRequestId", oSelectedRequest.id);
            oSubmitAction.setParameter("signedTxCbor", sSignedCbor);
            oSubmitAction.setParameter("signerType", oSelectedRequest.signerType || "browser-wallet");
            oSubmitAction.setParameter("signerInfo", oSelectedRequest.signerInfo || "");

            var that = this;
            oSubmitAction.execute().then(function () {
                var oResult = oSubmitAction.getBoundContext().getObject();
                MessageToast.show("Transaction submitted!");

                that._loadAndCategorizeRequests().then(function () {
                    that._switchToTab("submitted");
                    var aSubmitted = that._flowModel.getProperty("/requests/submitted") || [];
                    for (var i = 0; i < aSubmitted.length; i++) {
                        if (aSubmitted[i].id === oSelectedRequest.id) {
                            var oSubReq = JSON.parse(JSON.stringify(aSubmitted[i]));
                            oSubReq.submission = {
                                id: oResult.id || "", txHash: oResult.txHash || "",
                                status: oResult.status || "submitted", submittedAt: oResult.submittedAt || ""
                            };
                            that._selectRequest(oSubReq);
                            that._startStatusPolling(oResult.id);
                            break;
                        }
                    }
                });

                // Clear inspector / build state so the submitted tx doesn't linger
                that._flowModel.setProperty("/build", null);
                that._flowModel.setProperty("/buildInputs", []);
                that._flowModel.setProperty("/buildOutputs", []);
                that._flowModel.setProperty("/inspectorByteCount", 0);
                that._flowModel.setProperty("/inspectorInputCount", 0);
                that._flowModel.setProperty("/inspectorOutputCount", 0);

                // Optimistically prepend the just-submitted tx to Recent Transactions
                // (blockchain indexer won't have it yet — takes at least one block)
                if (oResult.txHash) {
                    var aExisting = that._walletService.getModel().getProperty("/transactions") || [];
                    var bAlreadyPresent = aExisting.some(function (t) { return t.txHash === oResult.txHash; });
                    if (!bAlreadyPresent) {
                        aExisting.unshift({
                            txHash: oResult.txHash,
                            timestamp: Math.floor(Date.now() / 1000),
                            amount: "0",
                            hasAssets: false,
                            assets: [],
                            expanded: false,
                            isPending: true
                        });
                        that._walletService.getModel().setProperty("/transactions", aExisting);
                    }
                }

                that._walletService.refresh();
                that._loadUtxos();
                that._loadTransactionBuilds();
            }).catch(function (oError) {
                that._flowModel.setProperty("/submitError", (oError && oError.message) || "Submission failed");
            }).finally(function () {
                that._flowModel.setProperty("/submitBusy", false);
            });
        },

        onViewSelectedOnCardanoscan: function () {
            var sTxHash = this._flowModel.getProperty("/selectedRequest/submission/txHash");
            var sNetwork = this._flowModel.getProperty("/selectedRequest/network") || "preview";
            if (!sTxHash) return;
            var sBase = sNetwork === "mainnet" ? "https://cardanoscan.io" : "https://" + sNetwork + ".cardanoscan.io";
            window.open(sBase + "/transaction/" + sTxHash, "_blank");
        },

        onNewTransaction: function () {
            this._clearSelectedRequest();
            this._flowModel.setProperty("/build", null);
            this._flowModel.setProperty("/buildError", null);
            this._flowModel.setProperty("/buildBusy", false);
            this._flowModel.setProperty("/buildInputs", []);
            this._flowModel.setProperty("/buildOutputs", []);
            this._flowModel.setProperty("/recipientAddress", "");
            this._flowModel.setProperty("/adaAmount", "");
            this._flowModel.setProperty("/canBuild", false);
            this._flowModel.setProperty("/recipientAddressState", "None");
            this._flowModel.setProperty("/recipientAddressStateText", "");
            this._flowModel.setProperty("/amountState", "None");
            this._flowModel.setProperty("/amountStateText", "");
            this._flowModel.setProperty("/lovelaceAmount", null);
            this._switchToTab("build");
            this._initFlowForWallet();
        },

        // ===== Timers =====

        _startExpirationCountdown: function (sExpiresAt) {
            this._clearExpirationTimer();
            if (!sExpiresAt) return;

            this._expiresAtTimestamp = new Date(sExpiresAt).getTime();
            if (isNaN(this._expiresAtTimestamp)) return;

            var that = this;
            this._updateExpirationDisplay();
            this._expirationInterval = setInterval(function () { that._updateExpirationDisplay(); }, 1000);
        },

        _updateExpirationDisplay: function () {
            var iRemaining = Math.max(0, this._expiresAtTimestamp - Date.now());
            var iMinutes = Math.floor(iRemaining / 60000);
            var iSeconds = Math.floor((iRemaining % 60000) / 1000);

            this._flowModel.setProperty("/expirationText", iMinutes + ":" + (iSeconds < 10 ? "0" : "") + iSeconds);
            this._flowModel.setProperty("/expirationState", iRemaining > 300000 ? "Success" : iRemaining > 60000 ? "Warning" : "Error");

            if (iRemaining <= 0) {
                this._clearExpirationTimer();
                this._flowModel.setProperty("/expirationText", "Expired");
                this._flowModel.setProperty("/expirationState", "Error");
            }
        },

        _clearExpirationTimer: function () {
            if (this._expirationInterval) { clearInterval(this._expirationInterval); this._expirationInterval = null; }
        },

        _startStatusPolling: function (sSubmissionId) {
            this._clearStatusPolling();
            if (!sSubmissionId) return;

            var that = this;
            var iPollCount = 0;
            this._flowModel.setProperty("/submissionPolling", true);

            this._statusPollingInterval = setInterval(function () {
                if (++iPollCount > 30) { that._clearStatusPolling(); return; }

                var oTxModel = that.getView().getModel("tx");
                if (!oTxModel) return;

                var oCheckAction = oTxModel.bindContext("/TransactionSubmissions('" + sSubmissionId + "')/CardanoTransactionService.CheckSubmissionStatus(...)");
                oCheckAction.execute().then(function () {
                    var oResult = oCheckAction.getBoundContext().getObject();
                    if (oResult && oResult.status) {
                        that._flowModel.setProperty("/selectedRequest/submission/status", oResult.status);
                        that._flowModel.setProperty("/selectedRequest/status", oResult.status === "confirmed" ? "confirmed" : "submitted");
                        if (oResult.status === "confirmed") {
                            that._clearStatusPolling();
                            MessageToast.show("Transaction confirmed on-chain!");
                            that._loadAndCategorizeRequests();
                        }
                    }
                }).catch(function () { /* silently continue */ });
            }, 10000);
        },

        _clearStatusPolling: function () {
            if (this._statusPollingInterval) { clearInterval(this._statusPollingInterval); this._statusPollingInterval = null; }
            this._flowModel.setProperty("/submissionPolling", false);
        },

        // ===== Clipboard Utilities =====

        _copy: function (sText, sMsg) {
            if (sText) { navigator.clipboard.writeText(sText).then(function () { MessageToast.show(sMsg || "Copied"); }); }
        },

        onCopyAddress: function () { this._copy(this._walletService.getPrimaryAddress(), "Address copied"); },
        onCopyBuildCbor: function () { this._copy(this._flowModel.getProperty("/build/unsignedTxCbor"), "CBOR copied"); },
        onCopyBuildTxHash: function () { this._copy(this._flowModel.getProperty("/build/txBodyHash") || this._flowModel.getProperty("/selectedRequest/txBodyHash"), "Hash copied"); },
        onCopySelectedRequestId: function () { this._copy(this._flowModel.getProperty("/selectedRequest/id"), "ID copied"); },
        onCopyUnsignedCbor: function () { this._copy(this._flowModel.getProperty("/selectedRequest/unsignedTxCbor"), "Unsigned CBOR copied"); },
        onCopySelectedTxHash: function () { this._copy(this._flowModel.getProperty("/selectedRequest/txBodyHash"), "Hash copied"); },
        onCopySelectedSubmissionTxHash: function () { this._copy(this._flowModel.getProperty("/selectedRequest/submission/txHash"), "Transaction hash copied"); },

        onCopyInspectorCbor: function () {
            this._copy(
                this._flowModel.getProperty("/selectedRequest/unsignedTxCbor") ||
                this._flowModel.getProperty("/selectedRequest/cip30TxCbor") ||
                this._flowModel.getProperty("/build/unsignedTxCbor"),
                "CBOR copied"
            );
        },

        onCopyKeyHash: function (oEvent) {
            var oCtx = oEvent.getSource().getBindingContext("flow");
            this._copy(oCtx ? oCtx.getObject() : null, "Key hash copied");
        },

        onToggleUtxoDetail: function (oEvent) {
            var oCtx = oEvent.getSource().getBindingContext("wallet");
            if (oCtx) {
                var sPath = oCtx.getPath() + "/expanded";
                var bCurrent = this._walletService.getModel().getProperty(sPath);
                this._walletService.getModel().setProperty(sPath, !bCurrent);
            }
        },

        onToggleTxDetail: function (oEvent) {
            var oCtx = oEvent.getSource().getBindingContext("wallet");
            if (oCtx) {
                var sPath = oCtx.getPath() + "/expanded";
                var bCurrent = this._walletService.getModel().getProperty(sPath);
                this._walletService.getModel().setProperty(sPath, !bCurrent);
            }
        },

        onCopyUtxoHash: function (oEvent) {
            var oCtx = oEvent.getSource().getBindingContext("wallet");
            if (oCtx) { this._copy(oCtx.getProperty("hash"), "UTxO hash copied"); }
        },

        onCopyTxHash: function (oEvent) {
            var oCtx = oEvent.getSource().getBindingContext("wallet");
            if (oCtx) { this._copy(oCtx.getProperty("txHash"), "Transaction hash copied"); }
        },

        onTransactionItemPress: function (oEvent) {
            var oCtx = oEvent.getSource().getBindingContext("wallet");
            var sTxHash = oCtx ? oCtx.getProperty("txHash") : null;
            if (sTxHash) {
                this.getOwnerComponent().getRouter().navTo("transactionDetail", { txHash: sTxHash });
            }
        },

        onSigningRequestItemPress: function (oEvent) {
            var sId = oEvent.getSource().getBindingContext("wallet").getProperty("id");
            if (sId) {
                this.getOwnerComponent().getRouter().navTo("signingRequestDetail", { requestId: sId });
            }
        },

        onTransactionBuildItemPress: function (oEvent) {
            var sId = oEvent.getSource().getBindingContext("wallet").getProperty("id");
            if (sId) {
                this.getOwnerComponent().getRouter().navTo("buildDetail", { buildId: sId });
            }
        },

        // ===== Reset =====

        _resetFlow: function () {
            this._clearExpirationTimer();
            this._clearStatusPolling();
            this._flowModel.setData(JSON.parse(JSON.stringify(INITIAL_FLOW_STATE)));
        }
    });
});
