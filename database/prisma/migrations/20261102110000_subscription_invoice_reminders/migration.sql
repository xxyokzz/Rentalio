-- ============================================================
-- Rentalio — Migration 030: pengingat tagihan langganan untuk operator
--
-- QRIS dinamis tidak punya callback, jadi pembayaran hanya bisa diverifikasi
-- manual. Supaya tagihan tidak menggantung tanpa ada yang tahu, proses worker
-- memindai tagihan PENDING lalu mengirim email pengingat ke operator platform:
--
--   1. pengingat pertama setelah tagihan berumur beberapa menit
--      (`operatorNotifiedAt` kosong), dan
--   2. pengingat kedua saat tagihan mendekati kedaluwarsa
--      (`expiryNotifiedAt` kosong).
--
-- Kedua kolom menjadi kunci idempoten: satu tagihan hanya memicu satu email per
-- tahap walau beberapa replika worker berjalan bersamaan, karena klaim memakai
-- UPDATE bersyarat kolom tersebut masih NULL.
--
-- RLS: policy baca lintas tenant baru `app.billing_reminder` (SELECT saja) agar
-- job dapat menemukan tagihan dari seluruh tenant. Penulisan klaim dan
-- pencatatan audit tetap dijalankan pada konteks `app.tenant_id`.
-- ============================================================

ALTER TABLE "subscription_invoices"
  ADD COLUMN "operatorNotifiedAt" TIMESTAMP(3),
  ADD COLUMN "expiryNotifiedAt" TIMESTAMP(3);

-- Pemindaian job hanya menyentuh baris PENDING.
CREATE INDEX "subscription_invoices_pending_reminder_idx"
  ON "subscription_invoices" ("status", "createdAt")
  WHERE "status" = 'PENDING';

DROP POLICY IF EXISTS "subscription_invoices_billing_reminder" ON "subscription_invoices";
CREATE POLICY "subscription_invoices_billing_reminder"
  ON "subscription_invoices"
  FOR SELECT
  USING (current_setting('app.billing_reminder', true) = 'on');
