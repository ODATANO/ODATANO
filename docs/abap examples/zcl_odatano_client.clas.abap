CLASS zcl_odatano_client DEFINITION
  PUBLIC FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.

    TYPES:
      BEGIN OF ty_network_info,
        network           TYPE string,
        validFrom         TYPE string,
        validTo           TYPE string,
        maxSupply         TYPE i,
        circulatingSupply TYPE i,
        totalSupply       TYPE i,
        lockedSupply      TYPE i,
        treasurySupply    TYPE i,
        reservesSupply    TYPE i,
        liveStake         TYPE i,
        activeStake       TYPE i,
      END OF ty_network_info,

      BEGIN OF ty_epoch_info,
        epoch          TYPE i,
        startTime      TYPE i,
        endTime        TYPE i,
        firstBlockTime TYPE i,
        lastBlockTime  TYPE i,
        txCount        TYPE i,
        fees           TYPE i,
        activeStake    TYPE i,
      END OF ty_EPOCH_INFO,

      BEGIN OF ty_transaction,
        hash        TYPE string,
        blockHash   TYPE string,
        blockHeight TYPE i,
        blockTime   TYPE i,
        slot        TYPE string,
        txIndex     TYPE i,
        fee         TYPE i,
        deposit     TYPE i,
        size        TYPE i,
        hasInputs   TYPE abap_boolean,
        hasOutputs  TYPE abap_boolean,
        hasMetadata TYPE abap_boolean,
      END OF ty_transaction,

      BEGIN OF ty_address,
        address         TYPE string,
        stakeAddress    TYPE string,
        type            TYPE string,
        isScript        TYPE abap_boolean,
        totalLovelace   TYPE int8,
        validFrom       TYPE string,
        validTo         TYPE string,
        hasAssets       TYPE abap_boolean,
        hasUtxos        TYPE abap_boolean,
        hasTransactions TYPE abap_boolean,
      END OF ty_address,

      BEGIN OF ty_transaction_build,
        id             TYPE string,
        validFrom      TYPE string,
        validTo        TYPE string,
        senderAddress  TYPE string,
        changeAddress  TYPE string,
        unsignedTxCbor TYPE string,
        txBodyHash     TYPE string,
        fee            TYPE i,
        size           TYPE i,
        createdAt      TYPE i,
        hasInputs      TYPE abap_boolean,
        hasOutputs     TYPE abap_boolean,
        wasSubmitted   TYPE abap_boolean,
        scriptHash     TYPE string,
      END OF ty_transaction_build,

      Begin of ty_sign_request,
        id type string,
        buid type string,
        tyBodyHash type string,
        unsigneTxCbor type string,
        network type string,
        status type string,
        createdAt type timestampl,
        expiresAt type timestampl,
        signedAt type timestampl,
        submittedAt type timestampl,
        cardanoCliCommand type string,
        cip30TxCbor type string,
        signerType type string,
        signerInfo type string,
        verification type string,
        submission type string,
        errorMessage type string,
      end of ty_SIGN_REQUEST.

   DATA mv_base_url TYPE string READ-ONLY.

    METHODS constructor
      IMPORTING iv_base_url      TYPE string
                iv_token_url     TYPE string OPTIONAL
                iv_client_id     TYPE string OPTIONAL
                iv_client_secret TYPE string OPTIONAL.

    METHODS get_network_info
      RETURNING VALUE(rs_network_info) TYPE ty_network_info
      RAISING   cx_http_dest_provider_error
                cx_web_http_client_error.

    METHODS get_latest_epoch
      RETURNING VALUE(rs_epoch_info) TYPE ty_epoch_info
      RAISING   cx_http_dest_provider_error
                cx_web_http_client_error.

    METHODS get_address_info
      IMPORTING iv_address             TYPE string
      RETURNING VALUE(rs_address_info) TYPE ty_address
      RAISING   cx_http_dest_provider_error
                cx_web_http_client_error.

    METHODS get_transaction_by_hash
      IMPORTING iv_tx_hash            TYPE string
      RETURNING VALUE(rs_transaction) TYPE ty_transaction
      RAISING   cx_http_dest_provider_error
                cx_web_http_client_error.

    METHODS build_metadata_transaction
      IMPORTING iv_sender_address        TYPE string
                iv_recipient_address     TYPE string
                iv_lovelace_amount       TYPE i DEFAULT 2000000
                iv_metadata_json         TYPE string
      RETURNING VALUE(rs_build_response) TYPE ty_transaction_build
      RAISING   cx_http_dest_provider_error
                cx_web_http_client_error.

    MethODS post_signing_request
        imPORTING iv_build_id tYPE string
                  iv_message  type string
        returning VALUE(rs_sign_req) type ty_sign_request
        RAISING cx_http_dest_provider_error
                cx_web_http_client_error.

    METHODS verify_transaction
      IMPORTING iv_tx_hash         TYPE string
      RETURNING VALUE(rv_verified) TYPE abap_bool
      RAISING   cx_http_dest_provider_error
                cx_web_http_client_error.

  PRIVATE SECTION.

    DATA mv_read_path     TYPE string VALUE '/odata/v4/cardano-odata'.
    DATA mv_tx_path       TYPE string VALUE '/odata/v4/cardano-transaction'.
    DATA mv_token_url     TYPE string.
    DATA mv_client_id     TYPE string.
    DATA mv_client_secret TYPE string.
    DATA mv_access_token  TYPE string.
    DATA mv_token_expiry  TYPE timestampl.

    METHODS get_access_token
      RETURNING VALUE(rv_token) TYPE string
      RAISING   cx_http_dest_provider_error
                cx_web_http_client_error.

    METHODS execute_get
      IMPORTING iv_path            TYPE string
      RETURNING VALUE(rv_response) TYPE string
      RAISING   cx_http_dest_provider_error
                cx_web_http_client_error.

    METHODS execute_post
      IMPORTING iv_path            TYPE string
                iv_body            TYPE string OPTIONAL
      RETURNING VALUE(rv_response) TYPE string
      RAISING   cx_http_dest_provider_error
                cx_web_http_client_error.

