sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageToast",
    "odatanoview/wallet/model/formatter"
], function (Controller, JSONModel, MessageToast, formatter) {
    "use strict";

    return Controller.extend("odatanoview.wallet.controller.detail.TransactionDetail", {
        formatter: formatter,

        onInit: function () {
            this._oModel = new JSONModel({
                busy: true,
                hash: "",
                blockHash: "",
                blockHeight: 0,
                blockTime: 0,
                slot: 0,
                fee: "0",
                deposit: "0",
                size: 0,
                inputs: [],
                outputs: [],
                metadata: [],
                inputCount: 0,
                outputCount: 0,
                metadataCount: 0
            });
            this.getView().setModel(this._oModel, "detail");

            this.getOwnerComponent().getRouter()
                .getRoute("transactionDetail")
                .attachPatternMatched(this._onRouteMatched, this);
        },

        _onRouteMatched: function (oEvent) {
            var sTxHash = oEvent.getParameter("arguments").txHash;
            this._oModel.setProperty("/busy", true);
            this._loadTransaction(sTxHash);
        },

        _loadTransaction: function (sTxHash) {
            var oODataModel = this.getOwnerComponent().getModel();
            var that = this;

            // Step 1: Ensure transaction is indexed (lazy indexing)
            var oAction = oODataModel.bindContext("/GetTransactionByHash(...)");
            oAction.setParameter("hash", sTxHash);
            oAction.execute().then(function () {
                // Step 2: Read full transaction with expanded compositions
                return that._readTransactionEntity(sTxHash);
            }).catch(function () {
                // GetTransactionByHash may fail if already indexed, try direct read
                return that._readTransactionEntity(sTxHash);
            }).catch(function () {
                that._oModel.setProperty("/busy", false);
                MessageToast.show("Failed to load transaction");
            });
        },

        _readTransactionEntity: function (sTxHash) {
            var oODataModel = this.getOwnerComponent().getModel();
            var that = this;

            var oListBinding = oODataModel.bindList("/Transactions", undefined, undefined, undefined, {
                $filter: "hash eq '" + sTxHash + "'",
                $select: "hash,blockHash,blockHeight,blockTime,slot,fee,deposit,size,hasMetadata,hasInputs,hasOutputs",
                $expand: "inputs($expand=assets),outputs($expand=assets),metadata",
                $$ownRequest: true
            });

            return oListBinding.requestContexts(0, 1).then(function (aContexts) {
                if (aContexts.length === 0) {
                    that._oModel.setProperty("/busy", false);
                    MessageToast.show("Transaction not found");
                    return;
                }

                var oTx = aContexts[0].getObject();
                var aInputs = (oTx.inputs || []).map(function (inp) {
                    // Compute lovelace from input assets
                    var sLovelace = "0";
                    if (inp.assets) {
                        var oLov = inp.assets.find(function (a) { return a.unit === "lovelace"; });
                        if (oLov) { sLovelace = String(oLov.asset_quantity || 0); }
                    }
                    return {
                        address_address: inp.address_address || "",
                        isCollateral: inp.isCollateral || false,
                        isReference: inp.isReference || false,
                        lovelace: sLovelace
                    };
                });

                var aOutputs = (oTx.outputs || []).map(function (out) {
                    // Compute lovelace from output assets
                    var sLovelace = "0";
                    var aNativeAssets = [];
                    if (out.assets) {
                        out.assets.forEach(function (a) {
                            if (a.unit === "lovelace") {
                                sLovelace = String(a.asset_quantity || 0);
                            } else {
                                aNativeAssets.push(a);
                            }
                        });
                    }
                    return {
                        address_address: out.address_address || "",
                        lovelace: sLovelace,
                        nativeAssets: aNativeAssets,
                        hasNativeAssets: aNativeAssets.length > 0
                    };
                });

                var aMetadata = oTx.metadata || [];

                that._oModel.setData({
                    busy: false,
                    hash: oTx.hash || sTxHash,
                    blockHash: oTx.blockHash || "",
                    blockHeight: oTx.blockHeight || 0,
                    blockTime: oTx.blockTime || 0,
                    slot: oTx.slot || 0,
                    fee: oTx.fee || "0",
                    deposit: oTx.deposit || "0",
                    size: oTx.size || 0,
                    network: that._getNetwork(),
                    inputs: aInputs,
                    outputs: aOutputs,
                    metadata: aMetadata,
                    inputCount: aInputs.length,
                    outputCount: aOutputs.length,
                    metadataCount: aMetadata.length
                });
            });
        },

        _getNetwork: function () {
            var oWalletModel = this.getOwnerComponent().getModel("wallet");
            return oWalletModel ? (oWalletModel.getProperty("/networkName") || "Preview") : "Preview";
        },

        onNavBack: function () {
            this.getOwnerComponent().getRouter().navTo("wallet");
        },

        _copy: function (sText, sMsg) {
            if (sText) {
                navigator.clipboard.writeText(sText).then(function () {
                    MessageToast.show(sMsg || "Copied");
                });
            }
        },

        onCopyHash: function () {
            this._copy(this._oModel.getProperty("/hash"), "Transaction hash copied");
        },

        onCopyBlockHash: function () {
            this._copy(this._oModel.getProperty("/blockHash"), "Block hash copied");
        },

        onViewOnCardanoscan: function () {
            var sHash = this._oModel.getProperty("/hash");
            if (!sHash) { return; }
            var oWalletModel = this.getOwnerComponent().getModel("wallet");
            var sNetwork = oWalletModel ? oWalletModel.getProperty("/networkName") : "Preview";
            var sUrl = formatter.getCardanoscanUrl(sHash, sNetwork === "Mainnet" ? "mainnet" : "preview");
            window.open(sUrl, "_blank");
        }
    });
});
