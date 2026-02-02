import BaseComponent from "sap/ui/core/UIComponent";
import { createDeviceModel } from "./model/models";
import JSONModel from "sap/ui/model/json/JSONModel";
import { getWalletService } from "./wallet/WalletService";

/**
 * Cardano Wallet Viewer Component
 * @namespace odatanoview.walletviewer
 */
export default class Component extends BaseComponent {

    public static metadata = {
        manifest: "json",
        interfaces: [
            "sap.ui.core.IAsyncContentCreation"
        ]
    };

    public init(): void {
        // call the base component's init function
        super.init();

        // set the device model
        this.setModel(createDeviceModel(), "device");

        // Initialize wallet service and set model globally
        const walletService = getWalletService();
        this.setModel(walletService.getModel(), "wallet");
        walletService.detectWallets();

        // enable routing
        this.getRouter().initialize();
    }

    /**
     * Get content density class based on device
     */
    public getContentDensityClass(): string {
        const deviceModel = this.getModel("device") as JSONModel;
        const isTouch = deviceModel?.getProperty("/support/touch");
        return isTouch ? "sapUiSizeCozy" : "sapUiSizeCompact";
    }
}
