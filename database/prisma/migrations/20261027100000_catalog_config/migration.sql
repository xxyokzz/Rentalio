-- ============================================================
-- Rentalio — Migration 022: konfigurasi presentasi katalog (WEB-07)
--
-- Menyimpan konfigurasi presentasi terstruktur per tenant: tema, branding,
-- dan susunan blok. Backend memvalidasi terhadap allowlist komponen/properti
-- sebelum menyimpan; editor tidak pernah menyimpan HTML/JavaScript arbitrer.
--
-- Siklus versi:
--   DRAFT      → draf privat (satu per tenant)
--   PUBLISHED  → versi live yang dibaca katalog publik (satu per tenant)
--   ARCHIVED   → versi lama setelah publish berikutnya
--
-- Partial unique index menegakkan "satu draf + satu published" per tenant.
-- Versi lama tetap tersimpan sehingga rollback tidak menimpa histori.
-- Data produk, harga, ketersediaan, dan booking tidak berada di tabel ini.
-- ============================================================

CREATE TYPE "CatalogConfigStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

CREATE TABLE "catalog_config_versions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "CatalogConfigStatus" NOT NULL DEFAULT 'DRAFT',
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "templateKey" TEXT NOT NULL DEFAULT 'klasik-hangat',
    "config" JSONB NOT NULL,
    "createdByUserId" UUID,
    "publishedByUserId" UUID,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "catalog_config_versions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "catalog_config_versions_tenantId_version_key"
  ON "catalog_config_versions"("tenantId", "version");

-- Selector gabungan (tenant, id) dipakai service agar tidak ada lookup lintas
-- tenant yang mungkin; tetap dilindungi RLS di bawah.
CREATE UNIQUE INDEX "catalog_config_versions_tenantId_id_key"
  ON "catalog_config_versions"("tenantId", "id");

CREATE INDEX "catalog_config_versions_tenantId_status_idx"
  ON "catalog_config_versions"("tenantId", "status");

-- Satu draf dan satu versi published per tenant.
CREATE UNIQUE INDEX "catalog_config_versions_one_draft"
  ON "catalog_config_versions"("tenantId")
  WHERE "status" = 'DRAFT';

CREATE UNIQUE INDEX "catalog_config_versions_one_published"
  ON "catalog_config_versions"("tenantId")
  WHERE "status" = 'PUBLISHED';

ALTER TABLE "catalog_config_versions"
  ADD CONSTRAINT "catalog_config_versions_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- RLS fail-closed + grant (pola sama dengan migration tenant-scoped lain)
-- ============================================================

ALTER TABLE "catalog_config_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "catalog_config_versions" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "catalog_config_versions_tenant_isolation"
  ON "catalog_config_versions";

CREATE POLICY "catalog_config_versions_tenant_isolation"
  ON "catalog_config_versions"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "catalog_config_versions" TO sewain_dev;
GRANT SELECT, INSERT, UPDATE, DELETE ON "catalog_config_versions" TO sewain_migrator;
