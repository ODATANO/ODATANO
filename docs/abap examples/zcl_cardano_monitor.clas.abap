CLASS zcl_cardano_monitor DEFINITION
  PUBLIC FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.

    TYPES:
      BEGIN OF ty_health_status,
        network          TYPE string,
        is_healthy       TYPE abap_bool,
        current_epoch    TYPE i,
        current_slot     TYPE i,
        latest_block     TYPE string,
        total_supply     TYPE string,
        active_stake     TYPE string,
        check_timestamp  TYPE timestampl,
        response_time_ms TYPE i,
      END OF ty_health_status.

    METHODS get_health_status
      IMPORTING iv_odatano_url   TYPE string
      RETURNING VALUE(rs_status) TYPE ty_health_status.

ENDCLASS.


CLASS zcl_cardano_monitor IMPLEMENTATION.

  METHOD get_health_status.
    DATA lv_start TYPE timestampl.
    DATA lv_end   TYPE timestampl.

    GET TIME STAMP FIELD lv_start.

    TRY.
        DATA(lo_client) = NEW zcl_odatano_client( iv_odatano_url ).
        DATA(ls_info) = lo_client->get_network_info( ).

        GET TIME STAMP FIELD lv_end.

        rs_status-network          = ls_info-network.
        rs_status-is_healthy       = abap_true.
        rs_status-current_epoch    = ls_info-epoch.
        rs_status-current_slot     = ls_info-slot.
        rs_status-latest_block     = ls_info-block.
        rs_status-total_supply     = ls_info-supply.
        rs_status-active_stake     = ls_info-stake.
        rs_status-check_timestamp  = lv_end.

        rs_status-response_time_ms = cl_abap_tstmp=>subtract(
          tstmp1 = lv_end
          tstmp2 = lv_start
        ) * 1000.

      CATCH cx_root.
        GET TIME STAMP FIELD rs_status-check_timestamp.
        rs_status-is_healthy = abap_false.
        rs_status-network    = 'UNREACHABLE'.
    ENDTRY.
  ENDMETHOD.

ENDCLASS.
