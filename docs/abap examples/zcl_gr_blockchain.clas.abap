CLASS zcl_gr_blockchain DEFINITION
  PUBLIC FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.

    TYPES:
      BEGIN OF ty_goods_receipt,
        document_no   TYPE string,
        document_type TYPE string,
        document_year TYPE string,
        plant         TYPE string,
        material      TYPE string,
        quantity      TYPE p LENGTH 13 DECIMALS 3,
        unit          TYPE string,
        posting_date  TYPE d,
        vendor        TYPE string,
      END OF ty_goods_receipt.

    METHODS constructor
      IMPORTING iv_odatano_url       TYPE string
                iv_sender_address    TYPE string
                iv_recipient_address TYPE string.

    METHODS record_goods_receipt
      IMPORTING is_goods_receipt      TYPE ty_goods_receipt
      RETURNING VALUE(rs_audit_entry) TYPE zodatano_bc_log
      RAISING   cx_http_dest_provider_error
                cx_web_http_client_error.

    METHODS verify_goods_receipt
      IMPORTING is_goods_receipt   TYPE ty_goods_receipt
                iv_tx_hash         TYPE string
      RETURNING VALUE(rv_verified) TYPE abap_bool
      RAISING   cx_http_dest_provider_error
                cx_web_http_client_error.

  PRIVATE SECTION.

    DATA mo_client            TYPE REF TO zcl_odatano_client.
    DATA mv_sender_address    TYPE string.
    DATA mv_recipient_address TYPE string.

    METHODS compute_document_hash
      IMPORTING is_goods_receipt TYPE ty_goods_receipt
      RETURNING VALUE(rv_hash)   TYPE string.

    METHODS build_metadata_json
      IMPORTING is_goods_receipt TYPE ty_goods_receipt
                iv_document_hash TYPE string
      RETURNING VALUE(rv_json)   TYPE string.

ENDCLASS.


CLASS zcl_gr_blockchain IMPLEMENTATION.

  METHOD constructor.
    mo_client = NEW zcl_odatano_client( iv_odatano_url ).
    mv_sender_address = iv_sender_address.
    mv_recipient_address = iv_recipient_address.
  ENDMETHOD.

  METHOD record_goods_receipt.
    " Step 1: Compute hash of goods receipt data
    DATA(lv_hash) = compute_document_hash( is_goods_receipt ).

    " Step 2: Build metadata JSON for Cardano transaction
    DATA(lv_metadata_json) = build_metadata_json(
      is_goods_receipt = is_goods_receipt
      iv_document_hash = lv_hash
    ).

    " Step 3: Call ODATANO to build a metadata transaction
    DATA(ls_build) = mo_client->build_metadata_transaction(
      iv_sender_address    = mv_sender_address
      iv_recipient_address = mv_recipient_address
      iv_lovelace_amount   = 2000000
      iv_metadata_json     = lv_metadata_json
    ).

    " Step 4: Create audit log entry
    rs_audit_entry-audit_uuid        = cl_system_uuid=>create_uuid_x16_static( ).
    rs_audit_entry-sap_document_no   = is_goods_receipt-document_no.
    rs_audit_entry-sap_document_type = is_goods_receipt-document_type.
    rs_audit_entry-sap_document_year = is_goods_receipt-document_year.
    rs_audit_entry-plant             = is_goods_receipt-plant.
    rs_audit_entry-material          = is_goods_receipt-material.
    rs_audit_entry-quantity          = is_goods_receipt-quantity.
    rs_audit_entry-unit              = is_goods_receipt-unit.
    rs_audit_entry-document_hash     = lv_hash.
    rs_audit_entry-build_id          = ls_build-build_id.
    rs_audit_entry-blockchain_network = 'PREVIEW'.
    rs_audit_entry-blockchain_status  = 'BUILT'.
    rs_audit_entry-created_by        = sy-uname.
    GET TIME STAMP FIELD rs_audit_entry-created_at.

    " Step 5: Persist audit entry
    INSERT zodatano_bc_log FROM @rs_audit_entry.
  ENDMETHOD.

  METHOD verify_goods_receipt.
    DATA(lv_current_hash) = compute_document_hash( is_goods_receipt ).
    rv_verified = mo_client->verify_transaction( iv_tx_hash ).
  ENDMETHOD.

  METHOD compute_document_hash.
    DATA(lv_canonical) =
      |{ is_goods_receipt-document_no }| &&
      |{ is_goods_receipt-document_type }| &&
      |{ is_goods_receipt-document_year }| &&
      |{ is_goods_receipt-plant }| &&
      |{ is_goods_receipt-material }| &&
      |{ is_goods_receipt-quantity }| &&
      |{ is_goods_receipt-unit }| &&
      |{ is_goods_receipt-posting_date }| &&
      |{ is_goods_receipt-vendor }|.

    TRY.
        cl_abap_message_digest=>calculate_hash_for_char(
          EXPORTING
            if_algorithm  = 'SHA256'
            if_data       = lv_canonical
          IMPORTING
            ef_hashstring = rv_hash
        ).
      CATCH cx_abap_message_digest.
        rv_hash = 'HASH_ERROR'.
    ENDTRY.
  ENDMETHOD.

  METHOD build_metadata_json.
    rv_json = |\{| &&
      |"674":\{| &&
      |"msg":["SAP Goods Receipt Anchor"],| &&
      |"sap_doc":"{ is_goods_receipt-document_no }",| &&
      |"plant":"{ is_goods_receipt-plant }",| &&
      |"material":"{ is_goods_receipt-material }",| &&
      |"hash":"{ iv_document_hash }",| &&
      |"ts":"{ sy-datum }{ sy-uzeit }"| &&
      |\}| &&
      |\}|.
  ENDMETHOD.

ENDCLASS.
