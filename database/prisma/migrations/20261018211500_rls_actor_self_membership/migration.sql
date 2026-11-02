-- ============================================================
-- Rentalio — Migration 006: policy RLS untuk aktor (daftar tenant sendiri)
--
-- GET /tenants perlu membaca membership milik aktor SEBELUM tenant context
-- diketahui (satu request, banyak tenant). Karena RLS `FORCE` dan policy
-- tenant-scoped fail-closed, query tanpa `app.tenant_id` mengembalikan nol
-- baris sehingga endpoint ini mustahil berfungsi.
--
-- Solusinya: policy permissive tambahan yang hanya berlaku bila konteks aktor
-- `app.user_id` di-set (PrismaService.withActor), dibatasi ke baris milik
-- aktor sendiri. Policy tenant-scoped tetap berlaku untuk operasi lain, dan
-- penulisan tetap membutuhkan `app.tenant_id` yang cocok.
-- ============================================================

-- 1. tenant_memberships: aktor boleh membaca membership-nya sendiri.
DROP POLICY IF EXISTS tenant_memberships_actor_self ON tenant_memberships;
CREATE POLICY tenant_memberships_actor_self ON tenant_memberships
  FOR SELECT
  USING (
    "userId" = NULLIF(current_setting('app.user_id', true), '')::uuid
  );

-- 2. tenants: aktor boleh membaca metadata tenant tempat ia anggota aktif.
--    Subquery memakai policy actor di atas, jadi tetap terbatas pada
--    membership milik aktor; tidak ada kebocoran lintas tenant.
DROP POLICY IF EXISTS tenants_actor_membership ON tenants;
CREATE POLICY tenants_actor_membership ON tenants
  FOR SELECT
  USING (
    id IN (
      SELECT tm."tenantId"
      FROM tenant_memberships tm
      WHERE tm."userId" = NULLIF(current_setting('app.user_id', true), '')::uuid
        AND tm.status = 'ACTIVE'
    )
  );
