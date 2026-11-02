-- ============================================================
-- Rentalio — SQL khusus PostgreSQL (di luar representasi Prisma)
-- Acuan: dokumen 03 (Model Data & Database), dokumen 10 (Backend & Database),
--        ADR-001 (Kontrak Lifecycle).
-- Bagian ini diterapkan sebagai migration SQL yang di-review, setelah
-- migration Prisma membuat tabel-tabelnya.
-- ============================================================

-- 1. Extension: wajib untuk exclusion constraint dengan operatorgist.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- 2. Anti double-booking unit fisik:
--    Dua allocation ACTIVE pada asset yang sama tidak boleh tumpang tindih.
--    Rentang half-open [start, end) via tsrange.
--    CATATAN: kolom DateTime Prisma = timestamp(3) WITHOUT time zone (UTC),
--    sehingga memakai tsrange — bukan tstzrange. tstzrange akan memicu cast
--    timestamp→timestamptz yang STABLE (bergantung TimeZone sesi) dan
--    ditolak PostgreSQL untuk index expression (harus IMMUTABLE).
--    Hanya baris ACTIVE yang dicek (history RELEASED bebas).
ALTER TABLE reservation_allocations
  ADD CONSTRAINT reservation_allocations_no_overlap_asset
  EXCLUDE USING gist (
    "assetId" WITH =,
    tsrange("startAt", "endAt", '[)') WITH &&
  )
  WHERE (status = 'ACTIVE' AND "assetId" IS NOT NULL);

-- 2b. CHECK constraints (invariant yang tidak direpresentasikan Prisma ORM).
ALTER TABLE reservation_items
  ADD CONSTRAINT reservation_items_quantity_positive CHECK ("quantity" > 0),
  ADD CONSTRAINT reservation_items_period_valid CHECK ("startAt" < "endAt");

ALTER TABLE reservation_allocations
  ADD CONSTRAINT reservation_allocations_quantity_positive CHECK ("quantity" > 0),
  ADD CONSTRAINT reservation_allocations_period_valid CHECK ("startAt" < "endAt");

ALTER TABLE reservations
  ADD CONSTRAINT reservations_period_valid CHECK ("startAt" < "endAt");

ALTER TABLE rental_items
  ADD CONSTRAINT rental_items_quantity_positive CHECK ("quantity" > 0),
  ADD CONSTRAINT rental_items_period_valid CHECK ("startAt" < "endAt");

ALTER TABLE asset_maintenance
  ADD CONSTRAINT asset_maintenance_period_valid CHECK ("startAt" < "endAt");

ALTER TABLE payments
  ADD CONSTRAINT payments_amount_positive CHECK ("amount" > 0);

ALTER TABLE refunds
  ADD CONSTRAINT refunds_amount_positive CHECK ("amount" > 0);

ALTER TABLE deposit_movements
  ADD CONSTRAINT deposit_movements_amount_positive CHECK ("amount" > 0);

-- 3. Append-only: deposit_movements tidak boleh di-UPDATE/DELETE.
--    Koreksi hanya melalui reversal (ADR-001 §4).
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Table % bersifat append-only; gunakan reversal/void.', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER deposit_movements_append_only
  BEFORE UPDATE OR DELETE ON deposit_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- 4. Append-only: audit_logs.
CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- 5. RLS: defense-in-depth pada tabel tenant-scoped.
--    Context di-set transaction-scoped via set_config('app.tenant_id', ..., true).
--    Fail-closed: tanpa context, current_setting menghasilkan NULL → policy false.

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
    'subscriptions', 'subscription_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING ("tenantId" = current_setting(''app.tenant_id'', true)::uuid)',
      t || '_tenant_isolation', t);
  END LOOP;
END $$;

-- 6. tenants & audit_logs punya tenantId nullable → policy khusus.
--    tenants: hanya baris milik context yang terlihat.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenants_tenant_isolation ON tenants;
CREATE POLICY tenants_tenant_isolation ON tenants
  USING (id = current_setting('app.tenant_id', true)::uuid);

-- audit_logs: tulis dengan tenant context; baca opsional menyaring baris
-- tenant lain. Baris global (tenantId NULL) hanya untuk keperluan platform.
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_logs_tenant_isolation ON audit_logs;
CREATE POLICY audit_logs_tenant_isolation ON audit_logs
  USING (
    "tenantId" IS NULL
    OR "tenantId" = current_setting('app.tenant_id', true)::uuid
  )
  WITH CHECK (
    "tenantId" IS NULL
    OR "tenantId" = current_setting('app.tenant_id', true)::uuid
  );

-- 6b. plans: ada baris platform-wide (tenantId NULL) yang boleh dibaca semua
--      konteks; baris milik tenant tetap terisolasi.
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE plans FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS plans_tenant_isolation ON plans;
CREATE POLICY plans_tenant_isolation ON plans
  USING (
    "tenantId" IS NULL
    OR "tenantId" = current_setting('app.tenant_id', true)::uuid
  )
  WITH CHECK (
    "tenantId" IS NULL
    OR "tenantId" = current_setting('app.tenant_id', true)::uuid
  );

-- 7. Grant minimum untuk role runtime.
--    Role dibuat terpisah (butuh CREATEROLE, di luar migration).
--    Migration ini akan GAGAL dengan pesan jelas bila role belum ada —
--    itu disengaja (dokumen 10: jangan menyembunyikan privilese yang kurang).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sewain_dev') THEN
    RAISE EXCEPTION
      'Role runtime "sewain_dev" belum ada. Buat role non-superuser tersebut dahulu (lihat README).';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sewain_migrator') THEN
    RAISE EXCEPTION 'Role migrasi "sewain_migrator" belum ada. Buat terlebih dahulu (lihat README).';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO sewain_dev;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sewain_dev;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sewain_dev;
GRANT USAGE ON SCHEMA public TO sewain_migrator;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES ON ALL TABLES IN SCHEMA public TO sewain_migrator;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sewain_migrator;
-- Tabel yang dibuat di kemudian hari juga otomatis mendapat grant yang sama.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sewain_dev;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO sewain_dev;
