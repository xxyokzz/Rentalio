-- ============================================================
-- Rentalio — Migration: aksi suspend/reactivate tenant oleh Admin Platform
--
-- Direktori admin sebelumnya hanya mendapat SELECT (`app.platform_admin`).
-- Aksi suspend/reactivate memerlukan UPDATE, tetapi RLS tidak dapat membatasi
-- kolom. Karena itu perlindungannya berlapis:
--
-- 1. Policy UPDATE hanya terbuka ketika `app.platform_admin = 'on'`
--    (transaction-scoped, di-set PrismaService.withPlatformAdmin).
-- 2. Trigger `tenants_platform_admin_status_only` menolak perubahan kolom apa
--    pun selain `status` dan `updatedAt` selama konteks admin aktif. Check ini
--    memakai `to_jsonb` sehingga tetap benar ketika schema bertambah kolom
--    baru, tanpa perlu memperbarui daftar kolom.
-- 3. Transisi status tetap divalidasi service (ACTIVE/PENDING_ACTIVATION →
--    SUSPENDED; SUSPENDED → ACTIVE; CLOSED bersifat final) dan setiap
--    percobaan dicatat di `platform_audit_events`.
--
-- Konteks tenant biasa tidak terpengaruh: trigger hanya aktif untuk
-- `app.platform_admin`, dan policy tenant_isolation tetap menjadi satu-satunya
-- jalur update bagi pemilik tenant.
-- ============================================================

DROP POLICY IF EXISTS tenants_platform_admin_status_update ON tenants;
CREATE POLICY tenants_platform_admin_status_update ON tenants
  FOR UPDATE
  USING (current_setting('app.platform_admin', true) = 'on')
  WITH CHECK (current_setting('app.platform_admin', true) = 'on');

CREATE OR REPLACE FUNCTION platform_admin_tenant_status_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.platform_admin', true) = 'on'
     AND (to_jsonb(OLD) - 'status' - 'updatedAt')
         IS DISTINCT FROM (to_jsonb(NEW) - 'status' - 'updatedAt') THEN
    RAISE EXCEPTION 'Admin Platform hanya boleh mengubah status tenant'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tenants_platform_admin_status_only ON tenants;
CREATE TRIGGER tenants_platform_admin_status_only
  BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION platform_admin_tenant_status_only();
