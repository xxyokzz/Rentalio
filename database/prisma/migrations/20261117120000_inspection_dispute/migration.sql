-- ============================================================
-- Rentalio — Migration: sengketa hasil inspeksi
--
-- Penyewa dapat menyanggah keputusan APPROVED lewat tautan pesanan. Inspeksi
-- masuk DISPUTED (tidak bisa ditagihkan), lalu owner/manager memutuskan ulang:
-- UPHELD (nominal tetap) atau REVISED (nominal baru). Jejak alasan disimpan.
-- ============================================================

ALTER TYPE "InspectionStatus" ADD VALUE IF NOT EXISTS 'DISPUTED';

ALTER TABLE "inspections"
  ADD COLUMN "disputeReason" TEXT,
  ADD COLUMN "disputedAt" TIMESTAMP(3),
  ADD COLUMN "disputeResolution" TEXT,
  ADD COLUMN "disputeResolvedAt" TIMESTAMP(3);

ALTER TABLE "inspections"
  ADD CONSTRAINT "inspections_dispute_resolution_check"
  CHECK ("disputeResolution" IS NULL OR "disputeResolution" IN ('UPHELD', 'REVISED'));

-- Sengketa yang sudah diselesaikan wajib punya waktu penyelesaian.
ALTER TABLE "inspections"
  ADD CONSTRAINT "inspections_dispute_resolved_check"
  CHECK (
    ("disputeResolution" IS NULL AND "disputeResolvedAt" IS NULL)
    OR ("disputeResolution" IS NOT NULL AND "disputeResolvedAt" IS NOT NULL)
  );
