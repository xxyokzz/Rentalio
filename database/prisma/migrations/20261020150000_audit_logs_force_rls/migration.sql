-- ============================================================
-- Audit RLS: audit_logs belum FORCE (satu-satunya tabel tenant-scoped
-- yang masih bisa dilewati oleh pemilik tabel).
--
-- Tabel ini dibuat oleh role migrator (pemilik). Tanpa FORCE, pemilik
-- melewati policy tenant dan bisa membaca audit seluruh tenant. Role
-- runtime (sewain_dev) sudah terkena policy, tetapi dokumen 10/03
-- menjanjikan fail-closed untuk SEMUA jalur; FORCE menutup celah owner.
--
-- Policy tetap: baris global (tenantId NULL) boleh dibaca semua konteks,
-- baris tenant hanya untuk app.tenant_id yang cocok.
-- ============================================================

ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;

-- Jaga-jaga bila policy pernah dihapus manual: buat ulang secara idempoten.
DROP POLICY IF EXISTS audit_logs_tenant_isolation ON "audit_logs";
CREATE POLICY audit_logs_tenant_isolation ON "audit_logs"
  USING (
    "tenantId" IS NULL
    OR "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    "tenantId" IS NULL
    OR "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );
