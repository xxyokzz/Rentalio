-- ============================================================
-- Rentalio — Migration 013: template WhatsApp per tenant
--
-- Identitas template = tenant × context × paymentMethod × purpose.
-- Unique constraint mencegah dua template default yang ambigu untuk
-- kombinasi yang sama. Setiap perubahan body membuat baris versi baru;
-- histori tidak ditimpa. Template hanya menghasilkan teks click-to-chat,
-- tidak dieksekusi sebagai HTML/JavaScript.
--
-- Backfill: tenant yang sudah ada mendapat 9 template bawaan
-- (3 konteks × 3 metode) dan versi 1 untuk masing-masing.
-- ============================================================

CREATE TYPE "WhatsAppTemplatePurpose" AS ENUM (
  'PAYMENT_INSTRUCTION',
  'PAYMENT_CONFIRMATION'
);

CREATE TABLE "whatsapp_templates" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "context" "PaymentContext" NOT NULL,
    "paymentMethod" "PaymentMethod" NOT NULL,
    "purpose" "WhatsAppTemplatePurpose" NOT NULL,
    "name" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isSystemDefault" BOOLEAN NOT NULL DEFAULT true,
    "defaultTemplateKey" TEXT NOT NULL,
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "createdByUserId" UUID,
    "updatedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_templates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "whatsapp_template_versions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "templateId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "bodySnapshot" TEXT NOT NULL,
    "metadataSnapshot" JSONB,
    "actorId" UUID,
    "changeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_template_versions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "whatsapp_templates_tenantId_context_paymentMethod_purpose_key"
  ON "whatsapp_templates"("tenantId", "context", "paymentMethod", "purpose");

CREATE UNIQUE INDEX "whatsapp_templates_tenantId_id_key"
  ON "whatsapp_templates"("tenantId", "id");

CREATE INDEX "whatsapp_templates_tenantId_context_paymentMethod_idx"
  ON "whatsapp_templates"("tenantId", "context", "paymentMethod");

CREATE UNIQUE INDEX "whatsapp_template_versions_tenantId_templateId_version_key"
  ON "whatsapp_template_versions"("tenantId", "templateId", "version");

CREATE INDEX "whatsapp_template_versions_tenantId_templateId_idx"
  ON "whatsapp_template_versions"("tenantId", "templateId");

ALTER TABLE "whatsapp_templates"
  ADD CONSTRAINT "whatsapp_templates_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "whatsapp_template_versions"
  ADD CONSTRAINT "whatsapp_template_versions_tenantId_templateId_fkey"
  FOREIGN KEY ("tenantId", "templateId")
  REFERENCES "whatsapp_templates"("tenantId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "whatsapp_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "whatsapp_templates" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS whatsapp_templates_tenant_isolation ON "whatsapp_templates";
CREATE POLICY whatsapp_templates_tenant_isolation ON "whatsapp_templates"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "whatsapp_template_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "whatsapp_template_versions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS whatsapp_template_versions_tenant_isolation
  ON "whatsapp_template_versions";
CREATE POLICY whatsapp_template_versions_tenant_isolation
  ON "whatsapp_template_versions"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "whatsapp_templates" TO sewain_dev;
GRANT SELECT, INSERT, UPDATE, DELETE ON "whatsapp_template_versions" TO sewain_dev;
GRANT SELECT, INSERT, UPDATE, DELETE ON "whatsapp_templates" TO sewain_migrator;
GRANT SELECT, INSERT, UPDATE, DELETE ON "whatsapp_template_versions" TO sewain_migrator;

-- ------------------------------------------------------------------
-- Backfill 9 template bawaan untuk setiap tenant yang sudah ada.
-- Placeholder resmi: nama_bisnis, nama_penyewa, nomor_pesanan,
-- daftar_barang, periode, nominal_tagihan, jenis_transaksi,
-- waktu_pembayaran.
-- ------------------------------------------------------------------
INSERT INTO "whatsapp_templates" (
  "id", "tenantId", "context", "paymentMethod", "purpose", "name", "body",
  "isActive", "isSystemDefault", "defaultTemplateKey", "currentVersion",
  "createdByUserId", "updatedByUserId", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid(),
  t."id",
  c."context"::"PaymentContext",
  m."method"::"PaymentMethod",
  m."purpose"::"WhatsAppTemplatePurpose",
  c."label" || ' — ' || m."label",
  m."body",
  true,
  true,
  c."context" || '_' || m."method" || '_' || m."purpose",
  1,
  NULL,
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "tenants" t
CROSS JOIN (VALUES
  ('NEW_BOOKING', 'Booking baru'),
  ('ADD_UNIT', 'Tambah unit'),
  ('EXTENSION', 'Perpanjangan sewa')
) AS c("context", "label")
CROSS JOIN (VALUES
  (
    'CASH',
    'PAYMENT_INSTRUCTION',
    'Cash',
    $body$Halo {{nama_penyewa}}, pembayaran {{jenis_transaksi}} sewa di {{nama_bisnis}} dilakukan secara tunai.

Nomor pesanan: {{nomor_pesanan}}
Barang sewa: {{daftar_barang}}
Periode: {{periode}}
Total tagihan: {{nominal_tagihan}}

Silakan serahkan pembayaran kepada petugas. Status pembayaran diperbarui setelah petugas menerima dan mencatat dana.$body$
  ),
  (
    'BANK_TRANSFER',
    'PAYMENT_INSTRUCTION',
    'Transfer Bank',
    $body$Halo Admin {{nama_bisnis}}, saya ingin melakukan pembayaran {{jenis_transaksi}} sewa dengan transfer bank.

Nomor pesanan: {{nomor_pesanan}}
Nama penyewa: {{nama_penyewa}}
Barang sewa: {{daftar_barang}}
Periode: {{periode}}
Total tagihan: {{nominal_tagihan}}

Mohon informasikan nomor rekening dan petunjuk pembayaran yang harus saya gunakan.

Terima kasih.$body$
  ),
  (
    'QRIS',
    'PAYMENT_CONFIRMATION',
    'QRIS',
    $body$Halo Admin {{nama_bisnis}}, saya ingin mengonfirmasi pembayaran {{jenis_transaksi}} sewa melalui QRIS.

Nomor pesanan: {{nomor_pesanan}}
Nama penyewa: {{nama_penyewa}}
Barang sewa: {{daftar_barang}}
Periode: {{periode}}
Total pembayaran: {{nominal_tagihan}}
Waktu pembayaran: {{waktu_pembayaran}}

Mohon periksa dan catat setelah pembayaran terverifikasi.

Terima kasih.$body$
  )
) AS m("method", "purpose", "label", "body")
ON CONFLICT ("tenantId", "context", "paymentMethod", "purpose") DO NOTHING;

INSERT INTO "whatsapp_template_versions" (
  "id", "tenantId", "templateId", "version", "bodySnapshot",
  "metadataSnapshot", "actorId", "changeReason", "createdAt"
)
SELECT
  gen_random_uuid(),
  w."tenantId",
  w."id",
  1,
  w."body",
  NULL,
  NULL,
  'SEED_DEFAULT',
  CURRENT_TIMESTAMP
FROM "whatsapp_templates" w
ON CONFLICT ("tenantId", "templateId", "version") DO NOTHING;
