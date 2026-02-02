/// <reference types="@sapui5/ts-types-esm" />
/// <reference lib="dom" />

import type { CardanoNamespace } from "./wallet/types/cip30";

// Extend global Window interface for Cardano wallets
declare global {
    // Ensure window is available
    var window: Window & typeof globalThis;

    interface Window {
        cardano?: CardanoNamespace;
    }
}

export {};
