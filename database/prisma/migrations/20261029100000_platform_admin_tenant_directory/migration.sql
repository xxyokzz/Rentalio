-- ============================================================
-- Rentalio — Migration: konteks baca direktori tenant untuk Admin Platform
--
-- Admin Platform perlu daftar tenant lintas tenant (PLAT-01/07), sedangkan
-- `tenants` memakai FORCE RLS sehingga query tanpa konteks selalu kosong.
-- Solusi ini mengikuti pola konteks sistem yang sudah ada (outbox worker,
-- reconciler subscription): satu policy SELECT tambahan yang hanya terbuka
-- ketika `app.platform_admin = 'on'` di-set transaction-scoped oleh
-- PrismaService.withPlatformAdmin.
--
-- Batasan yang dijaga:
-- - SELECT saja pada `tenants`; tidak ada INSERT/UPDATE/DELETE lintas tenant.
-- - Tabel tenant-scoped lain (members, katalog, order, dsb.) tetap tertutup.
-- - Konteks hanya di-set oleh service Admin Platform setelah sesi admin
--   terverifikasi MFA dan permission `platform.tenants.list` dimiliki.
-- ============================================================

DROP POLICY IF EXISTS tenants_platform_admin_directory ON tenants;
CREATE POLICY tenants_platform_admin_directory ON tenants
  FOR SELECT
  USING (current_setting('app.platform_admin', true) = 'on');
