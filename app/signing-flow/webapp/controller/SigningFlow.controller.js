sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageBox",
    "sap/m/MessageToast",
    "odatano/common/wallet/WalletService",
    "odatano/common/model/formatter"
], function (Controller, JSONModel, MessageBox, MessageToast, WalletService, formatter) {
    "use strict";

    var INITIAL_FLOW_STATE = {
        // Wizard step flags
        buildCompleted: false,
        signCompleted: false,
        verifyCompleted: false,

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

        // Signing
        signingBusy: false,
        signingRequest: null,
        signBusy: false,
        signedTxCbor: null,
        signerType: "browser-wallet",
        signerInfo: "",
        expirationText: "",
        expirationState: "Success",
        manualCborInput: "",
        manualCborError: null,
        signMessage: null,
        signMessageType: "None",
        networkMismatch: false,

        // Verification
        verifyBusy: false,
        verification: null,

        // Submission
        submitBusy: false,
        submission: null,
        submitError: null,
        submissionPolling: false,

        // Inspector
        inspectorByteCount: 0,
        inspectorInputCount: 0,
        inspectorOutputCount: 0,

        // History
        signingRequests: []
    };

    return Controller.extend("odatanoview.signingflow.controller.SigningFlow", {

        formatter: formatter,

        onInit: function () {
            this._walletService = WalletService.getInstance();
            this._flowModel = new JSONModel(JSON.parse(JSON.stringify(INITIAL_FLOW_STATE)));
            this.getView().setModel(this._flowModel, "flow");

            this._expirationInterval = null;
            this._statusPollingInterval = null;
            this._expiresAtTimestamp = 0;
        },

        onExit: function () {
            this._clearExpirationTimer();
            this._clearStatusPolling();
        },

        // ===== Wallet Connection =====

        onWalletSelect: function (oEvent) {
            var oItem = oEvent.getParameter("listItem");
            var sWalletId = oItem ? oItem.getBindingContext("wallet").getProperty("id") : null;

            if (sWalletId) {
                var that = this;
                this._walletService.connect(sWalletId).then(function (bConnected) {
                    if (bConnected) {
                        that._initFlowForWallet();
                        that._loadSigningRequestHistory();
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
                that._loadSigningRequestHistory();
            });
        },

        onCopyAddress: function () {
            var sAddress = this._walletService.getPrimaryAddress();
            if (sAddress) {
                navigator.clipboard.writeText(sAddress).then(function () {
                    MessageToast.show("Address copied");
                });
            }
        },

        _initFlowForWallet: function () {
            this._flowModel.setProperty("/senderAddress", this._walletService.getPrimaryAddress() || "");
            this._flowModel.setProperty("/changeAddress", this._walletService.getChangeAddress() || "");
        },

        // ===== Build Step =====

        onTransactionTypeChange: function () {
            this._validateBuildForm();
        },

        onRecipientAddressChange: function (oEvent) {
            var sValue = (oEvent.getParameter("newValue") || "").trim();
            var bech32Charset = /^[a-z0-9_]+$/;
            var MIN_ADDR_LENGTH = 58;

            if (!sValue) {
                this._flowModel.setProperty("/recipientAddressState", "None");
                this._flowModel.setProperty("/recipientAddressStateText", "");
            } else if (!sValue.startsWith("addr1") && !sValue.startsWith("addr_test1")) {
                this._flowModel.setProperty("/recipientAddressState", "Error");
                this._flowModel.setProperty("/recipientAddressStateText", "Must start with addr1 or addr_test1");
            } else if (!bech32Charset.test(sValue)) {
                this._flowModel.setProperty("/recipientAddressState", "Error");
                this._flowModel.setProperty("/recipientAddressStateText", "Contains invalid characters");
            } else if (sValue.length < MIN_ADDR_LENGTH) {
                this._flowModel.setProperty("/recipientAddressState", "Warning");
                this._flowModel.setProperty("/recipientAddressStateText", "Address seems incomplete");
            } else {
                this._flowModel.setProperty("/recipientAddressState", "Success");
                this._flowModel.setProperty("/recipientAddressStateText", "");
            }

            this._validateBuildForm();
        },

        onAmountChange: function (oEvent) {
            var sValue = oEvent.getParameter("newValue");
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
            var sRecipientState = this._flowModel.getProperty("/recipientAddressState");
            var sAmountState = this._flowModel.getProperty("/amountState");

            var bIsValid =
                sRecipient.length >= 58 &&
                (sRecipient.startsWith("addr1") || sRecipient.startsWith("addr_test1")) &&
                /^[a-z0-9_]+$/.test(sRecipient) &&
                parseFloat(sAmount) > 0 &&
                sRecipientState !== "Error" &&
                sAmountState !== "Error";

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
                var sMetadata = this._flowModel.getProperty("/metadataJson");
                oBuildAction.setParameter("metadataJson", sMetadata || "{}");
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

                // Update inspector
                var sCbor = oBuild.unsignedTxCbor || "";
                that._flowModel.setProperty("/inspectorByteCount", Math.floor(sCbor.length / 2));

                // Load inputs/outputs
                that._loadBuildDetails(oTxModel, oBuild.id);

                that._flowModel.setProperty("/buildCompleted", true);
            }).catch(function (oError) {
                that._flowModel.setProperty("/buildError", (oError && oError.message) || "Transaction build failed");
            }).finally(function () {
                that._flowModel.setProperty("/buildBusy", false);
            });
        },

        _loadBuildDetails: function (oTxModel, sBuildId) {
            var that = this;

            // Load inputs
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

            // Load outputs
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

        onCopyBuildCbor: function () {
            var sCbor = this._flowModel.getProperty("/build/unsignedTxCbor");
            if (sCbor) {
                navigator.clipboard.writeText(sCbor).then(function () {
                    MessageToast.show("CBOR copied");
                });
            }
        },

        onCopyBuildTxHash: function () {
            var sHash = this._flowModel.getProperty("/build/txBodyHash");
            if (sHash) {
                navigator.clipboard.writeText(sHash).then(function () {
                    MessageToast.show("Hash copied");
                });
            }
        },

        // ===== Continue to Signing (Build → Sign transition) =====

        onContinueToSigning: function () {
            var oTxModel = this.getView().getModel("tx");
            var sBuildId = this._flowModel.getProperty("/build/id");
            if (!oTxModel || !sBuildId) return;

            this._flowModel.setProperty("/signingBusy", true);

            var oSigningAction = oTxModel.bindContext("/CreateSigningRequest(...)");
            oSigningAction.setParameter("buildId", sBuildId);

            var that = this;
            oSigningAction.execute().then(function () {
                var oSR = oSigningAction.getBoundContext().getObject();
                if (!oSR || !oSR.id) {
                    throw new Error("Failed to create signing request");
                }

                that._flowModel.setProperty("/signingRequest", {
                    id: oSR.id,
                    status: oSR.status || "pending",
                    txBodyHash: oSR.txBodyHash || "",
                    unsignedTxCbor: oSR.cip30TxCbor || oSR.unsignedTxCbor || "",
                    cardanoCliCommand: oSR.cardanoCliCommand || "",
                    expiresAt: oSR.expiresAt || "",
                    network: oSR.network || ""
                });

                // Check network mismatch
                var sWalletNetwork = that._walletService.getNetwork();
                var sTxNetwork = oSR.network;
                that._flowModel.setProperty("/networkMismatch",
                    sWalletNetwork !== null && sWalletNetwork !== sTxNetwork);

                // Start expiration countdown
                that._startExpirationCountdown(oSR.expiresAt);

                // Advance wizard
                var oWizard = that.byId("signingWizard");
                if (oWizard) {
                    oWizard.nextStep();
                }
            }).catch(function (oError) {
                MessageBox.error((oError && oError.message) || "Failed to create signing request");
            }).finally(function () {
                that._flowModel.setProperty("/signingBusy", false);
            });
        },

        // ===== Sign Step =====

        onStepSignActivate: function () {
            // Reset sign state if returning to this step
            if (!this._flowModel.getProperty("/signCompleted")) {
                this._flowModel.setProperty("/signMessage", null);
                this._flowModel.setProperty("/signMessageType", "None");
            }
        },

        onSignWithWallet: function () {
            this._flowModel.setProperty("/signBusy", true);
            this._flowModel.setProperty("/signMessage", "Requesting signature from wallet...");
            this._flowModel.setProperty("/signMessageType", "Information");
            this._flowModel.setProperty("/signerType", "browser-wallet");
            this._flowModel.setProperty("/signerInfo", this._walletService.getModel().getProperty("/walletName") || "");

            var oSigningRequest = {
                unsignedTxCbor: this._flowModel.getProperty("/signingRequest/unsignedTxCbor"),
                txBodyHash: this._flowModel.getProperty("/signingRequest/txBodyHash")
            };

            var that = this;
            this._walletService.signTransaction(oSigningRequest, true).then(function (oResult) {
                if (!oResult.success || !oResult.signedTxCbor) {
                    throw new Error(oResult.error || "Signing failed");
                }

                that._flowModel.setProperty("/signedTxCbor", oResult.signedTxCbor);
                that._flowModel.setProperty("/signCompleted", true);
                that._flowModel.setProperty("/signMessage", "Transaction signed successfully!");
                that._flowModel.setProperty("/signMessageType", "Success");
            }).catch(function (oError) {
                that._flowModel.setProperty("/signMessage", (oError && oError.message) || "Signing failed");
                that._flowModel.setProperty("/signMessageType", "Error");
            }).finally(function () {
                that._flowModel.setProperty("/signBusy", false);
            });
        },

        onCopySigningRequestId: function () {
            var sId = this._flowModel.getProperty("/signingRequest/id");
            if (sId) {
                navigator.clipboard.writeText(sId).then(function () {
                    MessageToast.show("ID copied");
                });
            }
        },

        onCopyCliCommand: function () {
            var sCmd = this._flowModel.getProperty("/signingRequest/cardanoCliCommand");
            if (sCmd) {
                navigator.clipboard.writeText(sCmd).then(function () {
                    MessageToast.show("CLI command copied");
                });
            }
        },

        onSubmitManualCbor: function () {
            var sCbor = (this._flowModel.getProperty("/manualCborInput") || "").trim();

            // Basic hex validation
            if (!sCbor || sCbor.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(sCbor)) {
                this._flowModel.setProperty("/manualCborError", "Invalid hex: must be an even number of hex characters");
                return;
            }

            this._flowModel.setProperty("/manualCborError", null);
            this._flowModel.setProperty("/signedTxCbor", sCbor);
            this._flowModel.setProperty("/signerType", "cardano-cli");
            this._flowModel.setProperty("/signerInfo", "manual-paste");
            this._flowModel.setProperty("/signCompleted", true);
            MessageToast.show("Signed CBOR accepted");
        },

        // ===== Verify Step =====

        onStepVerifyActivate: function () {
            // Auto-verify when step is activated
            if (this._flowModel.getProperty("/verification")) return; // Already verified
            if (!this._flowModel.getProperty("/signedTxCbor")) return; // No signed data

            this._performVerification();
        },

        _performVerification: function () {
            var oTxModel = this.getView().getModel("tx");
            var sSigningRequestId = this._flowModel.getProperty("/signingRequest/id");
            var sSignedCbor = this._flowModel.getProperty("/signedTxCbor");
            var sSignerType = this._flowModel.getProperty("/signerType");
            var sSignerInfo = this._flowModel.getProperty("/signerInfo");

            if (!oTxModel || !sSigningRequestId || !sSignedCbor) return;

            this._flowModel.setProperty("/verifyBusy", true);

            // Bound action on SigningRequests entity
            var sPath = "/SigningRequests('" + sSigningRequestId + "')/CardanoTransactionService.VerifySignature(...)";
            var oVerifyAction = oTxModel.bindContext(sPath);
            oVerifyAction.setParameter("signedTxCbor", sSignedCbor);
            oVerifyAction.setParameter("signerType", sSignerType || "browser-wallet");
            oVerifyAction.setParameter("signerInfo", sSignerInfo || "");

            var that = this;
            oVerifyAction.execute().then(function () {
                var oResult = oVerifyAction.getBoundContext().getObject();

                var aKeyHashes = [];
                if (oResult.signerKeyHashes) {
                    try { aKeyHashes = JSON.parse(oResult.signerKeyHashes); } catch { aKeyHashes = []; }
                }

                var aWarnings = [];
                if (oResult.warnings) {
                    try { aWarnings = JSON.parse(oResult.warnings); } catch { aWarnings = []; }
                }

                that._flowModel.setProperty("/verification", {
                    isValid: oResult.isValid || false,
                    witnessCount: oResult.witnessCount || 0,
                    signerKeyHashes: aKeyHashes,
                    txBodyHash: oResult.txBodyHash || "",
                    errorMessage: oResult.errorMessage || "",
                    warnings: aWarnings
                });

                that._flowModel.setProperty("/verifyCompleted", oResult.isValid === true);
            }).catch(function (oError) {
                that._flowModel.setProperty("/verification", {
                    isValid: false,
                    witnessCount: 0,
                    signerKeyHashes: [],
                    txBodyHash: "",
                    errorMessage: (oError && oError.message) || "Verification failed",
                    warnings: []
                });
                that._flowModel.setProperty("/verifyCompleted", false);
            }).finally(function () {
                that._flowModel.setProperty("/verifyBusy", false);
            });
        },

        onCopyVerifyTxHash: function () {
            var sHash = this._flowModel.getProperty("/verification/txBodyHash");
            if (sHash) {
                navigator.clipboard.writeText(sHash).then(function () {
                    MessageToast.show("Hash copied");
                });
            }
        },

        onCopyKeyHash: function (oEvent) {
            var oCtx = oEvent.getSource().getBindingContext("flow");
            var sHash = oCtx ? oCtx.getObject() : null;
            if (sHash) {
                navigator.clipboard.writeText(sHash).then(function () {
                    MessageToast.show("Key hash copied");
                });
            }
        },

        // ===== Submit Step =====

        onSubmitTransaction: function () {
            var oTxModel = this.getView().getModel("tx");
            var sSigningRequestId = this._flowModel.getProperty("/signingRequest/id");
            var sSignedCbor = this._flowModel.getProperty("/signedTxCbor");
            var sSignerType = this._flowModel.getProperty("/signerType");
            var sSignerInfo = this._flowModel.getProperty("/signerInfo");

            if (!oTxModel || !sSigningRequestId || !sSignedCbor) return;

            this._flowModel.setProperty("/submitBusy", true);
            this._flowModel.setProperty("/submitError", null);
            this._flowModel.setProperty("/submission", null);

            // Bound action on SigningRequests entity
            var sPath = "/SigningRequests('" + sSigningRequestId + "')/CardanoTransactionService.SubmitVerifiedTransaction(...)";
            var oSubmitAction = oTxModel.bindContext(sPath);
            oSubmitAction.setParameter("signedTxCbor", sSignedCbor);
            oSubmitAction.setParameter("signerType", sSignerType || "browser-wallet");
            oSubmitAction.setParameter("signerInfo", sSignerInfo || "");

            var that = this;
            oSubmitAction.execute().then(function () {
                var oResult = oSubmitAction.getBoundContext().getObject();

                that._flowModel.setProperty("/submission", {
                    id: oResult.id || "",
                    txHash: oResult.txHash || "",
                    status: oResult.status || "submitted",
                    submittedAt: oResult.submittedAt || ""
                });

                MessageToast.show("Transaction submitted!");
                that._startStatusPolling();
                that._walletService.refresh();
                that._loadSigningRequestHistory();
            }).catch(function (oError) {
                that._flowModel.setProperty("/submitError", (oError && oError.message) || "Submission failed");
            }).finally(function () {
                that._flowModel.setProperty("/submitBusy", false);
            });
        },

        onCopyTxHash: function () {
            var sHash = this._flowModel.getProperty("/submission/txHash");
            if (sHash) {
                navigator.clipboard.writeText(sHash).then(function () {
                    MessageToast.show("Transaction hash copied");
                });
            }
        },

        onViewOnCardanoscan: function () {
            var sTxHash = this._flowModel.getProperty("/submission/txHash");
            var sNetwork = this._flowModel.getProperty("/build/network") || "preview";
            if (!sTxHash) return;

            var sBase = sNetwork === "mainnet"
                ? "https://cardanoscan.io"
                : "https://" + sNetwork + ".cardanoscan.io";
            var sUrl = sBase + "/transaction/" + sTxHash;
            window.open(sUrl, "_blank");
        },

        onNewTransaction: function () {
            this._resetFlow();
            var oWizard = this.byId("signingWizard");
            if (oWizard) {
                oWizard.discardProgress(this.byId("stepBuild"));
            }
            this._initFlowForWallet();
        },

        // ===== Inspector =====

        onCopyInspectorCbor: function () {
            var sCbor = this._flowModel.getProperty("/build/unsignedTxCbor");
            if (sCbor) {
                navigator.clipboard.writeText(sCbor).then(function () {
                    MessageToast.show("CBOR copied");
                });
            }
        },

        // ===== History =====

        _loadSigningRequestHistory: function () {
            var sPrimaryAddress = this._walletService.getPrimaryAddress();
            if (!sPrimaryAddress) return;

            var oTxModel = this.getView().getModel("tx");
            if (!oTxModel) return;

            var that = this;

            var oAction = oTxModel.bindContext("/GetSigningRequestsByAddress(...)");
            oAction.setParameter("address", sPrimaryAddress);
            oAction.execute().then(function () {
                var oResult = oAction.getBoundContext().getObject();
                var aAssociations = Array.isArray(oResult) ? oResult : (oResult && oResult.value ? oResult.value : []);

                Promise.all(aAssociations.map(function (oAsr) {
                    return new Promise(function (resolve) {
                        var oSrBinding = oTxModel.bindContext("/SigningRequests('" + oAsr.signingRequest_id + "')");
                        oSrBinding.requestObject().then(function () {
                            var oSr = oSrBinding.getBoundContext().getObject();
                            resolve({
                                id: (oSr && oSr.id) || oAsr.signingRequest_id,
                                status: (oSr && oSr.status) || "unknown",
                                createdAt: (oSr && oSr.createdAt) || "",
                                txBodyHash: (oSr && oSr.txBodyHash) || ""
                            });
                        }).catch(function () {
                            resolve({
                                id: oAsr.signingRequest_id,
                                status: "unknown",
                                createdAt: "",
                                txBodyHash: ""
                            });
                        });
                    });
                })).then(function (aRequests) {
                    that._flowModel.setProperty("/signingRequests", aRequests);
                });
            }).catch(function () {
                that._flowModel.setProperty("/signingRequests", []);
            });
        },

        onHistoryItemPress: function (oEvent) {
            var oCtx = oEvent.getSource().getBindingContext("flow");
            var sId = oCtx ? oCtx.getProperty("id") : null;
            if (sId) {
                navigator.clipboard.writeText(sId).then(function () {
                    MessageToast.show("Request ID copied");
                });
            }
        },

        // ===== Timers =====

        _startExpirationCountdown: function (sExpiresAt) {
            this._clearExpirationTimer();

            if (!sExpiresAt) return;

            this._expiresAtTimestamp = new Date(sExpiresAt).getTime();
            if (isNaN(this._expiresAtTimestamp)) return;

            var that = this;
            this._updateExpirationDisplay();
            this._expirationInterval = setInterval(function () {
                that._updateExpirationDisplay();
            }, 1000);
        },

        _updateExpirationDisplay: function () {
            var iRemaining = Math.max(0, this._expiresAtTimestamp - Date.now());
            var iMinutes = Math.floor(iRemaining / 60000);
            var iSeconds = Math.floor((iRemaining % 60000) / 1000);
            var sText = iMinutes + ":" + (iSeconds < 10 ? "0" : "") + iSeconds;

            var sState;
            if (iRemaining > 300000) {
                sState = "Success";
            } else if (iRemaining > 60000) {
                sState = "Warning";
            } else {
                sState = "Error";
            }

            this._flowModel.setProperty("/expirationText", sText);
            this._flowModel.setProperty("/expirationState", sState);

            if (iRemaining <= 0) {
                this._clearExpirationTimer();
                this._flowModel.setProperty("/expirationText", "Expired");
                this._flowModel.setProperty("/expirationState", "Error");
            }
        },

        _clearExpirationTimer: function () {
            if (this._expirationInterval) {
                clearInterval(this._expirationInterval);
                this._expirationInterval = null;
            }
        },

        _startStatusPolling: function () {
            this._clearStatusPolling();

            var that = this;
            var iPollCount = 0;
            var iMaxPolls = 30; // 5 minutes at 10s interval

            this._flowModel.setProperty("/submissionPolling", true);

            this._statusPollingInterval = setInterval(function () {
                iPollCount++;
                if (iPollCount > iMaxPolls) {
                    that._clearStatusPolling();
                    return;
                }

                var sSubmissionId = that._flowModel.getProperty("/submission/id");
                if (!sSubmissionId) {
                    that._clearStatusPolling();
                    return;
                }

                var oTxModel = that.getView().getModel("tx");
                if (!oTxModel) return;

                var sPath = "/TransactionSubmissions('" + sSubmissionId + "')/CardanoTransactionService.CheckSubmissionStatus(...)";
                var oCheckAction = oTxModel.bindContext(sPath);

                oCheckAction.execute().then(function () {
                    var oResult = oCheckAction.getBoundContext().getObject();
                    if (oResult && oResult.status) {
                        that._flowModel.setProperty("/submission/status", oResult.status);

                        if (oResult.status === "confirmed") {
                            that._clearStatusPolling();
                            MessageToast.show("Transaction confirmed on-chain!");
                        }
                    }
                }).catch(function () {
                    // Silently continue polling
                });
            }, 10000);
        },

        _clearStatusPolling: function () {
            if (this._statusPollingInterval) {
                clearInterval(this._statusPollingInterval);
                this._statusPollingInterval = null;
            }
            this._flowModel.setProperty("/submissionPolling", false);
        },

        // ===== Reset =====

        _resetFlow: function () {
            this._clearExpirationTimer();
            this._clearStatusPolling();
            this._flowModel.setData(JSON.parse(JSON.stringify(INITIAL_FLOW_STATE)));
        }
    });
});
