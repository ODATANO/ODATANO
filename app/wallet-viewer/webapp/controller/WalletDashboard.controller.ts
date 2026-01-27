import Controller from "sap/ui/core/mvc/Controller";
import JSONModel from "sap/ui/model/json/JSONModel";
import ODataModel from "sap/ui/model/odata/v4/ODataModel";
import MessageBox from "sap/m/MessageBox";
import MessageToast from "sap/m/MessageToast";
import Dialog from "sap/m/Dialog";
import Fragment from "sap/ui/core/Fragment";
import { getWalletService, WalletService } from "../wallet/WalletService";
import type { SigningRequest } from "../wallet/types/cip30";

/**
 * Wallet Dashboard Controller
 * @namespace odatanoview.walletviewer.controller
 */
export default class WalletDashboard extends Controller {
    private walletService!: WalletService;
    private sendModel!: JSONModel;
    private signingModel!: JSONModel;
    private sendAdaDialog: Dialog | null = null;
    private signTransactionDialog: Dialog | null = null;

    public onInit(): void {
        this.walletService = getWalletService();

        // Detect available wallets on init
        this.walletService.detectWallets();

        // Initialize send model
        this.sendModel = new JSONModel({
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
        this.getView()?.setModel(this.sendModel, "sendModel");

        // Initialize signing model
        this.signingModel = new JSONModel({
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
        this.getView()?.setModel(this.signingModel, "signing");
    }

    // --- Wallet Connection ---

    /**
     * Handle wallet selection from list
     */
    public async onWalletSelect(event: any): Promise<void> {
        const item = event.getParameter("listItem");
        const walletId = item?.getBindingContext("wallet")?.getProperty("id") as string;

        if (walletId) {
            await this.walletService.connect(walletId);
        }
    }

    /**
     * Disconnect from current wallet
     */
    public onDisconnect(): void {
        this.walletService.disconnect();
    }

    /**
     * Refresh wallet data
     */
    public async onRefreshWallet(): Promise<void> {
        await this.walletService.refresh();
    }

    // --- Address Actions ---

    /**
     * Handle address press - copy primary address to clipboard
     */
    public onAddressPress(): void {
        const address = this.walletService.getPrimaryAddress();
        if (address) {
            void navigator.clipboard.writeText(address).then(() => {
                MessageToast.show("Address copied to clipboard");
            });
        }
    }

    /**
     * Handle address item press from list - copy to clipboard
     */
    public onAddressItemPress(event: any): void {
        const item = event.getSource();
        const address = item.getBindingContext("wallet")?.getProperty("bech32") as string;

        if (address) {
            void navigator.clipboard.writeText(address).then(() => {
                MessageToast.show("Address copied to clipboard");
            });
        }
    }

    /**
     * Copy change address to clipboard
     */
    public onCopyChangeAddress(): void {
        const changeAddress = this.walletService.getChangeAddress();
        if (changeAddress) {
            void navigator.clipboard.writeText(changeAddress).then(() => {
                MessageToast.show("Change address copied to clipboard");
            });
        }
    }

    /**
     * Handle stake address press
     */
    public onStakeAddressPress(event: any): void {
        const item = event.getSource();
        const stakeAddress = item.getBindingContext("wallet")?.getObject() as string;

        if (stakeAddress) {
            void navigator.clipboard.writeText(stakeAddress).then(() => {
                MessageToast.show("Stake address copied to clipboard");
            });
        }
    }

    // --- Send ADA Workflow ---

    /**
     * Open Send ADA dialog
     */
    public async onSendAda(): Promise<void> {
        const primaryAddress = this.walletService.getPrimaryAddress();
        const balance = this.walletService.getModel().getProperty("/balance/lovelace") as string;

        if (!primaryAddress) {
            MessageBox.warning("No address found in wallet");
            return;
        }

        // Reset send model
        this.sendModel.setData({
            senderAddress: primaryAddress,
            recipientAddress: "",
            adaAmount: "",
            availableBalance: balance || "0",
            recipientAddressState: "None",
            recipientAddressStateText: "",
            amountState: "None",
            amountStateText: "",
            canContinue: false,
            error: null
        });

        if (!this.sendAdaDialog) {
            this.sendAdaDialog = (await Fragment.load({
                id: this.getView()?.getId(),
                name: "odatanoview.walletviewer.view.fragment.SendAda",
                controller: this
            })) as Dialog;
            this.getView()?.addDependent(this.sendAdaDialog);
        }

        this.sendAdaDialog.open();
    }

    /**
     * Validate recipient address on change
     */
    public onRecipientAddressChange(event: any): void {
        const value = (event.getParameter("newValue") as string)?.trim();

        if (!value) {
            this.sendModel.setProperty("/recipientAddressState", "None");
            this.sendModel.setProperty("/recipientAddressStateText", "");
        } else if (value.startsWith("addr1") || value.startsWith("addr_test1")) {
            if (value.length >= 50) {
                this.sendModel.setProperty("/recipientAddressState", "Success");
                this.sendModel.setProperty("/recipientAddressStateText", "");
            } else {
                this.sendModel.setProperty("/recipientAddressState", "Warning");
                this.sendModel.setProperty("/recipientAddressStateText", "Address seems incomplete");
            }
        } else {
            this.sendModel.setProperty("/recipientAddressState", "Error");
            this.sendModel.setProperty("/recipientAddressStateText", "Must start with addr1 or addr_test1");
        }

        this.validateSendForm();
    }

    /**
     * Validate amount on change
     */
    public onAmountChange(event: any): void {
        const value = event.getParameter("newValue") as string;
        const numValue = parseFloat(value);
        const availableLovelace = BigInt(this.sendModel.getProperty("/availableBalance") || "0");
        const availableAda = Number(availableLovelace) / 1_000_000;

        if (!value) {
            this.sendModel.setProperty("/amountState", "None");
            this.sendModel.setProperty("/amountStateText", "");
        } else if (isNaN(numValue) || numValue <= 0) {
            this.sendModel.setProperty("/amountState", "Error");
            this.sendModel.setProperty("/amountStateText", "Must be a positive number");
        } else if (numValue < 1) {
            this.sendModel.setProperty("/amountState", "Warning");
            this.sendModel.setProperty("/amountStateText", "Minimum is typically ~1 ADA");
        } else if (numValue > availableAda) {
            this.sendModel.setProperty("/amountState", "Error");
            this.sendModel.setProperty("/amountStateText", "Exceeds available balance");
        } else {
            this.sendModel.setProperty("/amountState", "Success");
            this.sendModel.setProperty("/amountStateText", "");
        }

        this.validateSendForm();
    }

    /**
     * Check if send form is valid
     */
    private validateSendForm(): void {
        const recipientState = this.sendModel.getProperty("/recipientAddressState");
        const amountState = this.sendModel.getProperty("/amountState");
        const recipientAddress = this.sendModel.getProperty("/recipientAddress") as string;
        const amount = this.sendModel.getProperty("/adaAmount") as string;

        const isValid =
            recipientAddress?.length >= 50 &&
            (recipientAddress.startsWith("addr1") || recipientAddress.startsWith("addr_test1")) &&
            parseFloat(amount) > 0 &&
            recipientState !== "Error" &&
            amountState !== "Error";

        this.sendModel.setProperty("/canContinue", isValid);
    }

    /**
     * Continue to signing after entering send details
     */
    public async onContinueSend(): Promise<void> {
        const senderAddress = this.sendModel.getProperty("/senderAddress") as string;
        const recipientAddress = this.sendModel.getProperty("/recipientAddress") as string;
        const adaAmount = parseFloat(this.sendModel.getProperty("/adaAmount") as string);
        const lovelaceAmount = Math.floor(adaAmount * 1_000_000).toString();

        this.sendAdaDialog?.close();

        await this.buildAndSign(senderAddress, recipientAddress, lovelaceAmount);
    }

    /**
     * Cancel send dialog
     */
    public onCancelSend(): void {
        this.sendAdaDialog?.close();
    }

    // --- Transaction Building and Signing ---

    /**
     * Build transaction and open signing dialog
     */
    private async buildAndSign(
        senderAddress: string,
        recipientAddress: string,
        lovelaceAmount: string
    ): Promise<void> {
        const txModel = this.getView()?.getModel("tx") as ODataModel;
        if (!txModel) return;

        // Reset and show signing dialog
        this.signingModel.setData({
            busy: true,
            signed: false,
            buildId: null,
            signingRequestId: null,
            txBodyHash: null,
            unsignedTxCbor: null,
            recipientAddress: recipientAddress,
            lovelaceAmount: lovelaceAmount,
            network: null,
            networkMismatch: false,
            statusMessage: "Building transaction...",
            statusType: "Information",
            dialogState: "None"
        });

        if (!this.signTransactionDialog) {
            this.signTransactionDialog = (await Fragment.load({
                id: this.getView()?.getId(),
                name: "odatanoview.walletviewer.view.fragment.SignTransaction",
                controller: this
            })) as Dialog;
            this.getView()?.addDependent(this.signTransactionDialog);
        }

        this.signTransactionDialog.open();

        try {
            // Step 1: Build transaction via OData action
            const buildAction = txModel.bindContext("/BuildSimpleAdaTransaction(...)");
            buildAction.setParameter("senderAddress", senderAddress);
            buildAction.setParameter("recipientAddress", recipientAddress);
            buildAction.setParameter("lovelaceAmount", lovelaceAmount);
            buildAction.setParameter("changeAddress", this.walletService.getChangeAddress() || senderAddress);

            await buildAction.execute();
            const buildResult = buildAction.getBoundContext()?.getObject() as any;

            if (!buildResult?.id) {
                throw new Error("Transaction build failed - no build ID returned");
            }

            this.signingModel.setProperty("/buildId", buildResult.id);
            this.signingModel.setProperty("/statusMessage", "Creating signing request...");

            // Step 2: Create signing request
            const signingAction = txModel.bindContext("/CreateSigningRequest(...)");
            signingAction.setParameter("buildId", buildResult.id);
            await signingAction.execute();

            const signingRequest = signingAction.getBoundContext()?.getObject() as any;

            if (!signingRequest?.id) {
                throw new Error("Failed to create signing request");
            }

            // Update signing model with request details
            this.signingModel.setProperty("/signingRequestId", signingRequest.id);
            this.signingModel.setProperty("/txBodyHash", signingRequest.txBodyHash);
            this.signingModel.setProperty("/unsignedTxCbor", signingRequest.cip30TxCbor || signingRequest.unsignedTxCbor);
            this.signingModel.setProperty("/network", signingRequest.network);

            // Check network mismatch
            const walletNetwork = this.walletService.getNetwork();
            const txNetwork = signingRequest.network;
            const mismatch = walletNetwork !== null && walletNetwork !== txNetwork;
            this.signingModel.setProperty("/networkMismatch", mismatch);

            this.signingModel.setProperty("/statusMessage", "Ready to sign");
            this.signingModel.setProperty("/statusType", "Success");
            this.signingModel.setProperty("/busy", false);

        } catch (error: any) {
            console.error("Transaction build failed:", error);
            this.signingModel.setProperty("/statusMessage", error.message || "Transaction build failed");
            this.signingModel.setProperty("/statusType", "Error");
            this.signingModel.setProperty("/dialogState", "Error");
            this.signingModel.setProperty("/busy", false);
        }
    }

    /**
     * Confirm and execute signing
     */
    public async onConfirmSign(): Promise<void> {
        this.signingModel.setProperty("/busy", true);
        this.signingModel.setProperty("/statusMessage", "Requesting signature from wallet...");
        this.signingModel.setProperty("/statusType", "Information");

        try {
            const signingRequest: SigningRequest = {
                signingRequestId: this.signingModel.getProperty("/signingRequestId") as string,
                buildId: this.signingModel.getProperty("/buildId") as string,
                unsignedTxCbor: this.signingModel.getProperty("/unsignedTxCbor") as string,
                txBodyHash: this.signingModel.getProperty("/txBodyHash") as string,
                network: this.signingModel.getProperty("/network") as string,
                expiresAt: ""
            };

            // Sign with wallet
            const result = await this.walletService.signTransaction(signingRequest);

            if (!result.success || !result.signedTxCbor) {
                throw new Error(result.error || "Signing failed");
            }

            // Submit signed transaction
            this.signingModel.setProperty("/statusMessage", "Submitting transaction...");

            const txModel = this.getView()?.getModel("tx") as ODataModel;
            const submitAction = txModel.bindContext("/SubmitVerifiedTransaction(...)");
            submitAction.setParameter("signingRequestId", signingRequest.signingRequestId);
            submitAction.setParameter("signedTxCbor", result.signedTxCbor);
            submitAction.setParameter("signerType", "browser-wallet");
            submitAction.setParameter("signerInfo", this.walletService.getModel().getProperty("/walletName") as string);

            await submitAction.execute();
            const submission = submitAction.getBoundContext()?.getObject() as any;

            this.signingModel.setProperty("/signed", true);
            this.signingModel.setProperty("/statusMessage", `Transaction submitted! Hash: ${submission?.txHash || result.txHash}`);
            this.signingModel.setProperty("/statusType", "Success");
            this.signingModel.setProperty("/dialogState", "Success");

            MessageToast.show("Transaction submitted successfully!");

            // Refresh wallet balance
            void this.walletService.refresh();

        } catch (error: any) {
            console.error("Signing/submission failed:", error);
            this.signingModel.setProperty("/statusMessage", error.message || "Signing failed");
            this.signingModel.setProperty("/statusType", "Error");
            this.signingModel.setProperty("/dialogState", "Error");
        } finally {
            this.signingModel.setProperty("/busy", false);
        }
    }

    /**
     * Cancel signing dialog
     */
    public onCancelSign(): void {
        this.signTransactionDialog?.close();

        this.signingModel.setData({
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
}
