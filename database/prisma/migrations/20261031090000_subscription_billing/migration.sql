-- ============================================================
-- Rentalio — Migration 028: tagihan langganan tenant → Rentalio (Xendit)
--
-- Menyimpan tagihan pembayaran langganan platform supaya status pembayaran
-- tidak bergantung pada dashboard provider. Callback Xendit hanya boleh
-- memindahkan baris PENDING → PAID/EXPIRED satu kali; replay tidak menambah
-- masa langganan lagi.
--
-- Satu tagihan PENDING per tenant dijaga partial unique index: klik ganda pada
-- tombol bayar tidak membuat dua tagihan aktif sekaligus.
--
-- RLS:
--   * policy tenant isolation  → seluruh operasi biasa (app.tenant_id)
--   * policy billing system    → SELECT lintas tenant untuk webhook, karena
--     callback provider datang tanpa sesi dan hanya membawa external_id.
--     Pemanggil tetap menulis di transaksi app.tenant_id.
-- ============================================================

CREATE TYPE "SubscriptionInvoiceStatus" AS ENUM ('PENDING', 'PAID', 'EXPIRED', 'FAILED');

CREATE TABLE "subscription_invoices" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'xendit',
    "externalId" TEXT NOT NULL,
    "providerInvoiceId" TEXT,
    "status" "SubscriptionInvoiceStatus" NOT NULL DEFAULT 'PENDING',
    "amount" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'IDR',
    "invoiceUrl" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "paidAmount" BIGINT,
    "paymentMethod" TEXT,
    "paymentChannel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscription_invoices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "subscription_invoices_externalId_key"
  ON "subscription_invoices"("externalId");

CREATE UNIQUE INDEX "subscription_invoices_providerInvoiceId_key"
  ON "subscription_invoices"("providerInvoiceId");

-- Selector gabungan (tenant, id) untuk lookup yang tidak pernah lintas tenant.
CREATE UNIQUE INDEX "subscription_invoices_tenantId_id_key"
  ON "subscription_invoices"("tenantId", "id");

CREATE INDEX "subscription_invoices_tenantId_status_idx"
  ON "subscription_invoices"("tenantId", "status");

-- Satu tagihan aktif per tenant.
CREATE UNIQUE INDEX "subscription_invoices_one_pending"
  ON "subscription_invoices"("tenantId")
  WHERE "status" = 'PENDING';

ALTER TABLE "subscription_invoices"
  ADD CONSTRAINT "subscription_invoices_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- RLS fail-closed + grant (pola sama dengan migration tenant-scoped lain)
-- ============================================================

ALTER TABLE "subscription_invoices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "subscription_invoices" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "subscription_invoices_tenant_isolation"
  ON "subscription_invoices";
CREATE POLICY "subscription_invoices_tenant_isolation"
  ON "subscription_invoices"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Webhook provider: baca lintas tenant untuk menemukan baris dari external_id.
-- SELECT saja; perubahan status tetap memakai konteks tenant.
DROP POLICY IF EXISTS "subscription_invoices_billing_system" ON "subscription_invoices";
CREATE POLICY "subscription_invoices_billing_system"
  ON "subscription_invoices"
  FOR SELECT
  USING (current_setting('app.billing_system', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON "subscription_invoices" TO sewain_dev;
GRANT SELECT, INSERT, UPDATE, DELETE ON "subscription_invoices" TO sewain_migrator;
