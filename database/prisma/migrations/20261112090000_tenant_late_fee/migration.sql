-- ============================================================
-- Rentalio — Migration: denda keterlambatan pengembalian
--
-- Nominal denda diatur owner per tenant, dengan satuan hari atau jam, dan
-- dapat dimatikan. Nilainya tidak menyentuh tagihan order secara otomatis;
-- denda dihitung server saat pengembalian dibaca dan menjadi usulan pada
-- inspeksi. Tidak ada tabel baru sehingga RLS yang ada tetap berlaku.
-- ============================================================

-- CreateEnum
CREATE TYPE "LateFeeUnit" AS ENUM ('DAY', 'HOUR');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN "lateFeeEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tenants" ADD COLUMN "lateFeeUnit" "LateFeeUnit" NOT NULL DEFAULT 'DAY';
ALTER TABLE "tenants" ADD COLUMN "lateFeeRateAmount" BIGINT NOT NULL DEFAULT 0;

-- Nilai uang selalu integer IDR rupiah utuh; tarif negatif tidak masuk akal.
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_lateFeeRateAmount_non_negative"
  CHECK ("lateFeeRateAmount" >= 0);
