-- ============================================================
-- Rentalio — Migration 015: konteks baca untuk reconciler subscription
--
-- Reconciler berjalan terjadwal dan perlu menemukan tenant yang trial/grace-nya
-- sudah berakhir. `tenants` dan `subscriptions` memakai FORCE RLS sehingga
-- scan lintas tenant mustahil tanpa konteks khusus.
--
-- Policy di sini hanya SELECT. Transisi status tetap dilakukan di transaksi
-- `app.tenant_id` (PrismaService.withTenant), sehingga reconciler tidak pernah
-- mendapat hak menulis lintas tenant. Konteks `app.subscription_reconciler`
-- hanya di-set transaction-scoped oleh PrismaService.withSubscriptionReconciler.
-- ============================================================

DROP POLICY IF EXISTS tenants_subscription_reconciler ON tenants;
CREATE POLICY tenants_subscription_reconciler ON tenants
  FOR SELECT
  USING (current_setting('app.subscription_reconciler', true) = 'on');

DROP POLICY IF EXISTS subscriptions_subscription_reconciler ON subscriptions;
CREATE POLICY subscriptions_subscription_reconciler ON subscriptions
  FOR SELECT
  USING (current_setting('app.subscription_reconciler', true) = 'on');
