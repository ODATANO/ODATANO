sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageToast",
    "odatano/common/model/formatter"
], function (Controller, JSONModel, MessageToast, formatter) {
    "use strict";

    return Controller.extend("odatanoview.wallet.controller.detail.SigningRequestDetail", {
        formatter: formatter,

        onInit: function () {
            this._oModel = new JSONModel({
                busy: true,
                id: "",
                txBodyHash: "",
                unsignedTxCbor: "",
                cip30TxCbor: "",
                network: "",
                status: "",
                createdAt: null,
                expiresAt: null,
                signedAt: null,
                submittedAt: null,
                cardanoCliCommand: "",
                signerType: "",
                signerInfo: "",
                hsmKeyId: "",
                errorMessage: "",
                verifications: [],
                verificationCount: 0,
                submission: null
            });
            this.getView().setModel(this._oModel, "detail");

            this.getOwnerComponent().getRouter()
                .getRoute("signingRequestDetail")
                .attachPatternMatched(this._onRouteMatched, this);
        },

        _onRouteMatched: function (oEvent) {
            var sRequestId = oEvent.getParameter("arguments").requestId;
            this._oModel.setProperty("/busy", true);
            this._loadSigningRequest(sRequestId);
        },

        _loadSigningRequest: function (sRequestId) {
            var oSignModel = this.getOwnerComponent().getModel("sign");
            var that = this;

            var oListBinding = oSignModel.bindList("/SigningRequests", undefined, undefined, undefined, {
                $filter: "id eq " + sRequestId,
                $expand: "verifications,submission",
                $$ownRequest: true
            });

            oListBinding.requestContexts(0, 1).then(function (aContexts) {
                if (aContexts.length === 0) {
                    that._oModel.setProperty("/busy", false);
                    MessageToast.show("Signing request not found");
                    return;
                }

                var oReq = aContexts[0].getObject();
                var aVerifications = oReq.verifications || [];

                that._oModel.setData({
                    busy: false,
                    id: oReq.id || sRequestId,
                    txBodyHash: oReq.txBodyHash || "",
                    unsignedTxCbor: oReq.unsignedTxCbor || "",
                    cip30TxCbor: oReq.cip30TxCbor || "",
                    network: oReq.network || "",
                    status: oReq.status || "",
                    createdAt: oReq.createdAt || null,
                    expiresAt: oReq.expiresAt || null,
                    signedAt: oReq.signedAt || null,
                    submittedAt: oReq.submittedAt || null,
                    cardanoCliCommand: oReq.cardanoCliCommand || "",
                    signerType: oReq.signerType || "",
                    signerInfo: oReq.signerInfo || "",
                    hsmKeyId: oReq.hsmKeyId || "",
                    errorMessage: oReq.errorMessage || "",
                    verifications: aVerifications,
                    verificationCount: aVerifications.length,
                    submission: oReq.submission || null
                });
            }).catch(function () {
                that._oModel.setProperty("/busy", false);
                MessageToast.show("Failed to load signing request");
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
            this._copy(this._oModel.getProperty("/id"), "Request ID copied");
        },

        onCopyTxBodyHash: function () {
            this._copy(this._oModel.getProperty("/txBodyHash"), "Tx body hash copied");
        },

        onCopyUnsignedCbor: function () {
            this._copy(this._oModel.getProperty("/unsignedTxCbor"), "Unsigned CBOR copied");
        },

        onCopyCip30Cbor: function () {
            this._copy(this._oModel.getProperty("/cip30TxCbor"), "CIP-30 CBOR copied");
        },

        onCopyCliCommand: function () {
            this._copy(this._oModel.getProperty("/cardanoCliCommand"), "CLI command copied");
        },

        onCopySubmissionTxHash: function () {
            var oSubmission = this._oModel.getProperty("/submission");
            if (oSubmission && oSubmission.txHash) {
                this._copy(oSubmission.txHash, "Transaction hash copied");
            }
        },

        onViewOnCardanoscan: function () {
            var oSubmission = this._oModel.getProperty("/submission");
            if (!oSubmission || !oSubmission.txHash) { return; }
            var sNetwork = this._oModel.getProperty("/network") || "preview";
            var sUrl = formatter.getCardanoscanUrl(oSubmission.txHash, sNetwork);
            window.open(sUrl, "_blank");
        }
    });
});
