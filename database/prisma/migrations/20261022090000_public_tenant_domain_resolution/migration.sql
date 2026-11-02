-- ============================================================
-- Rentalio — Migration 020: resolusi katalog dari domain kustom tenant
--
-- Latar: TenantDomain sudah ada sejak baseline, tetapi belum ada jalur baca
-- publik untuk memetakan hostname → tenant. Tanpa policy ini, `tenant_domains`
-- hanya terbaca saat `app.tenant_id` sudah diketahui (RLS fail-closed),
-- sehingga request tanpa sesi tidak pernah bisa meresolusi domain.
--
-- Policy di bawah hanya membuka SELECT satu baris yang hostname-nya persis
-- sama dengan `app.public_hostname`. Aktivasi tetap ditentukan aplikasi:
-- `isActive = true` DAN `verifiedAt` terisi. Pemanggil wajib menyetel
-- `app.tenant_id` setelah tenantId domain ditemukan sebelum membaca tabel
-- tenant-scoped lain (lihat PrismaService.withPublicHostname).
-- ============================================================

DROP POLICY IF EXISTS tenant_domains_public_host_read ON "tenant_domains";
CREATE POLICY tenant_domains_public_host_read ON "tenant_domains"
  FOR SELECT
  USING (
    "hostname" = NULLIF(current_setting('app.public_hostname', true), '')
  );
