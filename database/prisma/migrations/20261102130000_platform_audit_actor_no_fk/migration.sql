-- ============================================================
-- Rentalio — Migration 031: audit platform tidak lagi memakai FK aktor
--
-- `platform_audit_events` bersifat append-only (trigger menolak UPDATE/DELETE).
-- FK `actorAdminId` memakai `ON DELETE SET NULL`, sehingga menghapus admin yang
-- punya jejak audit memicu UPDATE internal PostgreSQL — dan langsung ditolak
-- trigger dengan `P0001: platform_audit_events is append-only`. Akibatnya akun
-- admin tidak bisa dibersihkan dari database sama sekali.
--
-- Jejak audit justru harus bertahan lebih lama daripada akun pelakunya. Karena
-- itu constraint dilepas: `actorAdminId` tetap disimpan sebagai UUID biasa
-- (index tetap ada) tanpa integritas referensial.
--
-- Penghapusan admin lewat aplikasi tidak ada; perubahan ini memperbaiki jalur
-- operasional (purge akun) tanpa melemahkan audit, karena baris audit tetap
-- tidak dapat diubah/dihapus.
-- ============================================================

ALTER TABLE "platform_audit_events"
  DROP CONSTRAINT IF EXISTS "platform_audit_events_actorAdminId_fkey";
