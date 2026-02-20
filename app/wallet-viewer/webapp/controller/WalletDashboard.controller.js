sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageBox",
    "sap/m/MessageToast",
    "sap/ui/core/Fragment",
    "odatano/common/wallet/WalletService",
    "odatano/common/model/formatter"
], function (Controller, JSONModel, MessageBox, MessageToast, Fragment, WalletService, formatter) {
    "use strict";

    /**
     * Wallet Dashboard Controller
     * @namespace odatanoview.walletviewer.controller
     */
    return Controller.extend("odatanoview.walletviewer.controller.WalletDashboard", {

        formatter: formatter,

        onInit: function () {
            this._walletService = WalletService.getInstance();
            this._sendAdaDialog = null;
            this._signTransactionDialog = null;

            this._walletService.detectWallets();

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

            this._signingModel = new JSONModel({
                busy: false,
                signed: false,
                buildId: null,
                signingRequestId: null,
                txBodyHash: null,
                unsignedTxCbor: null,
                recipientAddress: null,
                lovelaceAmount: null,
                network: null,
                networkMismatch: false,
                statusMessage: null,
                statusType: "None",
                dialogState: "None"
            });
            this.getView().setModel(this._signingModel, "signing");
        },

        // --- Wallet Connection ---

        onWalletSelect: function (oEvent) {
            var oItem = oEvent.getParameter("listItem");
            var sWalletId = oItem ? oItem.getBindingContext("wallet").getProperty("id") : null;

            if (sWalletId) {
                var that = this;
                this._walletService.connect(sWalletId).then(function (bConnected) {
                    if (bConnected) {
                        that._loadTransactions();
                        that._loadSigningRequests();
                        that._loadTransactionBuilds();
                    }
                });
            }
        },

        onDisconnect: function () {
            this._walletService.disconnect();
        },

        onRefreshWallet: function () {
            var that = this;
            this._walletService.refresh().then(function () {
                that._loadTransactions();
                that._loadSigningRequests();
                that._loadTransactionBuilds();
            });
        },

        _loadTransactions: function () {
            var sPrimaryAddress = this._walletService.getPrimaryAddress();
            if (!sPrimaryAddress) return;

            var oView = this.getView();
            var oDataModel = oView.getModel();
            if (!oDataModel) return;

            var that = this;

            var oIndexAction = oDataModel.bindContext("/GetAddressByBech32(...)");
            oIndexAction.setParameter("address", sPrimaryAddress);
            oIndexAction.invoke().then(function () {
                var oListBinding = oDataModel.bindList(
                    "/Addresses('" + sPrimaryAddress + "')/transactions",
                    undefined, undefined, undefined,
                    { $orderby: "blockTime desc" }
                );

                oListBinding.requestContexts(0, 20).then(function (aContexts) {
                    var aTransactions = aContexts.map(function (oCtx) {
                        var oData = oCtx.getObject();
                        var aAssets = [];
                        if (oData.netAssets) {
                            try { aAssets = JSON.parse(oData.netAssets); } catch { aAssets = []; }
                        }
                        return {
                            txHash: oData.tx_hash || "",
                            timestamp: oData.blockTime || 0,
                            amount: String(oData.netAmount || 0),
                            hasAssets: oData.hasAssets || false,
                            assets: aAssets
                        };
                    });
                    that._walletService.getModel().setProperty("/transactions", aTransactions);
                });
            }).catch(function () {
                // load transactions failed silently
            });
        },

        _loadSigningRequests: function () {
            var sPrimaryAddress = this._walletService.getPrimaryAddress();
            if (!sPrimaryAddress) return;

            var oSignModel = this.getView().getModel("sign");
            if (!oSignModel) return;

            var that = this;

            var oAction = oSignModel.bindContext("/GetSigningRequestsByAddress(...)");
            oAction.setParameter("address", sPrimaryAddress);
            oAction.invoke().then(function () {
                var oResult = oAction.getBoundContext().getObject();
                var aAssociations = Array.isArray(oResult) ? oResult : (oResult && oResult.value ? oResult.value : []);

                Promise.all(aAssociations.map(function (oAsr) {
                    return new Promise(function (resolve) {
                        var oSrBinding = oSignModel.bindContext("/SigningRequests('" + oAsr.signingRequest_id + "')");
                        oSrBinding.requestObject().then(function () {
                            var oSr = oSrBinding.getBoundContext().getObject();
                            resolve({
                                id: (oSr && oSr.id) || oAsr.signingRequest_id,
                                status: (oSr && oSr.status) || "unknown",
                                network: (oSr && oSr.network) || "",
                                createdAt: (oSr && oSr.createdAt) || "",
                                expiresAt: (oSr && oSr.expiresAt) || "",
                                signerType: (oSr && oSr.signerType) || "",
                                signerInfo: (oSr && oSr.signerInfo) || "",
                                txBodyHash: (oSr && oSr.txBodyHash) || ""
                            });
                        }).catch(function () {
                            resolve({
                                id: oAsr.signingRequest_id,
                                status: "unknown", network: "", createdAt: "",
                                expiresAt: "", signerType: "", signerInfo: "", txBodyHash: ""
                            });
                        });
                    });
                })).then(function (aSigningRequests) {
                    that._walletService.getModel().setProperty("/signingRequests", aSigningRequests);
                });
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

            var oAction = oTxModel.bindContext("/GetTransactionBuildsByAddress(...)");
            oAction.setParameter("address", sPrimaryAddress);
            oAction.invoke().then(function () {
                var oResult = oAction.getBoundContext().getObject();
                var aAssociations = Array.isArray(oResult) ? oResult : (oResult && oResult.value ? oResult.value : []);

                Promise.all(aAssociations.map(function (oAtb) {
                    return new Promise(function (resolve) {
                        var oBuildBinding = oTxModel.bindContext("/TransactionBuilds('" + oAtb.txBuild_id + "')");
                        oBuildBinding.requestObject().then(function () {
                            var oBuild = oBuildBinding.getBoundContext().getObject();
                            resolve({
                                id: (oBuild && oBuild.id) || oAtb.txBuild_id,
                                network: (oBuild && oBuild.network) || "",
                                senderAddress: (oBuild && oBuild.senderAddress) || "",
                                changeAddress: (oBuild && oBuild.changeAddress) || "",
                                fee: (oBuild && oBuild.fee) || "0",
                                size: (oBuild && oBuild.size) || 0,
                                createdAt: (oBuild && oBuild.createdAt) || "",
                                wasSubmitted: (oBuild && oBuild.wasSubmitted) || false,
                                txBodyHash: (oBuild && oBuild.txBodyHash) || ""
                            });
                        }).catch(function () {
                            resolve({
                                id: oAtb.txBuild_id,
                                network: "", senderAddress: "", changeAddress: "",
                                fee: "0", size: 0, createdAt: "", wasSubmitted: false, txBodyHash: ""
                            });
                        });
                    });
                })).then(function (aTransactionBuilds) {
                    that._walletService.getModel().setProperty("/transactionBuilds", aTransactionBuilds);
                });
            }).catch(function () {
                that._walletService.getModel().setProperty("/transactionBuilds", []);
            });
        },

        // --- Asset Actions ---

        onAssetItemPress: function (oEvent) {
            var oItem = oEvent.getSource();
            var oCtx = oItem.getBindingContext("wallet");
            var sUnit = oCtx.getProperty("unit");
            if (sUnit) {
                navigator.clipboard.writeText(sUnit).then(function () {
                    MessageToast.show("Asset unit copied to clipboard");
                });
            }
        },

        // --- Address Actions ---

        onCopyAddress: function () {
            var sAddress = this._walletService.getPrimaryAddress();
            if (sAddress) {
                navigator.clipboard.writeText(sAddress).then(function () {
                    MessageToast.show("Address copied to clipboard");
                });
            }
        },

        onAddressItemPress: function (oEvent) {
            var oItem = oEvent.getSource();
            var sAddress = oItem.getBindingContext("wallet").getProperty("bech32");
            if (sAddress) {
                navigator.clipboard.writeText(sAddress).then(function () {
                    MessageToast.show("Address copied to clipboard");
                });
            }
        },

        onCopyChangeAddress: function () {
            var sChangeAddress = this._walletService.getChangeAddress();
            if (sChangeAddress) {
                navigator.clipboard.writeText(sChangeAddress).then(function () {
                    MessageToast.show("Change address copied to clipboard");
                });
            }
        },

        onStakeAddressPress: function (oEvent) {
            var oItem = oEvent.getSource();
            var sStakeAddress = oItem.getBindingContext("wallet").getObject();
            if (sStakeAddress) {
                navigator.clipboard.writeText(sStakeAddress).then(function () {
                    MessageToast.show("Stake address copied to clipboard");
                });
            }
        },

        onTransactionItemPress: function (oEvent) {
            var oItem = oEvent.getSource();
            var sTxHash = oItem.getBindingContext("wallet").getProperty("txHash");
            if (sTxHash) {
                navigator.clipboard.writeText(sTxHash).then(function () {
                    MessageToast.show("Transaction hash copied to clipboard");
                });
            }
        },

        onSigningRequestItemPress: function (oEvent) {
            var oItem = oEvent.getSource();
            var sId = oItem.getBindingContext("wallet").getProperty("id");
            if (sId) {
                navigator.clipboard.writeText(sId).then(function () {
                    MessageToast.show("Signing request ID copied to clipboard");
                });
            }
        },

        onTransactionBuildItemPress: function (oEvent) {
            var oItem = oEvent.getSource();
            var sId = oItem.getBindingContext("wallet").getProperty("id");
            if (sId) {
                navigator.clipboard.writeText(sId).then(function () {
                    MessageToast.show("Build ID copied to clipboard");
                });
            }
        },

        // --- Send ADA Workflow ---

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
                    name: "odatanoview.walletviewer.view.fragment.SendAda",
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

        onRecipientAddressChange: function (oEvent) {
            var sValue = (oEvent.getParameter("newValue") || "").trim();
            var bech32Charset = /^[a-z0-9_]+$/;
            var MIN_ADDR_LENGTH = 58;

            if (!sValue) {
                this._sendModel.setProperty("/recipientAddressState", "None");
                this._sendModel.setProperty("/recipientAddressStateText", "");
            } else if (!sValue.startsWith("addr1") && !sValue.startsWith("addr_test1")) {
                this._sendModel.setProperty("/recipientAddressState", "Error");
                this._sendModel.setProperty("/recipientAddressStateText", "Must start with addr1 or addr_test1");
            } else if (!bech32Charset.test(sValue)) {
                this._sendModel.setProperty("/recipientAddressState", "Error");
                this._sendModel.setProperty("/recipientAddressStateText", "Contains invalid characters");
            } else if (sValue.length < MIN_ADDR_LENGTH) {
                this._sendModel.setProperty("/recipientAddressState", "Warning");
                this._sendModel.setProperty("/recipientAddressStateText", "Address seems incomplete");
            } else {
                this._sendModel.setProperty("/recipientAddressState", "Success");
                this._sendModel.setProperty("/recipientAddressStateText", "");
            }

            this._validateSendForm();
        },

        onAmountChange: function (oEvent) {
            var sValue = oEvent.getParameter("newValue");
            var nNumValue = parseFloat(sValue);
            var nAvailableLovelace = BigInt(this._sendModel.getProperty("/availableBalance") || "0");
            var nAvailableAda = Number(nAvailableLovelace) / 1000000;

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
            var sRecipientState = this._sendModel.getProperty("/recipientAddressState");
            var sAmountState = this._sendModel.getProperty("/amountState");
            var sRecipientAddress = this._sendModel.getProperty("/recipientAddress") || "";
            var sAmount = this._sendModel.getProperty("/adaAmount") || "";

            var bIsValid =
                sRecipientAddress.length >= 58 &&
                (sRecipientAddress.startsWith("addr1") || sRecipientAddress.startsWith("addr_test1")) &&
                /^[a-z0-9_]+$/.test(sRecipientAddress) &&
                parseFloat(sAmount) > 0 &&
                sRecipientState !== "Error" &&
                sAmountState !== "Error";

            this._sendModel.setProperty("/canContinue", bIsValid);
        },

        onContinueSend: function () {
            var sSenderAddress = this._sendModel.getProperty("/senderAddress");
            var sRecipientAddress = this._sendModel.getProperty("/recipientAddress");
            var nAdaAmount = parseFloat(this._sendModel.getProperty("/adaAmount"));
            var sLovelaceAmount = Math.floor(nAdaAmount * 1000000).toString();

            if (this._sendAdaDialog) {
                this._sendAdaDialog.close();
            }

            this._buildAndSign(sSenderAddress, sRecipientAddress, sLovelaceAmount);
        },

        onCancelSend: function () {
            if (this._sendAdaDialog) {
                this._sendAdaDialog.close();
            }
        },

        // --- Transaction Building and Signing ---

        _buildAndSign: function (sSenderAddress, sRecipientAddress, sLovelaceAmount) {
            var oTxModel = this.getView().getModel("tx");
            var oSignModel = this.getView().getModel("sign");
            if (!oTxModel || !oSignModel) return;

            this._signingModel.setData({
                busy: true,
                signed: false,
                buildId: null,
                signingRequestId: null,
                txBodyHash: null,
                unsignedTxCbor: null,
                recipientAddress: sRecipientAddress,
                lovelaceAmount: sLovelaceAmount,
                network: null,
                networkMismatch: false,
                statusMessage: "Building transaction...",
                statusType: "Information",
                dialogState: "None"
            });

            var that = this;

            var fnOpenAndBuild = function () {
                var oBuildAction = oTxModel.bindContext("/BuildSimpleAdaTransaction(...)");
                oBuildAction.setParameter("senderAddress", sSenderAddress);
                oBuildAction.setParameter("recipientAddress", sRecipientAddress);
                oBuildAction.setParameter("lovelaceAmount", sLovelaceAmount);
                oBuildAction.setParameter("changeAddress", that._walletService.getChangeAddress() || sSenderAddress);

                oBuildAction.execute().then(function () {
                    var oBuildResult = oBuildAction.getBoundContext().getObject();

                    if (!oBuildResult || !oBuildResult.id) {
                        throw new Error("Transaction build failed - no build ID returned");
                    }

                    that._signingModel.setProperty("/buildId", oBuildResult.id);
                    that._signingModel.setProperty("/statusMessage", "Creating signing request...");

                    var oSigningAction = oSignModel.bindContext("/CreateSigningRequest(...)");
                    oSigningAction.setParameter("buildId", oBuildResult.id);

                    return oSigningAction.execute().then(function () {
                        var oSigningRequest = oSigningAction.getBoundContext().getObject();

                        if (!oSigningRequest || !oSigningRequest.id) {
                            throw new Error("Failed to create signing request");
                        }

                        that._signingModel.setProperty("/signingRequestId", oSigningRequest.id);
                        that._signingModel.setProperty("/txBodyHash", oSigningRequest.txBodyHash);
                        that._signingModel.setProperty("/unsignedTxCbor", oSigningRequest.cip30TxCbor || oSigningRequest.unsignedTxCbor);
                        that._signingModel.setProperty("/network", oSigningRequest.network);

                        var sWalletNetwork = that._walletService.getNetwork();
                        var sTxNetwork = oSigningRequest.network;
                        var bMismatch = sWalletNetwork !== null && sWalletNetwork !== sTxNetwork;
                        that._signingModel.setProperty("/networkMismatch", bMismatch);

                        that._signingModel.setProperty("/statusMessage", "Ready to sign");
                        that._signingModel.setProperty("/statusType", "Success");
                        that._signingModel.setProperty("/busy", false);
                    });
                }).catch(function (oError) {
                    that._signingModel.setProperty("/statusMessage", (oError && oError.message) || "Transaction build failed");
                    that._signingModel.setProperty("/statusType", "Error");
                    that._signingModel.setProperty("/dialogState", "Error");
                    that._signingModel.setProperty("/busy", false);
                });
            };

            if (!this._signTransactionDialog) {
                Fragment.load({
                    id: this.getView().getId(),
                    name: "odatanoview.walletviewer.view.fragment.SignTransaction",
                    controller: this
                }).then(function (oDialog) {
                    that._signTransactionDialog = oDialog;
                    that.getView().addDependent(oDialog);
                    oDialog.open();
                    fnOpenAndBuild();
                });
            } else {
                this._signTransactionDialog.open();
                fnOpenAndBuild();
            }
        },

        onConfirmSign: function () {
            this._signingModel.setProperty("/busy", true);
            this._signingModel.setProperty("/statusMessage", "Requesting signature from wallet...");
            this._signingModel.setProperty("/statusType", "Information");

            var that = this;
            var oSigningRequest = {
                signingRequestId: this._signingModel.getProperty("/signingRequestId"),
                buildId: this._signingModel.getProperty("/buildId"),
                unsignedTxCbor: this._signingModel.getProperty("/unsignedTxCbor"),
                txBodyHash: this._signingModel.getProperty("/txBodyHash"),
                network: this._signingModel.getProperty("/network"),
                expiresAt: ""
            };

            this._walletService.signTransaction(oSigningRequest).then(function (oResult) {
                if (!oResult.success || !oResult.signedTxCbor) {
                    throw new Error(oResult.error || "Signing failed");
                }

                that._signingModel.setProperty("/statusMessage", "Submitting transaction...");

                var oSignModel = that.getView().getModel("sign");
                var oSubmitAction = oSignModel.bindContext("/SigningRequests('" + oSigningRequest.signingRequestId + "')/CardanoSignService.SubmitVerifiedTransaction(...)");
                oSubmitAction.setParameter("signedTxCbor", oResult.signedTxCbor);
                oSubmitAction.setParameter("signerType", "browser-wallet");
                oSubmitAction.setParameter("signerInfo", that._walletService.getModel().getProperty("/walletName"));

                return oSubmitAction.execute().then(function () {
                    var oSubmission = oSubmitAction.getBoundContext().getObject();

                    that._signingModel.setProperty("/signed", true);
                    that._signingModel.setProperty("/statusMessage", "Transaction submitted! Hash: " + ((oSubmission && oSubmission.txHash) || oResult.txHash));
                    that._signingModel.setProperty("/statusType", "Success");
                    that._signingModel.setProperty("/dialogState", "Success");

                    MessageToast.show("Transaction submitted successfully!");
                    that._walletService.refresh();
                });
            }).catch(function (oError) {
                that._signingModel.setProperty("/statusMessage", (oError && oError.message) || "Signing failed");
                that._signingModel.setProperty("/statusType", "Error");
                that._signingModel.setProperty("/dialogState", "Error");
            }).finally(function () {
                that._signingModel.setProperty("/busy", false);
            });
        },

        onCancelSign: function () {
            if (this._signTransactionDialog) {
                this._signTransactionDialog.close();
            }

            this._signingModel.setData({
                busy: false,
                signed: false,
                buildId: null,
                signingRequestId: null,
                txBodyHash: null,
                unsignedTxCbor: null,
                recipientAddress: null,
                lovelaceAmount: null,
                network: null,
                networkMismatch: false,
                statusMessage: null,
                statusType: "None",
                dialogState: "None"
            });
        }
    });
});
