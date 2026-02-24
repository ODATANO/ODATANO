# SAP Integration Examples

This guide demonstrates how to integrate ODATANO with SAP systems, including OData consumption from S/4HANA, ABAP code templates, and enterprise use cases.

## Overview

ODATANO exposes Cardano blockchain data and transaction capabilities as standard OData V4 services. This enables seamless integration with any SAP system that supports OData consumption:

- **SAP S/4HANA** (on-premise and Cloud)
- **SAP BTP** (Business Technology Platform)
- **SAP Fiori / UI5** applications
- **ABAP-based systems** (ECC, BW, etc.)

## Architecture

```
┌────────────────────────────────────────────────────────┐
│                        SAP Landscape                   │
├────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  S/4HANA     │  │  SAP BTP     │  │  Fiori App   │  │
│  │  ABAP Report │  │  Integration │  │  (UI5)       │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  │
│         │                 │                 │          │
│         └─────────────────┴─────────────────┘          │
│                           │                            │
│                    OData V4 Requests                   │
└───────────────────────────┼────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│                      ODATANO Service                   │
├────────────────────────────────────────────────────────┤
│  /odata/v4/cardano-odata/      (Read Operations)       │
│  /odata/v4/cardano-transaction/ (TX Build & Submit)    │
│  /odata/v4/cardano-sign/        (External Signing)     │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│                    Cardano Blockchain                  │
│              (Preview / Preprod / Mainnet)             │
└────────────────────────────────────────────────────────┘
```

## BTP Deployment

### Service Catalog in SAP BTP Cockpit

Before deploying ODATANO to SAP BTP, you need to set up the environment and create a HANA instance.

![HANA DB](../assets/screenshots/hana_db.png)

After deploying ODATANO to BTP, the OData service and the wallet viewer app appear in the application dev space

![Dev Space Apps](../assets/screenshots/dev_space_apps.png)

### OData Destination Binding

To connect your SAP applications to the ODATANO OData services, create a destination in BTP and bind it to your service instance.

![Destination Configuration](../assets/screenshots/destination.png)

## Use API in SAP BUILD Process Automation

Add ODATANO_API Destination in your Process Automation project to call OData actions from your workflows. 

![SAP Build Destination](../assets/screenshots/sap_build_destination.png)

Now you can add ODATANO as Action in your workflow

![SAP Build Action1](../assets/screenshots/setup_action.png)

Explore the whole API and select the OData actions you want to use in your workflow, for example to get a specific block or transaction information from the Cardano blockchain. And use it in your workflow for example to get details of a payment transaction and use the information for further processing in your workflow.

![SAP Build Action2](../assets/screenshots/setup_action2.png)

## Example SAP Build Automation Scenario - ADA Invoice Check

A customer can send you a payment and submit the transaction hash to your workflow and you can use the transaction information to trigger further processing in your workflow.

![ADA Invoice Check](../assets/screenshots/ada_invoice_check.png)

The first Step and trigger is a simple Form provided over a public link to the customer to submit the details of the made payment transaction

![ADA Invoice Form](../assets/screenshots/ada_payment_form.png)

Now the workflow defined like above will fetch the transaction details from the Cardano blockchain with outputs and related assets and using the infomation to trigger a notification into your SAP Inbox with the details of the payment transaction and the attached assets to check the payment and confirm the payment details. 

![ADA Payment Notification](../assets/screenshots/inbox_form.png)

### Wallet Viewer Fiori App

The sample Wallet Viewer application running on BTP

![Fiori Wallet Viewer](../assets/screenshots/application_overview.png)


Start by connecting the App to one of your installed CIP-30 compatible wallets (e.g. Eternl, Lace, Vespr)

![App Start](../assets/screenshots/app_start.png)

*Visual documentation (screenshots of wallet connection flow, address overview, transaction details, and signature verifications) will be included with the Final Milestone delivery.*

## ABAP Integration Patterns

See [ABAP Code Examples](../abap examples/README.md) for detailed code snippets and templates to call ODATANO OData services from ABAP programs

## Enterprise Use Cases

### Use Case 1: Purchase Order Settlement on Cardano

Automated payment recording for cross-border purchase orders:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  SAP S/4HANA    │     │  ODATANO        │     │  Cardano        │
│  Purchase Order │────>│  Build TX       │ ───>│  Settlement TX  │
│  Released       │     │  (ADA Transfer) │     │  Recorded       │
└─────────────────┘     └─────────────────┘     └─────────────────┘
         │                                              │
         │              ┌─────────────────┐             │
         └─────────────▶│  FI Document    │◀───────────┘
                        │  with TX Hash   │
                        └─────────────────┘
```

**Workflow:**
1. Purchase Order released in S/4HANA
2. Background job calls ODATANO `BuildSimpleAdaTransaction`
3. Treasury signs via external wallet (hardware wallet)
4. Transaction submitted via `SubmitVerifiedTransaction` (CardanoSignService)
5. TX hash stored in custom field on FI document

### Use Case 2: CO₂ Certificate Tracking

Immutable tracking of carbon credits on Cardano:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  SAP EHS        │     │    ODATANO      │     │    Cardano      │
│  CO₂ Certificate│────>│  Metadata TX    │────>│  Certificate    │
│  Issued         │     │  (with CIP-25)  │     │  NFT Minted     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

**Benefits:**
- Tamper-proof audit trail
- Public verifiability
- Cross-company transparency

### Use Case 3: Inter-Company Settlements

Blockchain-based reconciliation between company codes:

```
Company A (DE10)                     Company B (US20)
      │                                    │
      │    ┌───────────────────────┐       │
      └──> │  Cardano Settlement   │ <─────┘
           │  TX (Multi-Sig)       │
           └───────────────────────┘
                     │
                     ▼
           ┌───────────────────────┐
           │  Both FI Ledgers      │
           │  Reference Same TX    │
           └───────────────────────┘
```

**Workflow:**
1. Company A initiates inter-company invoice
2. ODATANO builds multi-output transaction
3. Both treasuries sign (multi-sig via external signing)
4. Single TX settles both sides
5. TX hash recorded in both company codes

### Use Case 4: Audit Trail for FI/CO Postings

Anchor critical financial postings to Cardano:

```abap
* After posting FI document, anchor to Cardano
DATA: lv_doc_hash TYPE string,
      lv_tx_hash  TYPE string.

* Hash the FI document
lv_doc_hash = calculate_document_hash( lv_belnr ).

* Build metadata transaction with document hash
lv_tx_hash = call_odatano_metadata_tx(
  iv_metadata_label = '674'  " CIP-20 Message
  iv_metadata_value = lv_doc_hash ).

* Store TX hash on document
UPDATE bkpf SET zzblockchain_tx = lv_tx_hash
  WHERE bukrs = lv_bukrs
    AND belnr = lv_belnr
    AND gjahr = lv_gjahr.
```

## Related Documentation

- [Transaction Workflow Guide](TRANSACTION_WORKFLOW.md)
- [Wallet Viewer README](../../app/wallet-viewer/README.md)
- [Production Deployment](PRODUCTION_DEPLOYMENT.md)
- [Developer Guide](DEVELOPER_GUIDE.md)

---

