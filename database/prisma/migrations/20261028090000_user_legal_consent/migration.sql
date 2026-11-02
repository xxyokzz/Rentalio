-- ============================================================
-- Rentalio — Migration: bukti persetujuan legal saat registrasi OWNER
--
-- Dokumen 04 (Kontrak pendaftaran OWNER): "Simpan bukti persetujuan
-- syarat/kebijakan (versi dan timestamp)." Kolom bersifat nullable agar baris
-- user yang dibuat sebelum kontrak ini tetap sah; registrasi baru selalu
-- mengisi ketiga kolomnya.
-- ============================================================

-- AlterTable
ALTER TABLE "users" ADD COLUMN "termsConsentVersion" TEXT,
ADD COLUMN "privacyConsentVersion" TEXT,
ADD COLUMN "legalConsentAt" TIMESTAMP(3);
