-- ============================================================
-- Rentalio — Migration 009: antrean worker outbox
--
-- Menambah kolom penjadwalan retry + dead-letter, lalu membuka policy
-- SISTEM terpisah untuk worker. Worker berjalan dengan konteks
-- `app.outbox_system = 'on'` (transaction-scoped), bukan `app.tenant_id`,
-- sehingga dapat memproses event semua tenant sekaligus.
--
-- Policy sistem hanya SELECT + UPDATE: worker tidak boleh membuat event.
-- Event tetap ditulis oleh transaksi domain dengan `app.tenant_id`.
-- ============================================================

ALTER TABLE outbox_events
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3),
  ADD COLUMN "deadLetteredAt" TIMESTAMP(3);

CREATE INDEX "outbox_events_nextAttemptAt_createdAt_idx"
  ON outbox_events ("nextAttemptAt", "createdAt");

-- Policy permissive OR dengan policy tenant (migration 008): konteks sistem
-- melihat/memperbarui seluruh baris; konteks tenant tetap hanya miliknya.
DROP POLICY IF EXISTS outbox_events_system_select ON outbox_events;
CREATE POLICY outbox_events_system_select ON outbox_events
  FOR SELECT
  USING (current_setting('app.outbox_system', true) = 'on');

DROP POLICY IF EXISTS outbox_events_system_update ON outbox_events;
CREATE POLICY outbox_events_system_update ON outbox_events
  FOR UPDATE
  USING (current_setting('app.outbox_system', true) = 'on')
  WITH CHECK (current_setting('app.outbox_system', true) = 'on');
