-- ============================================================
-- Rentalio — Migration 010: order, pembayaran manual, dan ledger deposit
--
-- Acuan: ADR-001 §3–§4 + Notion 04 (kontrak command order/payment/deposit).
--
-- 1. `deposit_movements` menyimpan metode & referensi bukti pembayaran
--    (kontrak: "method/reference, evidence opsional"). Idempotency dan
--    append-only sudah ditegakkan migration sebelumnya.
-- 2. `deposit_deduction_requests` memisahkan PENGAJUAN potongan
--    (`deposit.deduct`) dari PERSETUJUAN (`deposit.deduct.approve`).
--    Movement DEDUCTION hanya dibuat saat APPROVED, sehingga saldo tidak
--    berubah selama permintaan masih PENDING.
-- 3. Unique (tenantId, reversesId) mencegah satu movement dibalik dua kali;
--    koreksi berikutnya harus memakai reversal baru atas movement lain.
-- 4. RLS fail-closed pada tabel baru (tenant-scoped).
-- ============================================================

-- AlterTable
ALTER TABLE "deposit_movements"
  ADD COLUMN "method" "PaymentMethod",
  ADD COLUMN "reference" TEXT;

-- CreateEnum
CREATE TYPE "DepositDeductionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "deposit_deduction_requests" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "depositId" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'IDR',
    "status" "DepositDeductionStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT NOT NULL,
    "conditionNotes" TEXT,
    "requestedByUserId" UUID NOT NULL,
    "approvedByUserId" UUID,
    "decisionReason" TEXT,
    "decidedAt" TIMESTAMP(3),
    "movementId" UUID,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deposit_deduction_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "deposit_movements_tenantId_id_key" ON "deposit_movements"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "deposit_movements_tenantId_reversesId_key" ON "deposit_movements"("tenantId", "reversesId");

-- CreateIndex
CREATE UNIQUE INDEX "deposit_deduction_requests_tenantId_id_key" ON "deposit_deduction_requests"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "deposit_deduction_requests_tenantId_idempotencyKey_key" ON "deposit_deduction_requests"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "deposit_deduction_requests_tenantId_movementId_key" ON "deposit_deduction_requests"("tenantId", "movementId");

-- CreateIndex
CREATE INDEX "deposit_deduction_requests_tenantId_orderId_status_idx" ON "deposit_deduction_requests"("tenantId", "orderId", "status");

-- AddForeignKey
ALTER TABLE "deposit_deduction_requests" ADD CONSTRAINT "deposit_deduction_requests_tenantId_orderId_fkey" FOREIGN KEY ("tenantId", "orderId") REFERENCES "rental_orders"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_deduction_requests" ADD CONSTRAINT "deposit_deduction_requests_tenantId_depositId_fkey" FOREIGN KEY ("tenantId", "depositId") REFERENCES "deposits"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_deduction_requests" ADD CONSTRAINT "deposit_deduction_requests_tenantId_movementId_fkey" FOREIGN KEY ("tenantId", "movementId") REFERENCES "deposit_movements"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Invariant nominal
ALTER TABLE "deposit_deduction_requests"
  ADD CONSTRAINT "deposit_deduction_requests_amount_positive" CHECK ("amount" > 0);

-- RLS: tabel baru tenant-scoped, fail-closed tanpa app.tenant_id.
ALTER TABLE "deposit_deduction_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "deposit_deduction_requests" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deposit_deduction_requests_tenant_isolation ON "deposit_deduction_requests";
CREATE POLICY deposit_deduction_requests_tenant_isolation ON "deposit_deduction_requests"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Runtime role (defense-in-depth; default privileges migration 004 juga berlaku).
GRANT SELECT, INSERT, UPDATE, DELETE ON "deposit_deduction_requests" TO sewain_dev;
GRANT SELECT, INSERT, UPDATE, DELETE ON "deposit_deduction_requests" TO sewain_migrator;
