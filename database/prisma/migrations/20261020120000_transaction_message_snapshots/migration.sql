-- ============================================================
-- Rentalio — Migration 014: snapshot pesan WhatsApp per transaksi
--
-- Snapshot menyimpan body yang SUDAH dirender beserta versi template yang
-- dipakai. Mengubah template setelahnya tidak mengubah pesan yang sudah
-- disajikan ke transaksi. TemplateId sengaja tanpa FK agar snapshot tetap
-- utuh bila template dihapus.
--
-- Partial unique index mencegah duplikat saat command diulang:
--   - pesan booking: satu per (order, konteks, metode, tujuan)
--   - pesan payment: satu per payment
-- ============================================================

CREATE TABLE "transaction_message_snapshots" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "paymentId" UUID,
    "templateId" UUID,
    "templateVersion" INTEGER,
    "context" "PaymentContext" NOT NULL,
    "paymentMethod" "PaymentMethod" NOT NULL,
    "purpose" "WhatsAppTemplatePurpose" NOT NULL,
    "templateName" TEXT,
    "bodySnapshot" TEXT NOT NULL,
    "variables" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transaction_message_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "transaction_message_snapshots_tenantId_id_key"
  ON "transaction_message_snapshots"("tenantId", "id");

CREATE INDEX "transaction_message_snapshots_tenantId_orderId_createdAt_idx"
  ON "transaction_message_snapshots"("tenantId", "orderId", "createdAt");

CREATE INDEX "transaction_message_snapshots_tenantId_paymentId_idx"
  ON "transaction_message_snapshots"("tenantId", "paymentId");

CREATE UNIQUE INDEX "transaction_message_snapshots_booking_unique"
  ON "transaction_message_snapshots"("tenantId", "orderId", "context", "paymentMethod", "purpose")
  WHERE "paymentId" IS NULL;

CREATE UNIQUE INDEX "transaction_message_snapshots_payment_unique"
  ON "transaction_message_snapshots"("tenantId", "paymentId")
  WHERE "paymentId" IS NOT NULL;

ALTER TABLE "transaction_message_snapshots"
  ADD CONSTRAINT "transaction_message_snapshots_tenantId_orderId_fkey"
  FOREIGN KEY ("tenantId", "orderId") REFERENCES "rental_orders"("tenantId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS fail-closed: tanpa app.tenant_id, tidak ada baris yang terlihat.
ALTER TABLE "transaction_message_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "transaction_message_snapshots" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS transaction_message_snapshots_tenant_isolation
  ON "transaction_message_snapshots";
CREATE POLICY transaction_message_snapshots_tenant_isolation
  ON "transaction_message_snapshots"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "transaction_message_snapshots" TO sewain_dev;
GRANT SELECT, INSERT, UPDATE, DELETE ON "transaction_message_snapshots" TO sewain_migrator;
