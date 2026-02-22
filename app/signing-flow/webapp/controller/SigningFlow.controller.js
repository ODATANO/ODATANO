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
        // Tab navigation
        selectedTab: "build",

        // Request lists (categorized by status)
        requests: {
            pending: [],
            verified: [],
            submitted: []
        },
        counts: {
            pending: 0,
            verified: 0,
            submitted: 0
        },

        // Selected request (detail view in any tab)
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

        // Signing action state
        signingBusy: false,
        signBusy: false,
        signedTxCbor: null,
        manualCborInput: "",
        manualCborError: null,
        signMessage: null,
        signMessageType: "None",
        networkMismatch: false,

        // Verification action state
        verifyBusy: false,

        // Submission action state
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
                that._loadAndCategorizeRequests();
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

        // ===== Tab Navigation =====

        onTabSelect: function (oEvent) {
            var sKey = oEvent.getParameter("key");
            this._flowModel.setProperty("/selectedTab", sKey);

            // Clear selected request when switching tabs
            this._clearSelectedRequest();

            // Refresh request lists when entering a status tab
            if (sKey !== "build") {
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

        // ===== Request Loading & Categorization =====

        _loadAndCategorizeRequests: function () {
            var sPrimaryAddress = this._walletService.getPrimaryAddress();
            if (!sPrimaryAddress) return Promise.resolve();

            var oSignModel = this.getView().getModel("sign");
            if (!oSignModel) return Promise.resolve();

            var that = this;

            var oAction = oSignModel.bindContext("/GetSigningRequestsByAddress(...)");
            oAction.setParameter("address", sPrimaryAddress);

            return oAction.execute().then(function () {
                var oResult = oAction.getBoundContext().getObject();
                var aAssociations = Array.isArray(oResult) ? oResult : (oResult && oResult.value ? oResult.value : []);

                return Promise.all(aAssociations.map(function (oAsr) {
                    return new Promise(function (resolve) {
                        var oSrBinding = oSignModel.bindContext("/SigningRequests('" + oAsr.signingRequest_id + "')");
                        oSrBinding.requestObject().then(function () {
                            var oSr = oSrBinding.getBoundContext().getObject();
                            resolve(oSr ? {
                                id: oSr.id,
                                status: oSr.status || "unknown",
                                createdAt: oSr.createdAt || "",
                                expiresAt: oSr.expiresAt || "",
                                txBodyHash: oSr.txBodyHash || "",
                                unsignedTxCbor: oSr.unsignedTxCbor || "",
                                cip30TxCbor: oSr.cip30TxCbor || "",
                                network: oSr.network || "",
                                cardanoCliCommand: oSr.cardanoCliCommand || "",
                                signerType: oSr.signerType || "",
                                signerInfo: oSr.signerInfo || ""
                            } : null);
                        }).catch(function () { resolve(null); });
                    });
                }));
            }).then(function (aAllRequests) {
                var aValid = aAllRequests.filter(function (r) { return r !== null; });

                var aPending = [], aVerified = [], aSubmitted = [];
                aValid.forEach(function (r) {
                    switch (r.status) {
                        case "pending": aPending.push(r); break;
                        case "verified": aVerified.push(r); break;
                        case "submitted":
                        case "confirmed":
                        case "expired":
                        case "failed":
                            aSubmitted.push(r); break;
                    }
                });

                // Sort by createdAt descending (newest first)
                var sortDesc = function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); };
                aPending.sort(sortDesc);
                aVerified.sort(sortDesc);
                aSubmitted.sort(sortDesc);

                that._flowModel.setProperty("/requests/pending", aPending);
                that._flowModel.setProperty("/requests/verified", aVerified);
                that._flowModel.setProperty("/requests/submitted", aSubmitted);
                that._flowModel.setProperty("/counts/pending", aPending.length);
                that._flowModel.setProperty("/counts/verified", aVerified.length);
                that._flowModel.setProperty("/counts/submitted", aSubmitted.length);
            }).catch(function () {
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

        // ===== Request Selection =====

        onPendingRequestSelect: function (oEvent) {
            var oItem = oEvent.getParameter("listItem");
            var oCtx = oItem ? oItem.getBindingContext("flow") : null;
            if (!oCtx) return;

            var oRequest = JSON.parse(JSON.stringify(oCtx.getObject()));
            this._selectRequest(oRequest);
            this._startExpirationCountdown(oRequest.expiresAt);
        },

        onVerifiedRequestSelect: function (oEvent) {
            var oItem = oEvent.getParameter("listItem");
            var oCtx = oItem ? oItem.getBindingContext("flow") : null;
            if (!oCtx) return;

            var oRequest = JSON.parse(JSON.stringify(oCtx.getObject()));
            this._selectRequest(oRequest);
        },

        onSubmittedRequestSelect: function (oEvent) {
            var oItem = oEvent.getParameter("listItem");
            var oCtx = oItem ? oItem.getBindingContext("flow") : null;
            if (!oCtx) return;

            var oRequest = JSON.parse(JSON.stringify(oCtx.getObject()));
            this._selectRequest(oRequest);

            // Load submission details for submitted requests
            if (oRequest.status === "submitted" || oRequest.status === "confirmed") {
                this._loadSubmissionDetails(oRequest.id);
            }
        },

        _selectRequest: function (oRequest) {
            this._clearSelectedRequest();

            var sWalletNetwork = this._walletService.getNetwork();
            oRequest.networkMismatch = sWalletNetwork !== null && sWalletNetwork !== oRequest.network;

            // Initialize verification object if not present
            if (!oRequest.verification) {
                oRequest.verification = {
                    isValid: false,
                    witnessCount: 0,
                    signerKeyHashes: [],
                    txBodyHash: ""
                };
            }

            // Initialize submission object if not present
            if (!oRequest.submission) {
                oRequest.submission = {
                    id: "",
                    txHash: "",
                    status: ""
                };
            }

            this._flowModel.setProperty("/selectedRequest", oRequest);
            this._flowModel.setProperty("/networkMismatch", oRequest.networkMismatch);

            // Update inspector from selected request
            var sCbor = oRequest.cip30TxCbor || oRequest.unsignedTxCbor || "";
            this._flowModel.setProperty("/inspectorByteCount", Math.floor(sCbor.length / 2));
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

            // Load the signing request with expanded submission
            var oSrBinding = oSignModel.bindContext("/SigningRequests('" + sSigningRequestId + "')", undefined, {
                $expand: "submission"
            });
            oSrBinding.requestObject().then(function () {
                var oSr = oSrBinding.getBoundContext().getObject();
                if (oSr && oSr.submission) {
                    that._flowModel.setProperty("/selectedRequest/submission", {
                        id: oSr.submission.id || "",
                        txHash: oSr.submission.txHash || "",
                        status: oSr.submission.status || "submitted",
                        submittedAt: oSr.submission.submittedAt || ""
                    });

                    // Start polling if still submitted (not yet confirmed)
                    if (oSr.submission.status === "submitted") {
                        that._startStatusPolling(oSr.submission.id);
                    }
                }
            }).catch(function () {
                // Ignore - submission may not exist yet
            });
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

        // ===== Continue to Signing (Build -> Pending transition) =====

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
                if (!oSR || !oSR.id) {
                    throw new Error("Failed to create signing request");
                }

                var sNewId = oSR.id;

                // Refresh request lists and switch to Pending tab
                return that._loadAndCategorizeRequests().then(function () {
                    that._switchToTab("pending");

                    // Auto-select the new request
                    var aPending = that._flowModel.getProperty("/requests/pending") || [];
                    var oNewRequest = null;
                    for (var i = 0; i < aPending.length; i++) {
                        if (aPending[i].id === sNewId) {
                            oNewRequest = JSON.parse(JSON.stringify(aPending[i]));
                            break;
                        }
                    }
                    if (oNewRequest) {
                        that._selectRequest(oNewRequest);
                        that._startExpirationCountdown(oNewRequest.expiresAt);
                    }
                });
            }).catch(function (oError) {
                MessageBox.error((oError && oError.message) || "Failed to create signing request");
            }).finally(function () {
                that._flowModel.setProperty("/signingBusy", false);
            });
        },

        // ===== Sign Actions (operate on selectedRequest) =====

        onSignSelectedWithWallet: function () {
            var oSelectedRequest = this._flowModel.getProperty("/selectedRequest");
            if (!oSelectedRequest) return;

            this._flowModel.setProperty("/signBusy", true);
            this._flowModel.setProperty("/signMessage", "Requesting signature from wallet...");
            this._flowModel.setProperty("/signMessageType", "Information");

            var oSigningRequest = {
                unsignedTxCbor: oSelectedRequest.cip30TxCbor || oSelectedRequest.unsignedTxCbor,
                txBodyHash: oSelectedRequest.txBodyHash
            };

            var that = this;
            this._walletService.signTransaction(oSigningRequest, true).then(function (oResult) {
                if (!oResult.success || !oResult.signedTxCbor) {
                    throw new Error(oResult.error || "Signing failed");
                }

                that._flowModel.setProperty("/signedTxCbor", oResult.signedTxCbor);
                that._flowModel.setProperty("/signMessage", "Signed! Verifying...");
                that._flowModel.setProperty("/signMessageType", "Success");

                // Auto-verify after wallet signing
                that._performVerificationForSelected(
                    oResult.signedTxCbor,
                    "browser-wallet",
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

            // Basic hex validation
            if (!sCbor || sCbor.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(sCbor)) {
                this._flowModel.setProperty("/manualCborError", "Invalid hex: must be an even number of hex characters");
                return;
            }

            this._flowModel.setProperty("/manualCborError", null);
            this._flowModel.setProperty("/signedTxCbor", sCbor);
            MessageToast.show("Signed CBOR accepted, verifying...");

            // Auto-verify after manual CBOR input
            this._performVerificationForSelected(sCbor, "cardano-cli", "manual-paste");
        },

        onCopySelectedRequestId: function () {
            var sId = this._flowModel.getProperty("/selectedRequest/id");
            if (sId) {
                navigator.clipboard.writeText(sId).then(function () {
                    MessageToast.show("ID copied");
                });
            }
        },

        onCopyCliCommand: function () {
            var sCmd = this._flowModel.getProperty("/selectedRequest/cardanoCliCommand");
            if (sCmd) {
                navigator.clipboard.writeText(sCmd).then(function () {
                    MessageToast.show("CLI command copied");
                });
            }
        },

        // ===== Verify (auto-triggered after sign) =====

        _performVerificationForSelected: function (sSignedCbor, sSignerType, sSignerInfo) {
            var oSignModel = this.getView().getModel("sign");
            var oSelectedRequest = this._flowModel.getProperty("/selectedRequest");
            if (!oSignModel || !oSelectedRequest) return;

            this._flowModel.setProperty("/verifyBusy", true);

            var sPath = "/VerifySignature(...)";
            var oVerifyAction = oSignModel.bindContext(sPath);
            oVerifyAction.setParameter("signingRequestId", oSelectedRequest.id);
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

                if (oResult && oResult.isValid) {
                    MessageToast.show("Signature verified successfully");

                    // Refresh lists -- request moves from Pending to Verified tab
                    that._loadAndCategorizeRequests().then(function () {
                        that._switchToTab("verified");

                        // Auto-select the now-verified request
                        var aVerified = that._flowModel.getProperty("/requests/verified") || [];
                        var oVerifiedReq = null;
                        for (var i = 0; i < aVerified.length; i++) {
                            if (aVerified[i].id === oSelectedRequest.id) {
                                oVerifiedReq = JSON.parse(JSON.stringify(aVerified[i]));
                                break;
                            }
                        }
                        if (oVerifiedReq) {
                            oVerifiedReq.verification = {
                                isValid: true,
                                witnessCount: oResult.witnessCount || 0,
                                signerKeyHashes: aKeyHashes,
                                txBodyHash: oResult.txBodyHash || ""
                            };
                            that._selectRequest(oVerifiedReq);
                            // Store signed CBOR for subsequent submit
                            that._flowModel.setProperty("/signedTxCbor", sSignedCbor);
                        }
                    });
                } else {
                    that._flowModel.setProperty("/signMessage",
                        "Verification failed: " + ((oResult && oResult.errorMessage) || "Unknown error"));
                    that._flowModel.setProperty("/signMessageType", "Error");
                }
            }).catch(function (oError) {
                that._flowModel.setProperty("/signMessage",
                    "Verification error: " + ((oError && oError.message) || "Unknown"));
                that._flowModel.setProperty("/signMessageType", "Error");
            }).finally(function () {
                that._flowModel.setProperty("/verifyBusy", false);
            });
        },

        onCopySelectedTxHash: function () {
            var sHash = this._flowModel.getProperty("/selectedRequest/txBodyHash");
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

        // ===== Submit (from Verified tab) =====

        onSubmitSelectedTransaction: function () {
            var oSignModel = this.getView().getModel("sign");
            var oSelectedRequest = this._flowModel.getProperty("/selectedRequest");
            var sSignedCbor = this._flowModel.getProperty("/signedTxCbor");

            if (!oSignModel || !oSelectedRequest) return;

            // If no signed CBOR in session, we need it from verification
            if (!sSignedCbor) {
                this._flowModel.setProperty("/submitError", "No signed transaction data available. Please sign the transaction first.");
                return;
            }

            this._flowModel.setProperty("/submitBusy", true);
            this._flowModel.setProperty("/submitError", null);

            var sPath = "/SubmitVerifiedTransaction(...)";
            var oSubmitAction = oSignModel.bindContext(sPath);
            oSubmitAction.setParameter("signingRequestId", oSelectedRequest.id);
            oSubmitAction.setParameter("signedTxCbor", sSignedCbor);
            oSubmitAction.setParameter("signerType", oSelectedRequest.signerType || "browser-wallet");
            oSubmitAction.setParameter("signerInfo", oSelectedRequest.signerInfo || "");

            var that = this;
            oSubmitAction.execute().then(function () {
                var oResult = oSubmitAction.getBoundContext().getObject();
                MessageToast.show("Transaction submitted!");

                // Refresh lists -- request moves from Verified to Submitted tab
                that._loadAndCategorizeRequests().then(function () {
                    that._switchToTab("submitted");

                    // Auto-select the now-submitted request
                    var aSubmitted = that._flowModel.getProperty("/requests/submitted") || [];
                    var oSubReq = null;
                    for (var i = 0; i < aSubmitted.length; i++) {
                        if (aSubmitted[i].id === oSelectedRequest.id) {
                            oSubReq = JSON.parse(JSON.stringify(aSubmitted[i]));
                            break;
                        }
                    }
                    if (oSubReq) {
                        oSubReq.submission = {
                            id: oResult.id || "",
                            txHash: oResult.txHash || "",
                            status: oResult.status || "submitted",
                            submittedAt: oResult.submittedAt || ""
                        };
                        that._selectRequest(oSubReq);
                        that._startStatusPolling(oResult.id);
                    }
                });

                that._walletService.refresh();
            }).catch(function (oError) {
                that._flowModel.setProperty("/submitError", (oError && oError.message) || "Submission failed");
            }).finally(function () {
                that._flowModel.setProperty("/submitBusy", false);
            });
        },

        onCopySelectedSubmissionTxHash: function () {
            var sHash = this._flowModel.getProperty("/selectedRequest/submission/txHash");
            if (sHash) {
                navigator.clipboard.writeText(sHash).then(function () {
                    MessageToast.show("Transaction hash copied");
                });
            }
        },

        onViewSelectedOnCardanoscan: function () {
            var sTxHash = this._flowModel.getProperty("/selectedRequest/submission/txHash");
            var sNetwork = this._flowModel.getProperty("/selectedRequest/network") || "preview";
            if (!sTxHash) return;

            var sBase = sNetwork === "mainnet"
                ? "https://cardanoscan.io"
                : "https://" + sNetwork + ".cardanoscan.io";
            var sUrl = sBase + "/transaction/" + sTxHash;
            window.open(sUrl, "_blank");
        },

        onNewTransaction: function () {
            this._clearSelectedRequest();
            // Reset build form state
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

        // ===== Inspector =====

        onCopyInspectorCbor: function () {
            var sCbor = this._flowModel.getProperty("/selectedRequest/unsignedTxCbor") ||
                        this._flowModel.getProperty("/selectedRequest/cip30TxCbor") ||
                        this._flowModel.getProperty("/build/unsignedTxCbor");
            if (sCbor) {
                navigator.clipboard.writeText(sCbor).then(function () {
                    MessageToast.show("CBOR copied");
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

        _startStatusPolling: function (sSubmissionId) {
            this._clearStatusPolling();

            if (!sSubmissionId) return;

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

                var oTxModel = that.getView().getModel("tx");
                if (!oTxModel) return;

                var sPath = "/TransactionSubmissions('" + sSubmissionId + "')/CardanoTransactionService.CheckSubmissionStatus(...)";
                var oCheckAction = oTxModel.bindContext(sPath);

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
