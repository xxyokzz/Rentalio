-- ============================================================
-- Rentalio — Migration 003: return_records, return_items,
--          inspections, inspection_attachments
-- Acuan: ADR-001 §5, Notion 04 endpoint /orders/:id/returns
--        dan /orders/:id/inspections
-- ============================================================

-- Enum status pengembalian
CREATE TYPE "ReturnStatus" AS ENUM ('PENDING', 'COMPLETED', 'CANCELLED');

-- Enum status inspeksi
CREATE TYPE "InspectionStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED');

-- Return records: rekaman pengembalian barang
CREATE TABLE "return_records" (
  "id"               UUID        NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"         UUID        NOT NULL,
  "orderId"          UUID        NOT NULL,
  "status"           "ReturnStatus" NOT NULL DEFAULT 'PENDING',
  "returnedAt"       TIMESTAMP(3),
  "receivedByUserId" UUID,
  "notes"            TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,

  CONSTRAINT "return_records_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "return_records_tenantId_id_key" UNIQUE ("tenantId", "id"),
  CONSTRAINT "return_records_order_fk" FOREIGN KEY ("tenantId", "orderId")
    REFERENCES "rental_orders" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "return_records_tenantId_orderId_idx" ON "return_records" ("tenantId", "orderId");

-- Return items: item individual dalam satu return record
CREATE TABLE "return_items" (
  "id"             UUID        NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"       UUID        NOT NULL,
  "returnRecordId" UUID        NOT NULL,
  "productId"      UUID        NOT NULL,
  "assetId"        UUID,
  "quantity"       INTEGER     NOT NULL DEFAULT 1,
  "conditionNote"  TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "return_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "return_items_tenantId_id_key" UNIQUE ("tenantId", "id"),
  CONSTRAINT "return_items_quantity_positive" CHECK ("quantity" > 0),
  CONSTRAINT "return_items_return_record_fk" FOREIGN KEY ("tenantId", "returnRecordId")
    REFERENCES "return_records" ("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "return_items_product_fk" FOREIGN KEY ("tenantId", "productId")
    REFERENCES "products" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "return_items_asset_fk" FOREIGN KEY ("tenantId", "assetId")
    REFERENCES "assets" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "return_items_tenantId_returnRecordId_idx" ON "return_items" ("tenantId", "returnRecordId");

-- Inspections: inspeksi kerusakan pasca-return
CREATE TABLE "inspections" (
  "id"                UUID             NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"          UUID             NOT NULL,
  "orderId"           UUID             NOT NULL,
  "returnRecordId"    UUID,
  "status"            "InspectionStatus" NOT NULL DEFAULT 'DRAFT',
  "inspectedByUserId" UUID,
  "approvedByUserId"  UUID,
  "summary"           TEXT,
  "penaltyAmount"     BIGINT,
  "currency"          TEXT             NOT NULL DEFAULT 'IDR',
  "inspectedAt"       TIMESTAMP(3),
  "submittedAt"       TIMESTAMP(3),
  "decidedAt"         TIMESTAMP(3),
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,

  CONSTRAINT "inspections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "inspections_tenantId_id_key" UNIQUE ("tenantId", "id"),
  CONSTRAINT "inspections_penalty_non_negative" CHECK (
    "penaltyAmount" IS NULL OR "penaltyAmount" >= 0
  ),
  CONSTRAINT "inspections_order_fk" FOREIGN KEY ("tenantId", "orderId")
    REFERENCES "rental_orders" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "inspections_return_record_fk" FOREIGN KEY ("tenantId", "returnRecordId")
    REFERENCES "return_records" ("tenantId", "id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "inspections_tenantId_orderId_idx" ON "inspections" ("tenantId", "orderId");
CREATE INDEX "inspections_tenantId_status_idx" ON "inspections" ("tenantId", "status");

-- Inspection attachments: lampiran foto/dokumen inspeksi
CREATE TABLE "inspection_attachments" (
  "id"            UUID        NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"      UUID        NOT NULL,
  "inspectionId"  UUID        NOT NULL,
  "objectKey"     TEXT        NOT NULL,
  "mimeType"      TEXT        NOT NULL DEFAULT 'image/jpeg',
  "fileSizeBytes" INTEGER,
  "altText"       TEXT,
  "sortOrder"     INTEGER     NOT NULL DEFAULT 0,
  "uploadedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "inspection_attachments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "inspection_attachments_tenantId_id_key" UNIQUE ("tenantId", "id"),
  CONSTRAINT "inspection_attachments_inspection_fk" FOREIGN KEY ("tenantId", "inspectionId")
    REFERENCES "inspections" ("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "inspection_attachments_tenantId_inspectionId_idx"
  ON "inspection_attachments" ("tenantId", "inspectionId");

-- RLS untuk tabel-tabel baru (konsisten dengan migration 002)
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'return_records', 'return_items', 'inspections', 'inspection_attachments'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING ("tenantId" = current_setting(''app.tenant_id'', true)::uuid)',
      t || '_tenant_isolation', t);
  END LOOP;
END $$;

-- Grant akses runtime ke role sewain_dev
GRANT SELECT, INSERT, UPDATE, DELETE ON "return_records" TO sewain_dev;
GRANT SELECT, INSERT, UPDATE, DELETE ON "return_items" TO sewain_dev;
GRANT SELECT, INSERT, UPDATE, DELETE ON "inspections" TO sewain_dev;
GRANT SELECT, INSERT, UPDATE, DELETE ON "inspection_attachments" TO sewain_dev;
