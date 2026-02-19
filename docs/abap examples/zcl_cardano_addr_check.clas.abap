CLASS zcl_cardano_addr_check DEFINITION
  PUBLIC FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.

    TYPES ty_ada_amount TYPE p LENGTH 15 DECIMALS 6.

    TYPES:
      BEGIN OF ty_verification_result,
        address         TYPE string,
        type       TYPE string,
        has_min_balance TYPE abap_bool,
        balance_ada     TYPE ty_ada_amount,
        message         TYPE string,
        checked_at      TYPE timestampl,
      END OF ty_verification_result.

   METHODS constructor
      IMPORTING iv_odatano_url   TYPE string
                iv_token_url     TYPE string OPTIONAL
                iv_client_id     TYPE string OPTIONAL
                iv_client_secret TYPE string OPTIONAL.

    METHODS verify_address_for_payment
      IMPORTING iv_address         TYPE string
                iv_min_balance_ada TYPE ty_ada_amount OPTIONAL
      RETURNING VALUE(rs_result)   TYPE ty_verification_result.

  PRIVATE SECTION.

    DATA mo_client TYPE REF TO zcl_odatano_client.

ENDCLASS.


CLASS zcl_cardano_addr_check IMPLEMENTATION.

   METHOD constructor.
    mo_client = NEW zcl_odatano_client(
      iv_base_url      = iv_odatano_url
      iv_token_url     = iv_token_url
      iv_client_id     = iv_client_id
      iv_client_secret = iv_client_secret
    ).
  ENDMETHOD.

  METHOD verify_address_for_payment.
    rs_result-address = iv_address.
    GET TIME STAMP FIELD rs_result-checked_at.

    TRY.

         data(ls_address_info) = mo_client->get_address_info( iv_address ).

          IF ls_address_info IS NOT INITIAL.
            rs_result-balance_ada = ls_address_info-totallovelace / 1000000.

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
            rs_result-type = ls_address_info-type.
            rs_result-message = |Address verified. Balance: { rs_result-balance_ada } ADA|.
          ENDIF.

        ELSE.
          rs_result-message = |Address not found on Cardano network|.
        ENDIF.

      CATCH cx_root INTO DATA(lx_error).
        rs_result-message = |Verification failed: { lx_error->get_text( ) }|.
    ENDTRY.
  ENDMETHOD.

ENDCLASS.
