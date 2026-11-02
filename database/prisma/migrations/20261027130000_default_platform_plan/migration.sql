-- Plan platform default untuk trial 72 jam.
--
-- `TenantService.createTenant` mencari plan platform (`tenantId IS NULL`)
-- dengan code `free` untuk membuat baris `subscriptions` berstatus TRIALING.
-- `subscriptions.planId` NOT NULL, sehingga tanpa baris plan ini pembuatan
-- subscription dilewati diam-diam: tenant baru berjalan hanya lewat fallback
-- `tenants.trialEndsAt`, reconciler tidak punya baris untuk diproses, dan
-- klaim kontrak "POST /tenants membuat subscription TRIALING" tidak terpenuhi
-- (dulu seed dev memakai code `trial-72h` sehingga tidak pernah cocok).
--
-- Harga sengaja 0 dan tanpa kuota: harga/kuota paket adalah backlog keputusan
-- komersial pemilik produk (Notion 06 & 08) dan tidak boleh diarang di sini.
--
-- Idempoten: dijalankan ulang tidak menambah baris (tidak ada unique index
-- untuk `tenantId IS NULL`, jadi dijaga dengan NOT EXISTS).
INSERT INTO plans (id, "tenantId", code, name, "priceAmount", currency, "isActive", "createdAt", "updatedAt")
SELECT gen_random_uuid(), NULL, 'free', 'Free', 0, 'IDR', true, now(), now()
WHERE NOT EXISTS (
  SELECT 1 FROM plans WHERE "tenantId" IS NULL AND code = 'free'
);
