-- ============================================================
-- Rentalio — Migration: pembatalan denda order
--
-- Denda yang salah tagih harus bisa dikoreksi tanpa menghapus baris audit.
-- `status` RECORDED ikut menambah `penaltyTotalAmount`/`amountDue`; VOIDED
-- tidak, tetapi baris dan alasannya tetap tersimpan.
-- ============================================================

ALTER TABLE "order_penalties"
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'RECORDED',
  ADD COLUMN "voidedAt" TIMESTAMP(3),
  ADD COLUMN "voidedByUserId" UUID,
  ADD COLUMN "voidedReason" TEXT;

ALTER TABLE "order_penalties"
  ADD CONSTRAINT "order_penalties_status_check"
  CHECK ("status" IN ('RECORDED', 'VOIDED'));

-- VOIDED wajib lengkap; RECORDED tidak boleh membawa metadata pembatalan.
ALTER TABLE "order_penalties"
  ADD CONSTRAINT "order_penalties_void_metadata_check"
  CHECK (
    ("status" = 'RECORDED' AND "voidedAt" IS NULL AND "voidedByUserId" IS NULL AND "voidedReason" IS NULL)
    OR ("status" = 'VOIDED' AND "voidedAt" IS NOT NULL AND "voidedByUserId" IS NOT NULL AND "voidedReason" IS NOT NULL)
  );

CREATE INDEX "order_penalties_tenantId_orderId_status_idx"
  ON "order_penalties"("tenantId", "orderId", "status");
