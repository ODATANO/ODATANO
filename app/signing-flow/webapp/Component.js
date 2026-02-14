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

            this.getRouter().initialize();
        },

        getContentDensityClass: function () {
            var deviceModel = this.getModel("device");
            var isTouch = deviceModel ? deviceModel.getProperty("/support/touch") : false;
            return isTouch ? "sapUiSizeCozy" : "sapUiSizeCompact";
        }
    });
});
