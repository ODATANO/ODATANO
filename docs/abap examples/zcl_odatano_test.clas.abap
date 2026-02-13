CLASS zcl_odatano_test DEFINITION
  PUBLIC FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    INTERFACES if_oo_adt_classrun.

ENDCLASS.


CLASS zcl_odatano_test IMPLEMENTATION.

  METHOD if_oo_adt_classrun~main.

    " ============================================================
    " ODATANO Service URL - change this to your deployed instance
    " ============================================================
    DATA(lv_url) = |https://your-odatano.cfapps.us10.hana.ondemand.com|.

    out->write( |=== ODATANO M3 Integration Test ===| ).
    out->write( | | ).

    " -----------------------------------------------------------
    " TEST 1: Goods Receipt Hashing & Audit Log (works offline)
    " -----------------------------------------------------------
    out->write( |--- Test 1: Goods Receipt Hash & Audit Log ---| ).

    DATA(lo_gr) = NEW zcl_gr_blockchain(
      iv_odatano_url       = lv_url
      iv_sender_address    = 'addr_test1qzexample...'
      iv_recipient_address = 'addr_test1qzexample...'
    ).

    DATA(ls_receipt) = VALUE zcl_gr_blockchain=>ty_goods_receipt(
      document_no   = '5000000001'
      document_type = 'GOODS_RECEIPT'
      document_year = '2026'
      plant         = '1000'
      material      = 'RAW-STEEL-001'
      quantity      = '500.000'
      unit          = 'KG'
      posting_date  = sy-datum
      vendor        = 'SUPPLIER-DE-42'
    ).

    " Test hashing only (no HTTP call needed)
    DATA(lv_canonical) =
      |{ ls_receipt-document_no }| &&
      |{ ls_receipt-document_type }| &&
      |{ ls_receipt-document_year }| &&
      |{ ls_receipt-plant }| &&
      |{ ls_receipt-material }| &&
      |{ ls_receipt-quantity }| &&
      |{ ls_receipt-unit }| &&
      |{ ls_receipt-posting_date }| &&
      |{ ls_receipt-vendor }|.

    DATA lv_hash TYPE string.
    TRY.
        cl_abap_message_digest=>calculate_hash_for_char(
          EXPORTING if_algorithm  = 'SHA256'
                    if_data       = lv_canonical
          IMPORTING ef_hashstring = lv_hash
        ).
        out->write( |Document Hash (SHA256): { lv_hash }| ).
      CATCH cx_abap_message_digest INTO DATA(lx_hash).
        out->write( |Hash Error: { lx_hash->get_text( ) }| ).
    ENDTRY.

    out->write( | | ).

    " -----------------------------------------------------------
    " TEST 2: Network Health Check (requires running ODATANO)
    " -----------------------------------------------------------
    out->write( |--- Test 2: Cardano Network Health ---| ).

    DATA(lo_monitor) = NEW zcl_cardano_monitor( ).

    TRY.
        DATA(ls_health) = lo_monitor->get_health_status( lv_url ).
        out->write( |Network:  { ls_health-network }| ).
        out->write( |Healthy:  { ls_health-is_healthy }| ).
        out->write( |Epoch:    { ls_health-current_epoch }| ).
        out->write( |Slot:     { ls_health-current_slot }| ).
        out->write( |Block:    { ls_health-latest_block }| ).
        out->write( |Response: { ls_health-response_time_ms }ms| ).
      CATCH cx_root INTO DATA(lx_net).
        out->write( |Network check failed (ODATANO not reachable): { lx_net->get_text( ) }| ).
    ENDTRY.

    out->write( | | ).

    " -----------------------------------------------------------
    " TEST 3: Full Goods Receipt → Blockchain (requires ODATANO)
    " -----------------------------------------------------------
    out->write( |--- Test 3: Record Goods Receipt on Blockchain ---| ).

    TRY.
        DATA(ls_audit) = lo_gr->record_goods_receipt( ls_receipt ).
        out->write( |Build ID: { ls_audit-build_id }| ).
        out->write( |Doc Hash: { ls_audit-document_hash }| ).
        out->write( |Status:   { ls_audit-blockchain_status }| ).
        out->write( |Audit UUID: { ls_audit-audit_uuid }| ).
      CATCH cx_root INTO DATA(lx_gr).
        out->write( |Goods Receipt recording failed (ODATANO not reachable): { lx_gr->get_text( ) }| ).
    ENDTRY.

    out->write( | | ).

    " -----------------------------------------------------------
    " TEST 4: Address Verification (requires ODATANO)
    " -----------------------------------------------------------
    out->write( |--- Test 4: Address Verification ---| ).

    DATA(lo_check) = NEW zcl_cardano_addr_check( lv_url ).

    TRY.
        DATA(ls_result) = lo_check->verify_address_for_payment(
          iv_address = 'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae'
        ).
        out->write( |Valid:   { ls_result-is_valid }| ).
        out->write( |Balance: { ls_result-balance_ada } ADA| ).
        out->write( |Message: { ls_result-message }| ).
      CATCH cx_root INTO DATA(lx_addr).
        out->write( |Address check failed (ODATANO not reachable): { lx_addr->get_text( ) }| ).
    ENDTRY.

    out->write( | | ).
    out->write( |=== Tests Complete ===| ).

  ENDMETHOD.

ENDCLASS.
