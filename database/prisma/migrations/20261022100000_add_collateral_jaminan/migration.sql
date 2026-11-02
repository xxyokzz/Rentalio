-- ============================================================
-- Rentalio — Migration: jaminan (collateral) penyewa per order
--
-- Konsep "jaminan" menggantikan tampilan "deposit" di UI, tetapi uang tetap
-- memakai ledger deposit (append-only) yang sudah ada — tidak ada dua sumber
-- kebenaran untuk uang. Model ini hanya mencatat jaminan non-uang:
--   - ID_CARD : jaminan utama (maksimal satu HELD per order, dicek server).
--   - OTHER   : jaminan lain, opsional, bisa banyak.
-- Baris bersifat riwayat: tidak pernah dihapus; pengembalian ditandai lewat
-- status RETURNED + returnedAt. RLS fail-closed tenant-scoped.
-- ============================================================

-- CreateEnum
CREATE TYPE "CollateralType" AS ENUM ('ID_CARD', 'OTHER');

-- CreateEnum
CREATE TYPE "CollateralStatus" AS ENUM ('HELD', 'RETURNED');

-- CreateTable
CREATE TABLE "collaterals" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "type" "CollateralType" NOT NULL,
    "status" "CollateralStatus" NOT NULL DEFAULT 'HELD',
    "label" TEXT NOT NULL,
    "documentNumber" TEXT,
    "description" TEXT,
    "notes" TEXT,
    "heldAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "returnedAt" TIMESTAMP(3),
    "actorUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "collaterals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "collaterals_tenantId_orderId_idx" ON "collaterals"("tenantId", "orderId");

-- CreateIndex
CREATE INDEX "collaterals_tenantId_orderId_status_idx" ON "collaterals"("tenantId", "orderId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "collaterals_tenantId_id_key" ON "collaterals"("tenantId", "id");

-- AddForeignKey (composite tenant-scoped → relasi lintas tenant ditolak DB)
ALTER TABLE "collaterals" ADD CONSTRAINT "collaterals_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "collaterals" ADD CONSTRAINT "collaterals_tenantId_orderId_fkey" FOREIGN KEY ("tenantId", "orderId") REFERENCES "rental_orders"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- RLS fail-closed + grant (tenant-scoped, pola sama dengan migration lain)
-- ============================================================

ALTER TABLE "collaterals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "collaterals" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "collaterals_tenant_isolation" ON "collaterals";
CREATE POLICY "collaterals_tenant_isolation" ON "collaterals"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "collaterals" TO sewain_dev;
