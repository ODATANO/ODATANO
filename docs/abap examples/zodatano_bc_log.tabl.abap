@EndUserText.label : 'Blockchain Audit Log'
@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE
@AbapCatalog.tableCategory : #TRANSPARENT
@AbapCatalog.deliveryClass : #A
@AbapCatalog.dataMaintenance : #RESTRICTED
define table zodatano_bc_log {
  key client         : abap.clnt not null;
  key audit_uuid     : sysuuid_x16 not null;
  sap_document_no    : abap.char(10);
  sap_document_type  : abap.char(20);
  sap_document_year  : abap.numc(4);
  plant              : abap.char(4);
  material           : abap.char(40);
  @Semantics.quantity.unitOfMeasure : 'zodatano_bc_log.unit'
  quantity           : abap.quan(13,3);
  unit               : abap.unit(3);
  document_hash      : abap.char(64);
  blockchain_tx_hash : abap.char(64);
  blockchain_network : abap.char(10);
  blockchain_status  : abap.char(20);
  build_id           : abap.char(36);
  created_by         : abap.char(12);
  created_at         : timestampl;
  changed_at         : timestampl;
}
