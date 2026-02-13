CLASS zcl_cardano_addr_check DEFINITION
  PUBLIC FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.

    TYPES ty_ada_amount TYPE p LENGTH 15 DECIMALS 6.

    TYPES:
      BEGIN OF ty_verification_result,
        address         TYPE string,
        is_valid        TYPE abap_bool,
        has_min_balance TYPE abap_bool,
        balance_ada     TYPE ty_ada_amount,
        message         TYPE string,
        checked_at      TYPE timestampl,
      END OF ty_verification_result.

    METHODS constructor
      IMPORTING iv_odatano_url TYPE string.

    METHODS verify_address_for_payment
      IMPORTING iv_address         TYPE string
                iv_min_balance_ada TYPE ty_ada_amount OPTIONAL
      RETURNING VALUE(rs_result)   TYPE ty_verification_result.

  PRIVATE SECTION.

    DATA mo_client TYPE REF TO zcl_odatano_client.

ENDCLASS.


CLASS zcl_cardano_addr_check IMPLEMENTATION.

  METHOD constructor.
    mo_client = NEW zcl_odatano_client( iv_odatano_url ).
  ENDMETHOD.

  METHOD verify_address_for_payment.
    rs_result-address = iv_address.
    GET TIME STAMP FIELD rs_result-checked_at.

    TRY.
        DATA(lo_destination) = cl_http_destination_provider=>create_by_url( mo_client->mv_base_url ).
        DATA(lo_client) = cl_web_http_client_manager=>create_by_http_destination( lo_destination ).
        DATA(lo_request) = lo_client->get_http_request( ).
        lo_request->set_uri_path(
          |/odata/v4/cardano-odata/GetAddressByBech32(bech32Address='{ iv_address }')|
        ).
        lo_request->set_header_field( i_name = 'Accept' i_value = 'application/json' ).

        DATA(lo_response) = lo_client->execute( if_web_http_client=>get ).
        DATA(lv_status) = lo_response->get_status( )-code.
        DATA(lv_json) = lo_response->get_text( ).
        lo_client->close( ).

        IF lv_status = 200.
          rs_result-is_valid = abap_true.

          " Parse balance (lovelace to ADA: divide by 1,000,000)
          DATA: BEGIN OF ls_address,
                  balance TYPE string,
                END OF ls_address.
          /ui2/cl_json=>deserialize(
            EXPORTING json = lv_json
            CHANGING  data = ls_address
          ).

          IF ls_address-balance IS NOT INITIAL.
            rs_result-balance_ada = ls_address-balance / 1000000.
          ENDIF.

          " Check minimum balance
          IF iv_min_balance_ada > 0.
            rs_result-has_min_balance = COND #(
              WHEN rs_result-balance_ada >= iv_min_balance_ada
              THEN abap_true ELSE abap_false
            ).
            rs_result-message = COND #(
              WHEN rs_result-has_min_balance = abap_true
              THEN |Address verified. Balance: { rs_result-balance_ada } ADA|
              ELSE |Balance { rs_result-balance_ada } ADA below minimum { iv_min_balance_ada } ADA|
            ).
          ELSE.
            rs_result-has_min_balance = abap_true.
            rs_result-message = |Address verified. Balance: { rs_result-balance_ada } ADA|.
          ENDIF.

        ELSE.
          rs_result-is_valid = abap_false.
          rs_result-message = |Address not found on Cardano network|.
        ENDIF.

      CATCH cx_root INTO DATA(lx_error).
        rs_result-is_valid = abap_false.
        rs_result-message = |Verification failed: { lx_error->get_text( ) }|.
    ENDTRY.
  ENDMETHOD.

ENDCLASS.