ENDCLASS.


CLASS zcl_odatano_client IMPLEMENTATION.

  METHOD constructor.
    mv_base_url      = iv_base_url.
    mv_token_url     = iv_token_url.
    mv_client_id     = iv_client_id.
    mv_client_secret = iv_client_secret.
  ENDMETHOD.

  METHOD get_access_token.
    " Check if we have a valid cached token
    DATA lv_now TYPE timestampl.
    GET TIME STAMP FIELD lv_now.

    IF mv_access_token IS NOT INITIAL AND mv_token_expiry > lv_now.
      rv_token = mv_access_token.
      RETURN.
    ENDIF.

    " Request new token via Client Credentials flow
    DATA(lo_dest) = cl_http_destination_provider=>create_by_url( mv_token_url ).
    DATA(lo_client) = cl_web_http_client_manager=>create_by_http_destination( lo_dest ).
    DATA(lo_request) = lo_client->get_http_request( ).

    DATA(lv_credentials) = cl_web_http_utility=>encode_base64(
      |{ mv_client_id }:{ mv_client_secret }|
    ).
    lo_request->set_header_field( i_name = 'Authorization' i_value = |Basic { lv_credentials }| ).
    lo_request->set_header_field( i_name = 'Content-Type' i_value = 'application/x-www-form-urlencoded' ).
    lo_request->set_text( |grant_type=client_credentials| ).

    DATA(lo_response) = lo_client->execute( if_web_http_client=>post ).
    DATA(lv_status) = lo_response->get_status( )-code.
    DATA(lv_body) = lo_response->get_text( ).
    lo_client->close( ).

    IF lv_status = 200.
      DATA: BEGIN OF ls_token,
              access_token TYPE string,
              expires_in   TYPE i,
            END OF ls_token.
      /ui2/cl_json=>deserialize(
        EXPORTING json = lv_body
        CHANGING  data = ls_token
      ).

      mv_access_token = ls_token-access_token.

      " Set expiry 5 minutes before actual expiry for safety
      mv_token_expiry = cl_abap_tstmp=>add(
        tstmp = lv_now
        secs  = ls_token-expires_in - 300
      ).

      rv_token = mv_access_token.
    ENDIF.
  ENDMETHOD.

  METHOD get_network_info.
    DATA(lv_response) = execute_post( mv_read_path && '/GetNetworkInformation' ).
    /ui2/cl_json=>deserialize(
      EXPORTING json = lv_response
      CHANGING  data = rs_network_info
    ).
  ENDMETHOD.

  METHOD get_address_info.

     DATA(lv_body) = |\{| &&
      |"address":"{ iv_address }"| &&
      |\}|.

    DATA(lv_response) = execute_post(
      iv_path = mv_read_path && '/GetAddressByBech32'
      iv_body = lv_body
    ).
    /ui2/cl_json=>deserialize(
      EXPORTING json = lv_response
      CHANGING  data = rs_address_info
    ).
  ENDMETHOD.

  METHOD  get_latest_epoch.
    DATA(lv_response) = execute_post( mv_read_path && '/GetLatestEpoch' ).
    /ui2/cl_json=>deserialize(
      EXPORTING json = lv_response
      CHANGING  data = rs_epoch_info
    ).
  ENDMETHOD.

  METHOD get_transaction_by_hash.
    DATA(lv_path) = mv_read_path && |/GetTransactionByHash(hash='{ iv_tx_hash }')|.
    DATA(lv_response) = execute_post( lv_path ).
    /ui2/cl_json=>deserialize(
      EXPORTING json = lv_response
      CHANGING  data = rs_transaction
    ).
  ENDMETHOD.

