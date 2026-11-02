# SQL Khusus PostgreSQL — Rentalio

File SQL di direktori ini adalah fitur PostgreSQL yang **tidak direpresentasikan**
oleh Prisma ORM (extension, exclusion constraint, RLS policy, trigger).
Semua file diterapkan melalui migration Prisma yang di-review (dokumen 03, bagian Migrasi).

| File | Tujuan |
| --- | --- |
| `rls_and_constraints.sql` | Extension `btree_gist`, exclusion constraint anti double-booking unit fisik, trigger append-only `deposit_movements`/`audit_logs`, RLS + FORCE RLS pada tabel tenant-scoped |

## Urutan penerapan

Migration dibuat via `pnpm db:migrate:dev --name <nama>` lalu SQL hasil generate
Prisma **digabung/diedit** dengan isi file ini sesuai urutan:

1. Extension harus dibuat **sebelum** constraint yang membutuhkannya.
2. Constraint/trigger diterapkan setelah tabel ada.
3. `ENABLE/FORCE ROW LEVEL SECURITY` + policy adalah langkah terakhir.

Alternatif: buat migration SQL manual (`prisma migrate diff` + edit) dan commit.

## Catatan runtime role

- RLS dites dengan **role runtime aplikasi** (`sewain_dev`), bukan role admin.
  Role migrasi terpisah (`sewain_migrator`) hanya dipakai `prisma migrate deploy`.
- `SET LOCAL app.tenant_id` dipanggil dalam transaksi oleh `PrismaService.withTenant`.
- Policy **fail-closed**: tanpa `app.tenant_id`, query tabel tenant-scoped menghasilkan nol baris.
- Policy memakai `NULLIF(current_setting('app.tenant_id', true), '')::uuid`; tanpa
  `NULLIF`, koneksi pool yang pernah di-set mengembalikan string kosong dan cast
  `''::uuid` melempar error 500 (diperbaiki di migration 005).
- Tabel tenant-scoped memakai `FORCE RLS`, sehingga **penulisan** (INSERT) juga
  memerlukan `app.tenant_id` yang cocok — termasuk saat membuat tenant baru.
- `idempotency_records` ikut dilindungi RLS (migration 007) karena menyimpan
  response body yang dapat memuat data tenant.
- `outbox_events` dilindungi RLS (migration 008). Policy-nya tenant-only:
  baris platform (`tenantId NULL`) tidak terlihat dari konteks tenant.
- Worker outbox memakai konteks `app.outbox_system = 'on'` (migration 009).
  Policy sistem hanya `SELECT` + `UPDATE`; event tetap ditulis oleh transaksi
  domain dengan `app.tenant_id`, sehingga worker tidak bisa memalsukan event.
- Penerimaan undangan memakai konteks `app.invitation_token_hash`: policy
  `tenant_member_invitations_token_lookup`/`_consume` hanya membuka baris yang
  hash tokennya persis sama, sehingga tenant context belum perlu diketahui
  untuk menemukan undangan.
- Reconciler subscription memakai konteks `app.subscription_reconciler = 'on'`
  (migration 015). Policy-nya hanya `SELECT` pada `tenants` dan
  `subscriptions`; perubahan status + audit tetap dijalankan dalam transaksi
  `app.tenant_id` tenant masing-masing.
