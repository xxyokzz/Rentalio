-- ============================================================
-- Rentalio — Migration 008: RLS pada outbox_events
--
-- `outbox_events` menyimpan payload event domain (dapat memuat data
-- tenant) tetapi sebelumnya satu-satunya tabel ber-`tenantId` yang belum
-- dilindungi RLS. Migration ini menutup celah tersebut.
--
-- Policy fail-closed: tanpa `app.tenant_id` tidak ada baris yang terbaca
-- dan tidak ada baris yang dapat ditulis.
--
-- Baris platform (tenantId NULL) SENGAJA tidak terlihat dari konteks
-- tenant mana pun. Worker outbox belum ada; saat dibangun, worker harus
-- memakai policy/role sistem tersendiri, bukan melonggarkan policy ini.
-- ============================================================

ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS outbox_events_tenant_isolation ON outbox_events;
CREATE POLICY outbox_events_tenant_isolation ON outbox_events
  USING (
    "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    "tenantId" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );
