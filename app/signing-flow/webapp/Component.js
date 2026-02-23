sap.ui.define([
    "sap/ui/core/UIComponent",
    "sap/ui/model/json/JSONModel",
    "./model/models",
    "odatano/common/wallet/WalletService"
], function (UIComponent, JSONModel, models, WalletService) {
    "use strict";

    return UIComponent.extend("odatanoview.signingflow.Component", {

        metadata: {
            manifest: "json",
            interfaces: ["sap.ui.core.IAsyncContentCreation"]
        },

        init: function () {
            UIComponent.prototype.init.apply(this, arguments);

            this.setModel(models.createDeviceModel(), "device");

            var walletService = WalletService.getInstance();
            this.setModel(walletService.getModel(), "wallet");
            walletService.detectWallets();

            // HSM model
            this.setModel(new JSONModel({
                connected: false,
                keyId: null,
                keyLabel: null,
                publicKeyHash: null,
                cardanoAddress: null,
                loading: true
            }), "hsm");

            this.getRouter().initialize();
        },

        getContentDensityClass: function () {
            var deviceModel = this.getModel("device");
            var isTouch = deviceModel ? deviceModel.getProperty("/support/touch") : false;
            return isTouch ? "sapUiSizeCozy" : "sapUiSizeCompact";
        }
    });
});
