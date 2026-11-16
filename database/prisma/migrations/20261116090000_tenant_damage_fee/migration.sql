-- ============================================================
-- Rentalio — Migration: inspeksi kerusakan & denda kondisi
--
-- Dua saklar per tenant:
--   damageInspectionEnabled — mematikan alur inspeksi kerusakan.
--   damageFeeEnabled        — mematikan usulan denda kondisi (nominal tetap
--                             tersimpan supaya owner tidak perlu input ulang).
-- Nominal per tingkat kondisi (ringan/sedang/parah) adalah IDR rupiah utuh.
--
-- Inspeksi menyimpan snapshot konfigurasi saat dibuat agar perubahan nominal
-- tidak menulis ulang usulan inspeksi yang sudah berjalan, serta menyimpan
-- usulan denda otomatis terpisah dari keputusan final `penaltyAmount`.
-- Tidak ada tabel baru sehingga RLS yang ada tetap berlaku.
-- ============================================================

-- CreateEnum
CREATE TYPE "DamageSeverity" AS ENUM ('MINOR', 'MODERATE', 'SEVERE');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN "damageInspectionEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "tenants" ADD COLUMN "damageFeeEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tenants" ADD COLUMN "damageFeeMinorAmount" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "tenants" ADD COLUMN "damageFeeModerateAmount" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "tenants" ADD COLUMN "damageFeeSevereAmount" BIGINT NOT NULL DEFAULT 0;

-- Nominal negatif tidak masuk akal untuk denda.
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_damageFeeMinorAmount_non_negative"
  CHECK ("damageFeeMinorAmount" >= 0);
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_damageFeeModerateAmount_non_negative"
  CHECK ("damageFeeModerateAmount" >= 0);
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_damageFeeSevereAmount_non_negative"
  CHECK ("damageFeeSevereAmount" >= 0);

-- AlterTable
ALTER TABLE "inspections" ADD COLUMN "severity" "DamageSeverity";
ALTER TABLE "inspections" ADD COLUMN "damagePolicySnapshot" JSONB;
ALTER TABLE "inspections" ADD COLUMN "suggestedPenaltyAmount" BIGINT;

ALTER TABLE "inspections" ADD CONSTRAINT "inspections_suggestedPenaltyAmount_non_negative"
  CHECK ("suggestedPenaltyAmount" IS NULL OR "suggestedPenaltyAmount" >= 0);
