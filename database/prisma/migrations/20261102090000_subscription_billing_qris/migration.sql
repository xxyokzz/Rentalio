-- ============================================================
-- Rentalio — Migration 029: billing langganan memakai QRIS dinamis
--
-- Mengganti payment gateway Xendit dengan QRIS dinamis milik merchant Rentalio.
-- QRIS dinamis tidak punya callback: status lunas TIDAK PERNAH ditetapkan
-- otomatis oleh provider. Tagihan PENDING → PAID hanya lewat tindakan operator
-- platform (Admin Platform, permission `platform.subscriptions.settle`) setelah
-- dana terverifikasi.
--
-- Perubahan:
--   * kolom `qrPayload` menyimpan string QRIS dinamis (nominal tertanam);
--   * kolom `invoiceUrl` (tautan checkout Xendit) dan `providerInvoiceId`
--     (id invoice di provider) dihapus karena tidak ada provider eksternal;
--   * default `provider` menjadi 'qris' untuk baris baru (baris lama tetap
--     menyimpan nilai historisnya);
--   * policy baca lintas tenant `app.billing_system` dihapus — satu-satunya
--     pemakai lama adalah webhook dan job rekonsiliasi provider;
--   * permission baru `platform.subscriptions.settle` untuk menandai tagihan
--     lunas secara manual dan teraudit.
-- ============================================================

ALTER TABLE "subscription_invoices" ADD COLUMN "qrPayload" TEXT;

ALTER TABLE "subscription_invoices" DROP COLUMN "invoiceUrl";
ALTER TABLE "subscription_invoices" DROP COLUMN "providerInvoiceId";

ALTER TABLE "subscription_invoices" ALTER COLUMN "provider" SET DEFAULT 'qris';

DROP POLICY IF EXISTS "subscription_invoices_billing_system" ON "subscription_invoices";

-- ============================================================
-- Admin Platform: permission untuk menetapkan tagihan lunas.
-- Terpisah dari `platform.subscriptions.manage` supaya kewenangan menandai
-- pembayaran diterima bisa diberikan selektif dan selalu meninggalkan audit.
-- ============================================================

INSERT INTO "platform_permissions" ("id", "code", "description")
VALUES (
  '20000000-0000-4000-8000-000000000025',
  'platform.subscriptions.settle',
  'Settle subscription invoices after verified QRIS payment'
)
ON CONFLICT ("code") DO NOTHING;

-- Super Admin (semua permission), Billing, dan Support tidak mendapat
-- kewenangan ini secara otomatis; hanya Super Admin + Billing.
INSERT INTO "platform_role_permissions" ("id", "roleId", "permissionId")
SELECT gen_random_uuid(), r."id", p."id"
FROM "platform_roles" r
JOIN "platform_permissions" p ON p."code" = 'platform.subscriptions.settle'
WHERE r."code" IN ('PLATFORM_SUPER_ADMIN', 'PLATFORM_BILLING')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