METHOD build_metadata_transaction.

    DATA(lv_escaped_metadata) = replace( val = iv_metadata_json sub = |"| with = |\\"| occ = 0 ).

    DATA(lv_body) = |\{| &&
      |"senderAddress":"{ iv_sender_address }",| &&
      |"recipientAddress":"{ iv_recipient_address }",| &&
      |"lovelaceAmount":{ iv_lovelace_amount },| &&
      |"metadataJson":"{ lv_escaped_metadata }"| &&
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

  METHOD post_signing_request.

    DATA(lv_body) = |\{| &&
      |"buildId":"{ iv_build_id }",| &&
      |"message":"{ iv_message }"| &&
      |\}|.

    DATA(lv_response) = execute_post(
      iv_path = mv_tx_path && '/CreateSigningRequest'
      iv_body = lv_body
    ).
    /ui2/cl_json=>deserialize(
      EXPORTING json = lv_response
      CHANGING  data = rs_sign_req
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
    DATA(lo_dest) = cl_http_destination_provider=>create_by_url( mv_base_url ).
    DATA(lo_client) = cl_web_http_client_manager=>create_by_http_destination( lo_dest ).
    DATA(lo_request) = lo_client->get_http_request( ).
    lo_request->set_uri_path( iv_path ).
    lo_request->set_header_field( i_name = 'Accept' i_value = 'application/json' ).

    IF mv_token_url IS NOT INITIAL.
      DATA(lv_token) = get_access_token( ).
      lo_request->set_header_field( i_name = 'Authorization' i_value = |Bearer { lv_token }| ).
    ENDIF.

    DATA(lo_response) = lo_client->execute( if_web_http_client=>get ).
    rv_response = lo_response->get_text( ).
    lo_client->close( ).
  ENDMETHOD.

  METHOD execute_post.
    DATA(lo_dest) = cl_http_destination_provider=>create_by_url( mv_base_url ).
    DATA(lo_client) = cl_web_http_client_manager=>create_by_http_destination( lo_dest ).
    DATA(lo_request) = lo_client->get_http_request( ).
    lo_request->set_uri_path( iv_path ).
    lo_request->set_header_field( i_name = 'Content-Type' i_value = 'application/json' ).
    lo_request->set_header_field( i_name = 'Accept' i_value = 'application/json' ).

    IF mv_token_url IS NOT INITIAL.
      DATA(lv_token) = get_access_token( ).
      lo_request->set_header_field( i_name = 'Authorization' i_value = |Bearer { lv_token }| ).
    ENDIF.

    IF iv_body IS NOT INITIAL.
      lo_request->set_text( iv_body ).
    ENDIF.

    DATA(lo_response) = lo_client->execute( if_web_http_client=>post ).
    rv_response = lo_response->get_text( ).
    lo_client->close( ).
  ENDMETHOD.

ENDCLASS.