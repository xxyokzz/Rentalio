-- ============================================================
-- Rentalio — Migration 019: katalog publik, booking tamu, portal pesanan
--
-- Acuan: Notion 04 (GET /public/{tenantSlug}/catalog,
-- POST /public/{tenantSlug}/bookings, GET /portal/orders/{secureToken})
-- dan Notion 14 (alur penyewa).
--
-- 1. Kontak publik tenant: nomor WhatsApp, instruksi transfer, gambar QRIS.
--    Semua opsional; UI tidak boleh mengarang nilai.
-- 2. Bukti persetujuan ketentuan sewa pada reservasi tamu.
-- 3. Tabel token portal: hanya hash token yang disimpan, dapat dicabut
--    dan kedaluwarsa. Token plaintext hanya dikembalikan sekali.
--
-- RLS:
-- - tenants mendapat policy SELECT tambahan berdasarkan slug publik
--   (`app.public_tenant_slug`) agar katalog dapat meresolusi tenant tanpa
--   sesi. Policy tenant isolation tetap berlaku untuk operasi lain.
-- - public_order_access: tenant isolation + policy SELECT berdasarkan
--   hash token (`app.portal_token_hash`) untuk portal tanpa sesi.
-- ============================================================

ALTER TABLE "tenants"
  ADD COLUMN "whatsappNumber" TEXT,
  ADD COLUMN "bankTransferInstructions" TEXT,
  ADD COLUMN "qrisImageUrl" TEXT;

ALTER TABLE "reservations"
  ADD COLUMN "guestTermsVersion" TEXT,
  ADD COLUMN "guestTermsAcceptedAt" TIMESTAMP(3);

CREATE TABLE "public_order_access" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "reservationId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "public_order_access_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "public_order_access_tokenHash_key"
  ON "public_order_access"("tokenHash");

CREATE UNIQUE INDEX "public_order_access_tenantId_id_key"
  ON "public_order_access"("tenantId", "id");

CREATE INDEX "public_order_access_tenantId_reservationId_idx"
  ON "public_order_access"("tenantId", "reservationId");

ALTER TABLE "public_order_access"
  ADD CONSTRAINT "public_order_access_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public_order_access"
  ADD CONSTRAINT "public_order_access_tenantId_reservationId_fkey"
  FOREIGN KEY ("tenantId", "reservationId")
  REFERENCES "reservations"("tenantId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ------------------------------------------------------------------
-- Resolusi tenant publik berdasarkan slug (tanpa sesi).
-- ------------------------------------------------------------------
DROP POLICY IF EXISTS tenants_public_slug_read ON "tenants";
CREATE POLICY tenants_public_slug_read ON "tenants"
  FOR SELECT
  USING (
    "slug" = NULLIF(current_setting('app.public_tenant_slug', true), '')
  );

-- ------------------------------------------------------------------
-- Token portal pesanan.
-- ------------------------------------------------------------------
ALTER TABLE "public_order_access" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public_order_access" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS public_order_access_tenant_isolation ON "public_order_access";
CREATE POLICY public_order_access_tenant_isolation ON "public_order_access"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS public_order_access_token_read ON "public_order_access";
CREATE POLICY public_order_access_token_read ON "public_order_access"
  FOR SELECT
  USING (
    "tokenHash" = NULLIF(current_setting('app.portal_token_hash', true), '')
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON "public_order_access" TO sewain_dev;
GRANT SELECT, INSERT, UPDATE, DELETE ON "public_order_access" TO sewain_migrator;
