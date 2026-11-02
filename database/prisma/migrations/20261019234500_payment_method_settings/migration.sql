-- ============================================================
-- Rentalio — Migration 012: matriks metode pembayaran per tenant
--
-- Acuan: Notion 04 — konfigurasi Cash/Transfer Bank/QRIS per konteks
-- (NEW_BOOKING, ADD_UNIT, EXTENSION). Setiap konteks wajib memiliki minimal
-- satu metode aktif; aturan agregat ini ditegakkan service dalam transaksi.
--
-- Baris yang belum ada diartikan default aktif. Dengan begitu tenant lama
-- tetap kompatibel tanpa backfill, dan menonaktifkan metode cukup menulis
-- baris eksplisit. `payments.context` menyimpan snapshot konteks transaksi.
-- ============================================================

CREATE TYPE "PaymentContext" AS ENUM ('NEW_BOOKING', 'ADD_UNIT', 'EXTENSION');

ALTER TABLE "payments"
  ADD COLUMN "context" "PaymentContext" NOT NULL DEFAULT 'NEW_BOOKING';

CREATE TABLE "tenant_payment_method_settings" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "context" "PaymentContext" NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_payment_method_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenant_payment_method_settings_tenantId_context_method_key"
  ON "tenant_payment_method_settings"("tenantId", "context", "method");

CREATE INDEX "tenant_payment_method_settings_tenantId_context_idx"
  ON "tenant_payment_method_settings"("tenantId", "context");

ALTER TABLE "tenant_payment_method_settings"
  ADD CONSTRAINT "tenant_payment_method_settings_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS fail-closed: tanpa app.tenant_id, tidak ada baris yang terlihat.
ALTER TABLE "tenant_payment_method_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_payment_method_settings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_payment_method_settings_tenant_isolation
  ON "tenant_payment_method_settings";
CREATE POLICY tenant_payment_method_settings_tenant_isolation
  ON "tenant_payment_method_settings"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_payment_method_settings" TO sewain_dev;
GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_payment_method_settings" TO sewain_migrator;
