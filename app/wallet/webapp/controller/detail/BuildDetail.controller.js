sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageToast",
    "odatano/common/model/formatter"
], function (Controller, JSONModel, MessageToast, formatter) {
    "use strict";

    return Controller.extend("odatanoview.wallet.controller.detail.BuildDetail", {
        formatter: formatter,

        onInit: function () {
            this._oModel = new JSONModel({
                busy: true,
                id: "",
                network: "",
                builderEngine: "",
                senderAddress: "",
                changeAddress: "",
                unsignedTxCbor: "",
                txBodyHash: "",
                fee: "0",
                size: 0,
                createdAt: null,
                scriptHash: "",
                fingerprint: "",
                scriptAddress: "",
                wasSubmitted: false,
                inputs: [],
                outputs: [],
                inputCount: 0,
                outputCount: 0
            });
            this.getView().setModel(this._oModel, "detail");

            this.getOwnerComponent().getRouter()
                .getRoute("buildDetail")
                .attachPatternMatched(this._onRouteMatched, this);
        },

        _onRouteMatched: function (oEvent) {
            var sBuildId = oEvent.getParameter("arguments").buildId;
            this._oModel.setProperty("/busy", true);
            this._loadBuild(sBuildId);
        },

        _loadBuild: function (sBuildId) {
            var oTxModel = this.getOwnerComponent().getModel("tx");
            var that = this;

            // Read build with expanded inputs, outputs, submission
            var oListBinding = oTxModel.bindList("/TransactionBuilds", undefined, undefined, undefined, {
                $filter: "id eq " + sBuildId,
                $expand: "inputs,outputs,submission",
                $$ownRequest: true
            });

            oListBinding.requestContexts(0, 1).then(function (aContexts) {
                if (aContexts.length === 0) {
                    that._oModel.setProperty("/busy", false);
                    MessageToast.show("Transaction build not found");
                    return;
                }

                var oBuild = aContexts[0].getObject();
                var aInputs = oBuild.inputs || [];
                var aOutputs = oBuild.outputs || [];

                that._oModel.setData({
                    busy: false,
                    id: oBuild.id || sBuildId,
                    network: oBuild.network || "",
                    builderEngine: oBuild.builderEngine || "",
                    senderAddress: oBuild.senderAddress || "",
                    changeAddress: oBuild.changeAddress || "",
                    unsignedTxCbor: oBuild.unsignedTxCbor || "",
                    txBodyHash: oBuild.txBodyHash || "",
                    fee: oBuild.fee || "0",
                    size: oBuild.size || 0,
                    createdAt: oBuild.createdAt || null,
                    scriptHash: oBuild.scriptHash || "",
                    fingerprint: oBuild.fingerprint || "",
                    scriptAddress: oBuild.scriptAddress || "",
                    wasSubmitted: oBuild.wasSubmitted || false,
                    inputs: aInputs,
                    outputs: aOutputs,
                    inputCount: aInputs.length,
                    outputCount: aOutputs.length
                });
            }).catch(function () {
                that._oModel.setProperty("/busy", false);
                MessageToast.show("Failed to load transaction build");
            });
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

        onCopyId: function () {
            this._copy(this._oModel.getProperty("/id"), "Build ID copied");
        },

        onCopySenderAddress: function () {
            this._copy(this._oModel.getProperty("/senderAddress"), "Sender address copied");
        },

        onCopyChangeAddress: function () {
            this._copy(this._oModel.getProperty("/changeAddress"), "Change address copied");
        },

        onCopyTxBodyHash: function () {
            this._copy(this._oModel.getProperty("/txBodyHash"), "Tx body hash copied");
        },

        onCopyScriptHash: function () {
            this._copy(this._oModel.getProperty("/scriptHash"), "Script hash copied");
        },

        onCopyScriptAddress: function () {
            this._copy(this._oModel.getProperty("/scriptAddress"), "Script address copied");
        },

        onCopyCbor: function () {
            this._copy(this._oModel.getProperty("/unsignedTxCbor"), "CBOR copied");
        }
    });
});
