-- ============================================================
-- Rentalio — Migration 011: alur refund pembayaran sewa
--
-- Refund tetap entitas terpisah dari Payment dan Deposit (ADR-001).
-- Status: REQUESTED → APPROVED → SUCCEEDED | FAILED, atau CANCELLED.
-- Kolom baru menyimpan keputusan, bukti/referensi hasil, dan aktor proses.
--
-- Batas kumulatif refund tidak dapat dinyatakan sebagai CHECK per baris;
-- ditegakkan service dengan mengunci baris payment (`SELECT ... FOR UPDATE`)
-- lalu menghitung refund berstatus aktif. Tes paralel membuktikan invariant.
-- ============================================================

ALTER TABLE "refunds"
  ADD COLUMN "reference" TEXT,
  ADD COLUMN "decisionReason" TEXT,
  ADD COLUMN "processedByUserId" UUID,
  ADD COLUMN "resultNote" TEXT;

-- Query refundable amount dan daftar refund per payment.
CREATE INDEX "refunds_tenantId_paymentId_idx" ON "refunds"("tenantId", "paymentId");

-- Currency tidak boleh kosong (konsisten dengan ledger deposit).
ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_currency_not_empty" CHECK (btrim("currency") <> '');

-- RLS, unique (tenantId, id), dan CHECK amount > 0 sudah dipasang pada
-- migration 002; tidak diulang di sini.
