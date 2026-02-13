@AbapCatalog.viewEnhancementCategory: [#NONE]
@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'Blockchain Audit Log'
define root view entity ZI_ODATANO_BC_LOG
  as select from zodatano_bc_log
{
  key audit_uuid         as AuditUUID,
      sap_document_no    as SAPDocumentNo,
      sap_document_type  as SAPDocumentType,
      sap_document_year  as SAPDocumentYear,
      plant              as Plant,
      material           as Material,
      @Semantics.quantity.unitOfMeasure: 'Unit'
      quantity           as Quantity,
      unit               as Unit,
      document_hash      as DocumentHash,
      blockchain_tx_hash as BlockchainTxHash,
      blockchain_network as BlockchainNetwork,
      blockchain_status  as BlockchainStatus,
      build_id           as BuildID,
      created_by         as CreatedBy,
      created_at         as CreatedAt,
      changed_at         as ChangedAt
}
