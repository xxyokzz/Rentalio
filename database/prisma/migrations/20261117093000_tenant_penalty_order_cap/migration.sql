-- ============================================================
-- Rentalio — Migration: batas total denda per order
--
-- Plafon `damageFeeMaxAmount` membatasi satu usulan inspeksi. Kolom ini
-- membatasi akumulasi denda tercatat pada satu order, supaya beberapa inspeksi
-- tidak menghasilkan tagihan yang melampaui kewajaran. NULL = tanpa batas.
-- ============================================================

ALTER TABLE "tenants"
  ADD COLUMN "damagePenaltyOrderMaxAmount" BIGINT;

ALTER TABLE "tenants"
  ADD CONSTRAINT "tenants_damagePenaltyOrderMaxAmount_check"
  CHECK ("damagePenaltyOrderMaxAmount" IS NULL OR "damagePenaltyOrderMaxAmount" >= 0);
