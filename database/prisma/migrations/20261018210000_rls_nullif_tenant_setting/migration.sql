-- ============================================================
-- Rentalio — Migration 005: perbaikan policy RLS (fail-closed sejati)
--
-- Policy di migration 002/003 memakai:
--   "tenantId" = current_setting('app.tenant_id', true)::uuid
--
-- PostgreSQL mempertahankan custom GUC yang pernah di-set pada sebuah
-- koneksi (pool) sebagai string kosong untuk transaksi berikutnya.
-- Akibatnya `''::uuid` melempar error "invalid input syntax for type uuid"
-- dan query gagal 500 — bukan fail-closed seperti yang diklaim dokumen 03.
--
-- NULLIF(current_setting(...), '') mengembalikan NULL saat konteks belum
-- diset, sehingga policy bernilai false dan query mengembalikan nol baris.
-- ============================================================

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'customers', 'categories', 'products', 'assets', 'rates',
    'asset_maintenance', 'reservations', 'reservation_items',
    'reservation_allocations', 'rental_orders', 'rental_items',
    'payments', 'refunds', 'deposits', 'deposit_movements',
    'tenant_memberships', 'tenant_member_invitations', 'tenant_domains',
    'subscriptions', 'subscription_events',
    'return_records', 'return_items', 'inspections', 'inspection_attachments'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING ("tenantId" = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t || '_tenant_isolation', t);
  END LOOP;
END $$;

-- tenants: hanya baris milik konteks yang terlihat.
DROP POLICY IF EXISTS tenants_tenant_isolation ON tenants;
CREATE POLICY tenants_tenant_isolation ON tenants
  USING (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- plans: baris platform-wide (tenantId NULL) boleh dibaca semua konteks.
DROP POLICY IF EXISTS plans_tenant_isolation ON plans;
CREATE POLICY plans_tenant_isolation ON plans
  USING (
    "tenantId" IS NULL
    OR "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    "tenantId" IS NULL
    OR "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );

-- audit_logs: baris global (tenantId NULL) untuk kebutuhan platform.
DROP POLICY IF EXISTS audit_logs_tenant_isolation ON audit_logs;
CREATE POLICY audit_logs_tenant_isolation ON audit_logs
  USING (
    "tenantId" IS NULL
    OR "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    "tenantId" IS NULL
    OR "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );
