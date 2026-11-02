-- ============================================================
-- Rentalio — Migration 004: kolom profil owner/tenant pada "users"
--
-- `prisma/schema.prisma` mendefinisikan User.ownerName/tenantName/tenantSlug,
-- tetapi migration 001–003 belum membuat kolomnya sehingga database yang
-- dibangun dari nol berbeda dari schema: setiap query User gagal dengan
-- "column users.ownerName does not exist" (registrasi/login 500).
--
-- Kolom dipakai sebagai data pendaftaran awal (nama owner, nama & slug tenant
-- yang diminta saat signup) sebelum tenant dibuatkan saat verifikasi email.
-- ============================================================

ALTER TABLE "users"
  ADD COLUMN "ownerName"  TEXT,
  ADD COLUMN "tenantName" TEXT,
  ADD COLUMN "tenantSlug" TEXT;
