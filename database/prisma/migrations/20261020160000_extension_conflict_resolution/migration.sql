-- ============================================================
-- Penyelesaian konflik perpanjangan sewa
--
-- Konflik berstatus OPEN adalah tugas operasional. Saat staf menandai
-- selesai, command menyimpan jejak siapa/kapan/catatan agar audit dan
-- dashboard tidak bergantung pada log audit saja.
--
-- Index tambahan dipakai untuk menghitung ulang flag `hasOpenConflict`
-- pada order & reservasi terdampak setelah setiap penyelesaian.
-- ============================================================

ALTER TABLE "extension_conflicts"
  ADD COLUMN "resolvedAt" TIMESTAMP(3),
  ADD COLUMN "resolvedByUserId" UUID,
  ADD COLUMN "resolutionNote" TEXT;

CREATE INDEX "extension_conflicts_tenantId_orderId_status_idx"
  ON "extension_conflicts"("tenantId", "orderId", "status");
CREATE INDEX "extension_conflicts_tenantId_conflictingOrderId_idx"
  ON "extension_conflicts"("tenantId", "conflictingOrderId");
CREATE INDEX "extension_conflicts_tenantId_conflictingReservationId_idx"
  ON "extension_conflicts"("tenantId", "conflictingReservationId");
