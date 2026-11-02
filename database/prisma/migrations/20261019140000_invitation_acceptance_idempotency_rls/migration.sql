-- ============================================================
-- Rentalio — Migration 007: penerimaan undangan staf + RLS idempotency
--
-- Dua celah ditutup di sini:
--
-- 1. `idempotency_records` menyimpan response body (dapat memuat data
--    tenant). Sebelumnya tabel ini tidak dilindungi RLS, sehingga query
--    tanpa konteks tenant dapat membacanya. Dokumen 03/10 mensyaratkan
--    RLS defense-in-depth untuk seluruh tabel tenant-scoped.
--
-- 2. `POST /auth/invitations/accept` menerima token SEBELUM tenant
--    diketahui, sehingga `app.tenant_id` belum dapat diset (policy
--    tenant-scoped fail-closed → nol baris). Token undangan adalah
--    rahasia 256-bit dan hanya disimpan sebagai hash; policy tambahan di
--    bawah hanya membuka baris yang `tokenHash`-nya PERSIS sama dengan
--    nilai yang diset aplikasi untuk transaksi itu. Tidak ada jalur untuk
--    membaca undangan tenant lain tanpa memiliki tokennya.
--    Setelah tenantId terbaca, service menyetel `app.tenant_id` di
--    transaksi yang sama untuk menyelesaikan membership + audit.
-- ============================================================

-- 1. Idempotency records: fail-closed tanpa konteks tenant.
ALTER TABLE idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_records FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS idempotency_records_tenant_isolation ON idempotency_records;
CREATE POLICY idempotency_records_tenant_isolation ON idempotency_records
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- 2a. Undangan: baca baris yang token hash-nya cocok dengan token request.
DROP POLICY IF EXISTS tenant_member_invitations_token_lookup
  ON tenant_member_invitations;
CREATE POLICY tenant_member_invitations_token_lookup
  ON tenant_member_invitations
  FOR SELECT
  USING (
    "tokenHash" = NULLIF(current_setting('app.invitation_token_hash', true), '')
  );

-- 2b. Undangan: konsumsi (UPDATE acceptedAt) hanya untuk baris dengan
--     token yang sama; tokenHash sendiri tidak boleh diubah oleh policy
--     ini (WITH CHECK memakai nilai yang sama).
DROP POLICY IF EXISTS tenant_member_invitations_token_consume
  ON tenant_member_invitations;
CREATE POLICY tenant_member_invitations_token_consume
  ON tenant_member_invitations
  FOR UPDATE
  USING (
    "tokenHash" = NULLIF(current_setting('app.invitation_token_hash', true), '')
  )
  WITH CHECK (
    "tokenHash" = NULLIF(current_setting('app.invitation_token_hash', true), '')
  );
