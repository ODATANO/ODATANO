CLASS zcl_odatano_client DEFINITION
  PUBLIC FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.

    TYPES:
      BEGIN OF ty_network_info,
        network TYPE string,
        epoch   TYPE i,
        slot    TYPE i,
        block   TYPE string,
        supply  TYPE string,
        stake   TYPE string,
      END OF ty_network_info,

      BEGIN OF ty_build_response,
        build_id    TYPE string,
        unsigned_tx TYPE string,
        tx_hash     TYPE string,
        fee         TYPE string,
      END OF ty_build_response,

      BEGIN OF ty_transaction,
        hash         TYPE string,
        block        TYPE string,
        block_height TYPE i,
        slot         TYPE i,
        fees         TYPE string,
      END OF ty_transaction.

    DATA mv_base_url TYPE string READ-ONLY.

    METHODS constructor
      IMPORTING iv_base_url TYPE string.

    METHODS get_network_info
      RETURNING VALUE(rs_network_info) TYPE ty_network_info
      RAISING   cx_http_dest_provider_error
                cx_web_http_client_error.

    METHODS get_transaction_by_hash
      IMPORTING iv_tx_hash            TYPE string
      RETURNING VALUE(rs_transaction) TYPE ty_transaction
      RAISING   cx_http_dest_provider_error
                cx_web_http_client_error.

    METHODS build_metadata_transaction
      IMPORTING iv_sender_address    TYPE string
                iv_recipient_address TYPE string
                iv_lovelace_amount   TYPE i DEFAULT 2000000
                iv_metadata_json     TYPE string
      RETURNING VALUE(rs_build_response) TYPE ty_build_response
      RAISING   cx_http_dest_provider_error
                cx_web_http_client_error.

    METHODS verify_transaction
      IMPORTING iv_tx_hash         TYPE string
      RETURNING VALUE(rv_verified) TYPE abap_bool
      RAISING   cx_http_dest_provider_error
                cx_web_http_client_error.

  PRIVATE SECTION.

    DATA mv_read_path TYPE string VALUE '/odata/v4/cardano-odata'.
    DATA mv_tx_path   TYPE string VALUE '/odata/v4/cardano-transaction'.

    METHODS execute_get
      IMPORTING iv_path            TYPE string
      RETURNING VALUE(rv_response) TYPE string
      RAISING   cx_http_dest_provider_error
                cx_web_http_client_error.

    METHODS execute_post
      IMPORTING iv_path            TYPE string
                iv_body            TYPE string
      RETURNING VALUE(rv_response) TYPE string
      RAISING   cx_http_dest_provider_error
                cx_web_http_client_error.

ENDCLASS.


CLASS zcl_odatano_client IMPLEMENTATION.

  METHOD constructor.
    mv_base_url = iv_base_url.
  ENDMETHOD.

  METHOD get_network_info.
    DATA(lv_response) = execute_get( mv_read_path && '/GetNetworkInformation' ).
    /ui2/cl_json=>deserialize(
      EXPORTING json = lv_response
      CHANGING  data = rs_network_info
    ).
  ENDMETHOD.

  METHOD get_transaction_by_hash.
    DATA(lv_path) = mv_read_path && |/GetTransactionByHash(txHash='{ iv_tx_hash }')|.
    DATA(lv_response) = execute_get( lv_path ).
    /ui2/cl_json=>deserialize(
      EXPORTING json = lv_response
      CHANGING  data = rs_transaction
    ).
  ENDMETHOD.

  METHOD build_metadata_transaction.
    DATA(lv_body) = |\{| &&
      |"senderAddress":"{ iv_sender_address }",| &&
      |"recipientAddress":"{ iv_recipient_address }",| &&
      |"lovelaceAmount":{ iv_lovelace_amount },| &&
      |"metadata":{ iv_metadata_json }| &&
      |\}|.

    DATA(lv_response) = execute_post(
      iv_path = mv_tx_path && '/BuildTransactionWithMetadata'
      iv_body = lv_body
    ).
    /ui2/cl_json=>deserialize(
      EXPORTING json = lv_response
      CHANGING  data = rs_build_response
    ).
  ENDMETHOD.

  METHOD verify_transaction.
    TRY.
        DATA(ls_tx) = get_transaction_by_hash( iv_tx_hash ).
        rv_verified = COND #( WHEN ls_tx-hash IS NOT INITIAL THEN abap_true ELSE abap_false ).
      CATCH cx_root.
        rv_verified = abap_false.
    ENDTRY.
  ENDMETHOD.

  METHOD execute_get.
    DATA(lo_destination) = cl_http_destination_provider=>create_by_url( mv_base_url ).
    DATA(lo_client) = cl_web_http_client_manager=>create_by_http_destination( lo_destination ).
    DATA(lo_request) = lo_client->get_http_request( ).
    lo_request->set_uri_path( iv_path ).
    lo_request->set_header_field( i_name = 'Accept' i_value = 'application/json' ).

    DATA(lo_response) = lo_client->execute( if_web_http_client=>get ).
    rv_response = lo_response->get_text( ).
    lo_client->close( ).
  ENDMETHOD.

  METHOD execute_post.
    DATA(lo_destination) = cl_http_destination_provider=>create_by_url( mv_base_url ).
    DATA(lo_client) = cl_web_http_client_manager=>create_by_http_destination( lo_destination ).
    DATA(lo_request) = lo_client->get_http_request( ).
    lo_request->set_uri_path( iv_path ).
    lo_request->set_header_field( i_name = 'Content-Type' i_value = 'application/json' ).
    lo_request->set_header_field( i_name = 'Accept' i_value = 'application/json' ).
    lo_request->set_text( iv_body ).

    DATA(lo_response) = lo_client->execute( if_web_http_client=>post ).
    rv_response = lo_response->get_text( ).
    lo_client->close( ).
  ENDMETHOD.

ENDCLASS.
