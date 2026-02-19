CLASS zcl_odatano_test DEFINITION
  PUBLIC FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    INTERFACES if_oo_adt_classrun.

ENDCLASS.


CLASS zcl_odatano_test IMPLEMENTATION.

METHOD if_oo_adt_classrun~main.

    DATA(lv_url) = |your_odatano_url|.
    DATA(lv_token_url) = |your_oauth_token_url|.
    DATA(lv_client_id) = |your_client_id|.
    DATA(lv_client_secret) = |your_client_secret|.

    out->write( |=== ODATANO M3 ABAP Integration Tests ===| ).
    out->write( | | ).

    " -----------------------------------------------------------
    " TEST 1: Goods Receipt Hashing (offline)
    " -----------------------------------------------------------
    out->write( |--- Test 1: Goods Receipt Hash ---| ).

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
    " TEST 2: Network Health Check
    " -----------------------------------------------------------
    out->write( |--- Test 2: Cardano Network Health ---| ).

    DATA(lo_monitor) = NEW zcl_cardano_monitor( ).
    TRY.
        DATA(ls_health) = lo_monitor->get_health_status(
          iv_odatano_url   = lv_url
          iv_token_url     = lv_token_url
          iv_client_id     = lv_client_id
          iv_client_secret = lv_client_secret
        ).
        out->write( |Network:   { ls_health-network }| ).
        out->write( |Healthy:   { ls_health-is_healthy }| ).
        out->write( |Epoch:     { ls_health-current_epoch }| ).
        out->write( |Epoch Txs: { ls_health-tx_count }| ).
        out->write( |Response:  { ls_health-response_time_ms }ms| ).
      CATCH cx_root INTO DATA(lx_net).
        out->write( |Network check failed: { lx_net->get_text( ) }| ).
    ENDTRY.

    out->write( | | ).

    " -----------------------------------------------------------
    " TEST 3: Goods Receipt → Transaction Build with Document Hash Metadata
    " -----------------------------------------------------------
    out->write( |--- Test 3: Record Goods Receipt with Metadata Hash ---| ).

    DATA(lo_gr) = NEW zcl_gr_blockchain(
      iv_odatano_url       = lv_url
      iv_sender_address    = 'addr_test1qrvzl5l0aq56ha2vqjmj04562jckr9ruqqtckvalcugprq79ypxttd5pkvqnvs33dvs6jrtrcr3cqf654gvze2nj35ksu2dtx5'
      iv_recipient_address = 'addr_test1qrgfq5jeznaehnf4zs02laas2juuuyzlz48tkue50luuws2nrznmesueg7drstsqaaenq6qpcnvqvn0kessd9fw2wxys6tv622'
      iv_token_url         = lv_token_url
      iv_client_id         = lv_client_id
      iv_client_secret     = lv_client_secret
    ).

    TRY.
        DATA(ls_audit) = lo_gr->record_goods_receipt( ls_receipt ).
        out->write( |Build ID:         { ls_audit-build_id }| ).
        out->write( |Doc Hash:         { ls_audit-document_hash }| ).
        out->write( |Transaction Hash: { ls_audit-blockchain_tx_hash }| ).
        out->write( |Status:           { ls_audit-blockchain_status }| ).
      CATCH cx_root INTO DATA(lx_gr).
        out->write( |GR recording failed: { lx_gr->get_text( ) }| ).
    ENDTRY.

    if ( ls_audit-build_id is not initial ).


    endif.

    out->write( | | ).

    " -----------------------------------------------------------
    " TEST 4: Address Verification
    " -----------------------------------------------------------
    out->write( |--- Test 4: Address Verification ---| ).

    DATA(lo_check) = NEW zcl_cardano_addr_check(
      iv_odatano_url   = lv_url
      iv_token_url     = lv_token_url
      iv_client_id     = lv_client_id
      iv_client_secret = lv_client_secret
    ).

    TRY.
        DATA(ls_result) = lo_check->verify_address_for_payment(
          iv_address = 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8'
        ).
        out->write( |Type:    { ls_result-type }| ).
        out->write( |Balance: { ls_result-balance_ada } ADA| ).
        out->write( |Message: { ls_result-message }| ).
      CATCH cx_root INTO DATA(lx_addr).
        out->write( |Address check failed: { lx_addr->get_text( ) }| ).
    ENDTRY.

    out->write( | | ).
    out->write( |=== Tests Complete ===| ).

  ENDMETHOD.

ENDCLASS.
