-- ============================================================
-- Rentalio — Migration: kelanjutan denda kerusakan
--
-- 1. `order_penalties` — denda kondisi yang sudah disetujui menjadi baris
--    tagihan order. Unik per inspeksi supaya keputusan yang sama tidak bisa
--    ditagih dua kali dan tidak mengubah totalAmount sewa.
-- 2. `inspection_items` — tingkat kerusakan per item/unit, bukan hanya satu
--    tingkat untuk seluruh order. Usulan tiap baris disimpan agar perubahan
--    tarif berikutnya tidak menulis ulang inspeksi lama.
-- 3. `damage_fee_revisions` — riwayat kebijakan denda tenant untuk audit.
-- 4. `damage_fee_category_amounts` — nominal khusus per kategori produk
--    (opsional; default tenant tetap dipakai bila baris tidak ada).
-- 5. `tenants.damageFeeMaxAmount` — plafon usulan (NULL = tanpa plafon).
-- 6. `deposit_deduction_requests.inspectionId` — tautan potongan deposit ke
--    keputusan inspeksi, unik agar satu inspeksi tidak memotong dua kali.
-- ============================================================

-- 1. Denda order
CREATE TABLE "order_penalties" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "inspectionId" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'IDR',
    "reason" TEXT NOT NULL,
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_penalties_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "order_penalties_tenantId_id_key" ON "order_penalties"("tenantId", "id");
CREATE UNIQUE INDEX "order_penalties_tenantId_inspectionId_key" ON "order_penalties"("tenantId", "inspectionId");
CREATE INDEX "order_penalties_tenantId_orderId_idx" ON "order_penalties"("tenantId", "orderId");
ALTER TABLE "order_penalties" ADD CONSTRAINT "order_penalties_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order_penalties" ADD CONSTRAINT "order_penalties_tenantId_orderId_fkey"
  FOREIGN KEY ("tenantId", "orderId") REFERENCES "rental_orders"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_penalties" ADD CONSTRAINT "order_penalties_tenantId_inspectionId_fkey"
  FOREIGN KEY ("tenantId", "inspectionId") REFERENCES "inspections"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2. Rincian per item
CREATE TABLE "inspection_items" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "inspectionId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "assetId" UUID,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "severity" "DamageSeverity" NOT NULL,
    "note" TEXT,
    "suggestedAmount" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inspection_items_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "inspection_items_tenantId_id_key" ON "inspection_items"("tenantId", "id");
CREATE INDEX "inspection_items_tenantId_inspectionId_idx" ON "inspection_items"("tenantId", "inspectionId");
ALTER TABLE "inspection_items" ADD CONSTRAINT "inspection_items_tenantId_inspectionId_fkey"
  FOREIGN KEY ("tenantId", "inspectionId") REFERENCES "inspections"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. Riwayat kebijakan
CREATE TABLE "damage_fee_revisions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "actorUserId" UUID NOT NULL,
    "inspectionEnabled" BOOLEAN NOT NULL,
    "feeEnabled" BOOLEAN NOT NULL,
    "minorAmount" BIGINT NOT NULL,
    "moderateAmount" BIGINT NOT NULL,
    "severeAmount" BIGINT NOT NULL,
    "maxAmount" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "damage_fee_revisions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "damage_fee_revisions_tenantId_id_key" ON "damage_fee_revisions"("tenantId", "id");
CREATE INDEX "damage_fee_revisions_tenantId_createdAt_idx" ON "damage_fee_revisions"("tenantId", "createdAt");

-- 4. Nominal per kategori
CREATE TABLE "damage_fee_category_amounts" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "minorAmount" BIGINT NOT NULL DEFAULT 0,
    "moderateAmount" BIGINT NOT NULL DEFAULT 0,
    "severeAmount" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "damage_fee_category_amounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "damage_fee_category_amounts_tenantId_categoryId_key"
  ON "damage_fee_category_amounts"("tenantId", "categoryId");
ALTER TABLE "damage_fee_category_amounts" ADD CONSTRAINT "damage_fee_category_amounts_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "damage_fee_category_amounts" ADD CONSTRAINT "damage_fee_category_amounts_tenantId_categoryId_fkey"
  FOREIGN KEY ("tenantId", "categoryId") REFERENCES "categories"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 5. Plafon usulan
ALTER TABLE "tenants" ADD COLUMN "damageFeeMaxAmount" BIGINT;
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_damageFeeMaxAmount_non_negative"
  CHECK ("damageFeeMaxAmount" IS NULL OR "damageFeeMaxAmount" >= 0);

-- 6. Tautan potongan deposit ke inspeksi
ALTER TABLE "deposit_deduction_requests" ADD COLUMN "inspectionId" UUID;
CREATE UNIQUE INDEX "deposit_deduction_requests_tenantId_inspectionId_key"
  ON "deposit_deduction_requests"("tenantId", "inspectionId");

-- RLS: tabel baru mengikuti pola tenant lain (FORCE RLS per app.tenant_id).
ALTER TABLE "order_penalties" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_penalties" FORCE ROW LEVEL SECURITY;
CREATE POLICY "order_penalties_tenant_isolation" ON "order_penalties"
  USING ("tenantId" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "inspection_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inspection_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "inspection_items_tenant_isolation" ON "inspection_items"
  USING ("tenantId" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "damage_fee_revisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "damage_fee_revisions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "damage_fee_revisions_tenant_isolation" ON "damage_fee_revisions"
  USING ("tenantId" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "damage_fee_category_amounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "damage_fee_category_amounts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "damage_fee_category_amounts_tenant_isolation" ON "damage_fee_category_amounts"
  USING ("tenantId" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::uuid);

-- Grant akses runtime ke role sewain_dev (pola migration 003).
GRANT SELECT, INSERT, UPDATE, DELETE ON "order_penalties" TO sewain_dev;
GRANT SELECT, INSERT, UPDATE, DELETE ON "inspection_items" TO sewain_dev;
GRANT SELECT, INSERT, UPDATE, DELETE ON "damage_fee_revisions" TO sewain_dev;
GRANT SELECT, INSERT, UPDATE, DELETE ON "damage_fee_category_amounts" TO sewain_dev;
