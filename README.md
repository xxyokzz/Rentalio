# Rentalio — Backend & Database

Monorepo platform rental multi-tenant. Fase ini mencakup **backend (NestJS)**
dan **database (PostgreSQL + Prisma)**: skema, migrasi dari nol, serta
penegakan di tingkat database (RLS, exclusion constraint anti double-booking,
append-only trigger).

```
rentalio/
├── apps/api/        # NestJS — auth, tenant, katalog/inventaris, return & inspeksi
├── apps/web/        # Next.js — shell desktop & mobile, PWA, katalog publik, portal
├── database/        # Prisma schema, migrasi, seed, dan SQL khusus PostgreSQL
├── docs/            # kontrak OpenAPI (sumber tunggal) + runbook
├── scripts/         # validasi kontrak OpenAPI, actionlint, ops
└── pnpm-workspace.yaml
```

## Prasyarat

| Komponen | Versi | Catatan |
| --- | --- | --- |
| Node.js | 26.13.0 | lihat `.node-version` |
| pnpm | 12.18.0 | `packageManager` di `package.json` |
| PostgreSQL | 18.4 | server lokal, tanpa Docker |

Aktifkan Corepack agar pnpm versi benar terpakai:

```bash
corepack enable
corepack prepare --activate
```

## Menyiapkan database (sekali saja)

Backend sengaja memakai **dua role terpisah** dengan privilese minimal,
bukan superuser, sesuai dokumen 03 & 10:

- `sewain_migrator` — hanya untuk menjalankan migrasi (`CREATE`, DDL).
- `sewain_dev` — role runtime aplikasi; **non-superuser, non-BYPASSRLS**.

Buat role dan database lewat sesi superuser (`psql` sebagai `postgres`):

```sql
-- Role migrator (untuk `prisma migrate`)
CREATE ROLE sewain_migrator LOGIN;

-- Role runtime (dipakai aplikasi; tanpa CREATEDB/CREATEROLE)
CREATE ROLE sewain_dev LOGIN;

-- Database development (milik migrator, UTF8)
CREATE DATABASE sewain_dev OWNER sewain_migrator ENCODING 'UTF8';

-- Database test (terpisah dari development)
CREATE DATABASE sewain_test OWNER sewain_migrator ENCODING 'UTF8';

-- Shadow database untuk `prisma migrate dev` (hak minimal di role migrator)
CREATE DATABASE sewain_shadow OWNER sewain_migrator ENCODING 'UTF8';

-- Kembalikan privilese agar role runtime tidak perlu CREATEDB global
ALTER ROLE sewain_dev CREATEDB;  -- hanya untuk shadow db milik migrator bila perlu
```

> Catatan Windows: gunakan `psql.exe` dari instalasi PostgreSQL Anda, misalnya
> `C:\Program Files\PostgreSQL\18\bin\psql.exe`. Bisa juga lewat DBngin.

Jika autentikasi `localhost` memakai `scram-sha-256`, set password untuk kedua
role, lalu sesuaikan `DATABASE_URL` di `.env`. Lingkungan pengembangan ini
memakai `trust` untuk localhost sehingga tanpa password.

## Konfigurasi environment

Salin template lalu isi nilainya:

```bash
cp .env.example .env        # Linux / macOS
copy .env.example .env      # Windows (cmd)
```

Isi minimum yang wajib (lihat `.env.example` untuk penjelasan tiap variabel):

```bash
DATABASE_URL=postgresql://sewain_dev@localhost:5432/sewain_dev?schema=public
HMAC_PEPPER=<minimal 32 karakter>
```

Hasilkan pepper acak:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Variabel yang divalidasi saat startup (`apps/api/src/config/env.validation.ts`):

| Variabel | Wajib | Default | Keterangan |
| --- | --- | --- | --- |
| `DATABASE_URL` | ya | — | koneksi runtime (`sewain_dev`) |
| `HMAC_PEPPER` | ya | — | minimal 32 karakter; hash OTP/token |
| `NODE_ENV` | tidak | `development` | `development\|test\|production` |
| `PORT` | tidak | `3000` | integer 1–65535 |
| `CORS_ORIGINS` | tidak | `http://localhost:3001` | allowlist, pisahkan koma |
| `APP_BASE_URL` | tidak | `http://localhost:3001` | basis tautan reset password & penerimaan undangan staf |
| `COOKIE_SECURE` | tidak | `false` (`true` di production) | butuh TLS |
| `EMAIL_PROVIDER` | tidak | `dev-file` (`in-memory` di test) | `dev-file`/`in-memory` dilarang di production; production wajib `resend` |
| `RESEND_API_KEY` | ya bila `EMAIL_PROVIDER=resend` | — | API key Resend; server-side saja |
| `EMAIL_FROM` | tidak | `Rentalio <onboarding@resend.dev>` | production wajib domain terverifikasi |
| `RESEND_OTP_TEMPLATE` | tidak | `verifrentalio-resend` | nama/alias template Resend untuk OTP; kosong = teks polos |
| `RATE_LIMIT_SCALE` | tidak | `1` | pengali batas rate limit |
| `PLATFORM_ADMIN_BASE_URL` | tidak | `http://localhost:3002` | origin aplikasi Admin Platform; wajib HTTPS di production |
| `PLATFORM_ADMIN_ENCRYPTION_KEY` | ya di production | — | base64 dari 32 byte; enkripsi secret TOTP admin (terpisah dari `HMAC_PEPPER`) |
| `PLATFORM_QRIS_STATIC_PAYLOAD` | tidak | — | payload QRIS statis merchant Rentalio; kosong = pembayaran langganan dinonaktifkan |
| `SUBSCRIPTION_INVOICE_DURATION_SECONDS` | tidak | `86400` | masa berlaku tagihan QRIS sebelum tagihan lama ditutup |
| `SUBSCRIPTION_PRICE_AMOUNT` | tidak | `0` | harga langganan per periode (IDR utuh); `0` = belum diatur → tagihan ditolak `503` |
| `SUBSCRIPTION_PERIOD_DAYS` | tidak | `30` | panjang periode yang ditambahkan setelah pembayaran lunas |
| `PLATFORM_OPERATOR_EMAIL` | tidak | — | alamat operator penerima pengingat tagihan; kosong = pengingat dinonaktifkan |
| `BILLING_REMINDER_ENABLED` | tidak | `false` (`true` di proses worker) | job pengingat tagihan `PENDING`; hanya di `WorkerModule` |
| `BILLING_REMINDER_INTERVAL_MS` | tidak | `300000` | interval putaran pengingat |
| `BILLING_REMINDER_BATCH_SIZE` | tidak | `50` | jumlah tagihan yang diperiksa per putaran |
| `BILLING_REMINDER_MIN_AGE_SECONDS` | tidak | `600` | umur minimum tagihan sebelum pengingat pertama |
| `BILLING_REMINDER_EXPIRY_WINDOW_SECONDS` | tidak | `3600` | sisa waktu ke `expiresAt` yang memicu pengingat kedua |

Variabel yang hilang atau tidak valid membuat startup **gagal jelas** tanpa
mencetak nilai secret.

> Penting: `dotenv` tidak menimpa variabel yang sudah ada di lingkungan shell.
> Bila shell Anda membawa `PORT=0`, `PORT` di `.env` akan diabaikan. Hapus atau
> timpa nilai lingkungan tersebut sebelum menjalankan server.

## Email transaksional (Resend)

Semua pengiriman email melewati satu modul adapter (`apps/api/src/email/`);
modul domain tidak memanggil SDK Resend langsung (keputusan Notion 12 & 06).

| `EMAIL_PROVIDER` | Adapter | Catatan |
| --- | --- | --- |
| `in-memory` | `InMemoryEmailAdapter` | test otomatis; OTP dibaca dari memori |
| `dev-file` | `DevFileEmailAdapter` | development; tulis ke `.dev-mailbox/outbox.jsonl` |
| `resend` | `ResendEmailAdapter` | wajib di production |

- `RESEND_API_KEY` wajib bila provider `resend`; validasi startup gagal cepat
  tanpa mencetak nilainya.
- Di production hanya `resend` yang diizinkan — `dev-file`/`in-memory` ditolak.
- `EMAIL_FROM` default `Rentalio <onboarding@resend.dev>` (pengirim uji Resend).
  **Belum siap produksi**: domain pengirim belum diverifikasi, SPF/DKIM/DMARC
  belum dikonfigurasi, dan pengiriman nyata belum diuji.
- Kegagalan provider diubah menjadi error yang tidak memuat isi email/OTP.
- Undangan staf mengirim tautan `…/invitations/accept?token=…` (token hash-only,
  7 hari, sekali pakai). Email dikirim **setelah** transaksi undangan commit;
  bila pengiriman gagal, undangan tetap tersimpan, audit
  `MEMBER_INVITE_EMAIL_FAILED` dicatat, dan respons berisi
  `emailDelivered: false`.

### Template OTP Resend

Email OTP memakai template Resend yang sudah dipublikasikan di akun, bukan teks
polos: `RESEND_OTP_TEMPLATE` (default `verifrentalio-resend`). Adapter mengirim
`template.id` = nama/alias template plus variabel `user_name`, `otp_code`, dan
`otp_expiry_minutes`; subjek dikirim aplikasi (`Kode verifikasi Rentalio`)
karena template boleh tidak punya subjek. Template wajib berstatus `published`
— template `draft` ditolak Resend. Isi variabel kosongkan `RESEND_OTP_TEMPLATE`
untuk kembali ke teks polos (dev/test tetap memakai body polos).

Test e2e sungguhan (memanggil API Resend, penerima uji `delivered@resend.dev`):

```bash
RESEND_E2E=1 pnpm --filter @rentalio/api test:e2e:resend
```

Tanpa `RESEND_E2E=1` suite itu dilewati, sehingga `pnpm test` tetap offline.

## Deploy (Supabase + Vercel)

Panduan lengkap: [`docs/deploy-supabase-vercel.md`](docs/deploy-supabase-vercel.md).
Checklist rilis: [`docs/deploy-production-checklist.md`](docs/deploy-production-checklist.md).

Ringkas: database di Supabase (runtime `sewain_dev` lewat transaction pooler,
migrasi `sewain_migrator` lewat session pooler), aplikasi di Vercel sebagai tiga
project (`apps/api`, `apps/web`, `apps/admin`). Worker periodik dijalankan
lewat endpoint cron `/api/v1/internal/cron` yang dilindungi `CRON_SECRET`.
Repo tidak mendaftarkan `crons` karena target Vercel Hobby; panggil endpoint
dari scheduler eksternal atau jalankan worker terpisah. Cron per menit di
`vercel.json` hanya untuk Vercel Pro.

Release production memakai workflow manual
`.github/workflows/deploy-production.yml`: backup Supabase, migrasi, lalu
trigger Deploy Hook Vercel. Auto-deploy branch production dimatikan di
`vercel.json` agar build tidak mendahului migrasi.

## Menjalankan migrasi

```bash
pnpm db:migrate        # prisma migrate deploy (development)
pnpm db:migrate:dev    # prisma migrate dev (butuh shadow database)
pnpm db:generate       # regenerate Prisma client
```

Migrasi dijalankan dengan role migrator, bukan role runtime:

```bash
DATABASE_URL=postgresql://sewain_migrator@localhost:5432/sewain_dev \
  pnpm db:migrate
```

Tiga puluh dua migrasi (dijalankan berurutan dari database kosong):

1. `20261014181659_init` — tabel dari schema Prisma.
2. `20261015011000_rls_constraints_triggers` — SQL khusus PostgreSQL
   (`database/sql/rls_and_constraints.sql`): extension `btree_gist`,
   exclusion constraint anti double-booking, CHECK constraints,
   append-only trigger, RLS, dan GRANT privilege minimal.
3. `20261015030000_return_inspection` — `return_records`, `return_items`,
   `inspections`, `inspection_attachments` + RLS-nya.
4. `20261018201500_user_owner_tenant_fields` — kolom profil owner/tenant
   pada `users` yang sebelumnya belum ada di database (menyebabkan
   registrasi 500).
5. `20261018210000_rls_nullif_tenant_setting` — policy RLS memakai
   `NULLIF(current_setting('app.tenant_id', true), '')` agar benar-benar
   fail-closed (tanpa `NULLIF`, koneksi pool yang pernah di-set mengembalikan
   string kosong dan `''::uuid` melempar error 500).
6. `20261018211500_rls_actor_self_membership` — policy permissive untuk
   aktor (`app.user_id`), dipakai `GET /tenants` agar bisa membaca membership
   miliknya sebelum tenant context diketahui.
7. `20261019140000_invitation_acceptance_idempotency_rls` — RLS
   `FORCE` pada `idempotency_records`, serta policy token-bound pada
   `tenant_member_invitations` (`app.invitation_token_hash`) agar
   `POST /auth/invitations/accept` dapat menemukan undangan sebelum tenant
   context diketahui.
8. `20261019160000_outbox_events_rls` — RLS `FORCE` pada `outbox_events`
   (satu-satunya tabel ber-`tenantId` yang sebelumnya belum dilindungi),
   dengan policy tenant-only dan perilaku fail-closed.
9. `20261019170000_outbox_worker_system_policy` — kolom retry/dead-letter
   (`nextAttemptAt`, `deadLetteredAt`) dan policy `SELECT`/`UPDATE` khusus
   worker dengan konteks `app.outbox_system`.
10. `20261019190000_order_payment_deposit` — kolom `method`/`reference` pada
    `deposit_movements`, tabel `deposit_deduction_requests` (pengajuan dan
    approval potongan dua langkah) + RLS, serta unique `(tenantId, reversesId)`
    agar satu movement hanya dapat dibalik sekali.
11. `20261019230000_refund_workflow` — kolom keputusan/hasil pada `refunds`
    (`reference`, `decisionReason`, `processedByUserId`, `resultNote`), indeks
    `(tenantId, paymentId)` untuk perhitungan refundable, dan CHECK currency
    tidak kosong. Batas kumulatif ditegakkan service di bawah row lock payment.
12. `20261019234500_payment_method_settings` — enum `PaymentContext`, tabel
    `tenant_payment_method_settings` (unique tenant+konteks+metode, RLS), dan
    kolom snapshot `payments.context`. Baris yang belum ada berarti aktif,
    sehingga tenant lama tidak memerlukan backfill.
13. `20261020000000_whatsapp_templates` — `whatsapp_templates` +
    `whatsapp_template_versions` (unique tenant+konteks+metode+tujuan, RLS),
    plus backfill 9 template bawaan dan versi 1 untuk setiap tenant lama.
14. `20261020120000_transaction_message_snapshots` —
    `transaction_message_snapshots` (body ter-render + versi template, RLS,
    unique parsial per order/metode/tujuan dan per payment). Snapshot tetap
    utuh bila template dihapus karena `templateId` sengaja tanpa FK.
15. `20261020130000_subscription_reconciler_system_policy` — policy baca
    khusus reconciler (`app.subscription_reconciler`, SELECT saja) untuk
    menemukan trial/grace yang berakhir tanpa membuka penulisan lintas tenant.
16. `20261020140000_extension_conflict_override` — `order_extensions`,
    `extension_overrides`, `extension_conflicts` (RLS), kolom
    `reservation_allocations.extensionId/overrideId`, flag
    `hasOpenConflict` pada order/reservasi, serta trigger PostgreSQL
    sadar-override yang menggantikan sebagian exclusion constraint.
17. `20261020160000_extension_conflict_resolution` — kolom jejak penyelesaian
    (`resolvedAt`, `resolvedByUserId`, `resolutionNote`) dan index pencarian
    konflik per order/reservasi untuk menghitung ulang `hasOpenConflict`.
18. `20261020150000_audit_logs_force_rls` — RLS `FORCE` pada `audit_logs`
    (tabel tenant-scoped terakhir yang masih bisa dilewati pemilik tabel),
    sehingga fail-closed berlaku juga bagi role migrator.
19. `20261021090000_public_guest_booking` — katalog publik, booking tamu, dan
    portal pesanan: kontak publik tenant (WhatsApp, instruksi transfer, QRIS),
    bukti persetujuan ketentuan pada reservasi tamu, serta tabel token portal
    (hash-only, dapat dicabut/kedaluwarsa) + RLS-nya.
20. `20261022090000_public_tenant_domain_resolution` — policy `SELECT`
    token-bound (`app.public_hostname`) pada `tenant_domains` agar hostname
    dapat dipetakan ke tenant **sebelum** `app.tenant_id` diketahui.
21. `20261022100000_add_collateral_jaminan` — jaminan non-uang penyewa per
    order (`ID_CARD` maksimal satu `HELD`, `OTHER` boleh banyak). Uang tetap
    memakai ledger deposit; baris bersifat riwayat (tidak pernah dihapus).
22. `20261027100000_catalog_config` — konfigurasi presentasi katalog (WEB-07):
    tema, branding, dan susunan blok per tenant dengan siklus
    `DRAFT`/`PUBLISHED`/`ARCHIVED` serta partial unique index “satu draf + satu
    published” per tenant; allowlist komponen divalidasi backend.
23. `20261027130000_default_platform_plan` — memasang plan platform default
    (`code='free'`, harga 0) yang dicari `TenantService.createTenant` untuk
    membuat subscription `TRIALING`. Tanpa baris ini — dan karena
    `subscriptions.planId` NOT NULL — subscription tidak pernah dibuat pada
    database bersih. Idempoten (`WHERE NOT EXISTS`).
24. `20261028090000_user_legal_consent` — bukti persetujuan legal saat
    registrasi OWNER (dokumen 04): `users.termsConsentVersion`,
    `users.privacyConsentVersion`, dan `users.legalConsentAt` (timestamp
    server). Nullable agar baris lama tetap sah; registrasi baru selalu
    mengisi ketiganya.
25. `20261028100000_platform_admin_identity` — fondasi Admin Platform
    (PLAT-01): sembilan tabel `platform_*` (admin users, roles, permissions,
    assignment role, role permissions, login challenge, sessions, recovery
    codes, dan `platform_audit_events` append-only via trigger) plus seed role
    matrix + permission di migrasi itu sendiri, sehingga otorisasi runtime
    membaca baris database — bukan daftar hardcode di kode.
26. `20261029100000_platform_admin_tenant_directory` — policy RLS **SELECT
    saja** (`tenants_platform_admin_directory`) pada `tenants` untuk konteks
    `app.platform_admin` yang diset transaction-scoped oleh
    `PrismaService.withPlatformAdmin`; tabel tenant-scoped lain tetap tertutup.
27. `20261029110000_platform_admin_tenant_status` — policy UPDATE
    (`tenants_platform_admin_status_update`) + trigger
    `platform_admin_tenant_status_only()` yang menolak perubahan kolom selain
    `status`/`updatedAt`, sehingga jalur suspend/reactivate admin tidak bisa
    mengubah nama, slug, atau kolom lain.
28. `20261031090000_subscription_billing` — tabel `subscription_invoices`
    (satu tagihan `PENDING` per tenant lewat partial unique index) + RLS-nya.
    Kolom provider/id eksternal diisi oleh gateway saat itu.
29. `20261102090000_subscription_billing_qris` — billing pindah ke QRIS
    dinamis: kolom `qrPayload` ditambahkan, kolom `invoiceUrl` dan
    `providerInvoiceId` dihapus, default provider menjadi `qris`, policy baca
    lintas tenant `app.billing_system` dihapus (tidak ada lagi webhook), dan
    permission `platform.subscriptions.settle` di-seed untuk Super Admin +
    Billing.
30. `20261102110000_subscription_invoice_reminders` — kolom
    `operatorNotifiedAt`/`expiryNotifiedAt` pada `subscription_invoices`
    (penanda idempoten pengingat email) + index parsial untuk baris `PENDING`,
    serta policy baca lintas tenant `app.billing_reminder` (SELECT saja) yang
    dipakai job pengingat.
31. `20261102130000_platform_audit_actor_no_fk` — melepas FK
    `platform_audit_events.actorAdminId`. Tabel audit bersifat append-only
    (trigger menolak UPDATE/DELETE), sehingga `ON DELETE SET NULL` pada FK
    membuat penghapusan admin gagal `P0001`. Jejak audit kini tetap utuh tanpa
    FK, dan akun admin dapat dibersihkan secara operasional.
32. `20261105090000_cron_runs` — tabel `cron_runs` (platform-level, tanpa
    tenant) untuk riwayat eksekusi cron Vercel: status
    `SUCCEEDED`/`PARTIAL`/`FAILED`, hasil per job, durasi, dan waktu alert.
    Dipakai endpoint status dan alerting; retensi 14 hari.

### Penegakan di tingkat database

Bagian ini penting karena menjadi *defense-in-depth* di luar aplikasi:

- **Anti double-booking** — exclusion constraint GiST pada
  `reservation_allocations`: dua baris `ACTIVE` non-override pada `assetId`
  sama tidak boleh tumpang tindih. Rentang memakai `tsrange` half-open
  `[start, end)` (kolom `DateTime` Prisma = `timestamp` tanpa zona, sehingga
  `tstzrange` tidak bisa dipakai: konversinya STABLE, bukan IMMUTABLE).
- **Override konflik Opsi B** — trigger `reservation_allocation_override_guard`
  menyerialkan mutasi per asset/product dengan advisory lock, lalu menolak
  semua overlap kecuali pasangan yang tercatat di `extension_conflicts` untuk
  extension `APPROVED` ber-override. Alokasi override juga tidak boleh
  bertumpuk dengan alokasi override lain, sehingga dua override paralel tidak
  dapat saling melegitimasi. Pelanggaran memakai kode `23P01` → 409
  `AVAILABILITY_CONFLICT`. Untuk stok kuantitas, trigger menghitung pemakaian
  puncak sepanjang rentang; kapasitas tidak boleh terlampaui tanpa override
  yang mencatat seluruh alokasi terdampak.
- **Append-only** — trigger `BEFORE UPDATE OR DELETE` pada `deposit_movements`
  dan `audit_logs` melempar exception. Koreksi hanya lewat reversal/void (ADR-001).
- **Row Level Security** — diaktifkan + `FORCE` pada tabel tenant-scoped.
  Context di-set per transaksi via `set_config('app.tenant_id', ..., true)`
  (`PrismaService.withTenant`). **Fail-closed**: policy memakai
  `NULLIF(current_setting(..., true), '')::uuid` sehingga tanpa context query
  mengembalikan nol baris, bukan error.
- **Operasi lintas tenant milik aktor** (`GET /tenants`) memakai
  `PrismaService.withActor` yang men-set `app.user_id`; policy actor hanya
  membuka baris membership/tenant milik aktor tersebut. Penulisan tetap wajib
  memakai `app.tenant_id`.
- Karena `FORCE RLS` juga menahan INSERT, pembuatan tenant baru meng-generate
  `id` di klien lalu men-set konteks tenant tersebut sebelum insert.
- **Penerimaan undangan** memakai konteks `app.invitation_token_hash`
  (`PrismaService.withInvitationToken`). Policy hanya membuka baris yang hash
  tokennya persis sama, sehingga undangan dapat dibaca sebelum `tenantId`
  diketahui tanpa membuka akses lintas tenant. Setelah `tenantId` terbaca,
  transaksi yang sama menyetel `app.tenant_id` untuk membership + audit.
- **`idempotency_records`** memakai RLS yang sama; replay hasil request hanya
  dapat dibaca dengan konteks tenant yang cocok.
- **`outbox_events`** juga memakai RLS tenant-only. Baris platform
  (`tenantId NULL`) tidak terlihat dari konteks tenant mana pun. Worker memakai
  konteks `app.outbox_system` (policy `SELECT`/`UPDATE` migration 009), bukan
  melonggarkan policy tenant; worker tidak boleh INSERT.
- **Reconciler subscription** memakai konteks `app.subscription_reconciler`
  (policy `SELECT` saja, migration 015) untuk menemukan tenant yang trial/grace-nya
  sudah berakhir. Transisi status dan audit tetap dijalankan di transaksi
  `app.tenant_id` masing-masing tenant, sehingga tidak ada penulisan lintas
  tenant.

### Worker outbox

`OutboxWorkerService` memproses `outbox_events` dengan semantik
**at-least-once**:

- Klaim batch memakai `FOR UPDATE SKIP LOCKED` + lease di `nextAttemptAt`,
  sehingga dua worker tidak memproses event yang sama. Bila proses mati,
  lease kedaluwarsa dan event dapat diklaim worker lain.
- Handler menerima payload domain; event tanpa handler dianggap gagal.
- Gagal → `retryCount` bertambah, `lastError` disimpan, dan `nextAttemptAt`
  dijadwalkan dengan backoff eksponensial. Setelah `OUTBOX_MAX_ATTEMPTS`,
  event masuk dead-letter (`deadLetteredAt`) dan tidak diklaim lagi.
- Handler wajib idempoten: crash setelah efek eksternal tetapi sebelum
  `publishedAt` tersimpan dapat menyebabkan pengiriman ulang.

Aktif hanya bila `OUTBOX_WORKER_ENABLED=true`. Konfigurasi lain:
`OUTBOX_POLL_INTERVAL_MS`, `OUTBOX_BATCH_SIZE`, `OUTBOX_MAX_ATTEMPTS`,
`OUTBOX_LEASE_MS`, `OUTBOX_BACKOFF_BASE_MS`, `OUTBOX_BACKOFF_MAX_MS`
(lihat `.env.example`).

### Proses worker terpisah

Job periodik **tidak berjalan di proses API**. `AppModule` hanya memuat
policy/guard subscription dan tidak menyediakan `OutboxWorkerService`,
`SubscriptionReconcilerService`, maupun `BillingReminderService`, sehingga API
tetap stateless dan aman diskalakan. Ketiga job hidup di `WorkerModule` (tanpa
controller HTTP):

```bash
pnpm api:dev              # proses API (HTTP)
pnpm --filter @rentalio/api worker          # proses worker (node --watch dist/worker.js)
pnpm --filter @rentalio/api start:worker    # proses worker dari dist
```

Proses worker menyalakan ketiga job secara default (`OUTBOX_WORKER_ENABLED`,
`SUBSCRIPTION_RECONCILER_ENABLED`, dan `BILLING_REMINDER_ENABLED` di-set `true`
bila belum ada di environment). Operator tetap dapat mematikan salah satunya
lewat env. Karena klaim outbox memakai `SKIP LOCKED` + lease, reconciler
subscription mengunci baris subscription, dan pengingat tagihan mengklaim kolom
penanda secara bersyarat, beberapa replika worker aman berjalan paralel.

## Menjalankan aplikasi

```bash
pnpm install           # sekali saja
pnpm build             # build semua package
pnpm api:dev           # server dev (tsc watch + node --watch dist/main.js)
pnpm --filter @rentalio/api start   # jalankan build dist/main.js
pnpm --filter @rentalio/api worker  # proses worker (outbox + reconciler)
```

Server mendengarkan `http://localhost:3000` dengan prefix `/api/v1`.

### Health check

```bash
curl http://localhost:3000/api/v1/health        # liveness → { "status": "ok" }
curl http://localhost:3000/api/v1/health/ready  # readiness → cek database
```

## Endpoint yang tersedia

### Auth (`/api/v1/auth`)

| Method | Path | Keterangan |
|--------|------|------------|
| POST | `/auth/registrations` | Daftar OWNER — kirim OTP email; profil opsional (`ownerName`, `tenantName`, `tenantSlug`) untuk prefill onboarding |
| POST | `/auth/registrations/verify-email` | Verifikasi kode OTP |
| POST | `/auth/registrations/resend-otp` | Kirim ulang OTP |
| POST | `/auth/sessions` | Login — rotasi session ID, Set-Cookie |
| GET | `/auth/sessions/current` | Sesi aktif + profil pendaftaran (prefill onboarding) |
| DELETE | `/auth/sessions/current` | Logout (wajib X-CSRF-Token) |
| GET | `/auth/csrf` | Terbitkan token CSRF baru untuk sesi aktif (token lama batal) |
| POST | `/auth/password-resets` | Minta tautan reset |
| POST | `/auth/password-resets/complete` | Selesaikan reset — cabut semua sesi |
| POST | `/auth/invitations/accept` | Terima undangan staf — tukar token sekali pakai menjadi akun + membership |

> **Catatan path:** Implementasi menggunakan konvensi RESTful resource-oriented
> (`/registrations`, `/sessions`). Path konseptual di Notion 04 (`/owner-signup`, `/login`)
> adalah nama fungsional awal; OpenAPI YAML final adalah sumber kebenaran tunggal.

### Admin Platform (`/api/v1/platform-admin`)

Identitas admin **terpisah total** dari user/membership tenant: tabel
`platform_*`, cookie `rentalio_platform_admin` (HttpOnly, host-only), dan
permission `platform.*` yang dimuat backend dari role assignment. Cookie tenant
(`rentalio_session`) tidak pernah diterima sebagai bukti identitas admin, begitu
pula sebaliknya. RBAC bersifat deny-by-default: handler tanpa deklarasi
permission ditolak.

| Method | Path | Keterangan |
|--------|------|------------|
| POST | `/platform-admin/auth/login` | Tahap 1: password → challenge MFA (5 menit) |
| POST | `/platform-admin/auth/mfa` | Tahap 2: TOTP 6 digit → sesi + kode pemulihan (saat enrollment) |
| POST | `/platform-admin/auth/recovery` | Login dengan kode pemulihan sekali pakai |
| GET | `/platform-admin/session` | Principal, role, dan permission efektif |
| GET | `/platform-admin/csrf` | Terbitkan token CSRF baru (header `X-Platform-Admin-CSRF`) |
| GET | `/platform-admin/tenants` | Direktori tenant (`platform.tenants.list`) — metadata minimum, setiap halaman diaudit |
| GET | `/platform-admin/tenants/:id` | Ringkasan satu tenant (`platform.tenants.read_summary`) — percobaan gagal juga diaudit |
| POST | `/platform-admin/tenants/:id/suspend` | Suspend (`platform.tenants.suspend`) — wajib alasan, CSRF admin, audit |
| POST | `/platform-admin/tenants/:id/reactivate` | Reactivate (`platform.tenants.reactivate`) — wajib alasan, CSRF admin, audit |
| GET | `/platform-admin/audit-events` | Audit viewer (`platform.audit.read`) — filter aktor/aksi/rentang waktu |
| GET | `/platform-admin/admins` | Daftar admin (`platform.roles.read`) — role aktif per admin, setiap halaman diaudit |
| GET | `/platform-admin/admins/:id` | Detail admin (`platform.roles.read`) — role aktif + permission efektif, percobaan gagal diaudit |
| POST | `/platform-admin/admins/:id/roles/assign` | Assign role (`platform.roles.assign`) — wajib alasan, CSRF admin, audit |
| POST | `/platform-admin/admins/:id/roles/revoke` | Revoke role (`platform.roles.revoke`) — permission terpisah, audit |
| POST | `/platform-admin/tenants/:id/subscription-invoices/:invoiceId/settle` | Tandai tagihan QRIS lunas (`platform.subscriptions.settle`) — wajib referensi, CSRF admin, audit |
| DELETE | `/platform-admin/session` | Logout (wajib CSRF + Origin admin yang persis) |

Direktori tenant membaca lintas tenant lewat konteks database
`app.platform_admin` (`PrismaService.withPlatformAdmin`). Policy migrasi
`20261029100000_platform_admin_tenant_directory` hanya membuka **SELECT** pada
`tenants`; data anggota, katalog, order, dan pembayaran tetap tertutup RLS, dan
setiap pembacaan halaman menulis `PLATFORM_TENANT_DIRECTORY_VIEWED` ke
`platform_audit_events` di transaksi yang sama (filter + jumlah baris, tanpa
query pencarian mentah).

`GET /platform-admin/tenants/:id` memakai permission terpisah
`platform.tenants.read_summary` dan mencatat `PLATFORM_TENANT_SUMMARY_VIEWED`
untuk pembacaan sukses maupun gagal (`outcome: FAILED`, `metadata.found=false`).
Id yang bukan UUID dijawab `400 VALIDATION_ERROR` sebelum menyentuh kolom
`uuid`, sehingga tidak ada error driver yang bocor sebagai 500.

Aksi status tenant (`suspend`/`reactivate`) memakai permission terpisah,
wajib `reason` 10–500 karakter + CSRF admin + Origin admin, dan hanya
mengizinkan transisi `ACTIVE`/`PENDING_ACTIVATION → SUSPENDED` serta
`SUSPENDED → ACTIVE` (`CLOSED` final, selain itu `409`). Migrasi
`20261029110000_platform_admin_tenant_status` menambah policy UPDATE untuk
konteks `app.platform_admin` sekaligus trigger yang menolak perubahan kolom
selain `status`/`updatedAt`, sehingga jalur admin tidak bisa dipakai mengubah
nama, slug, atau kolom lain. Setiap percobaan (sukses maupun ditolak) menulis
`PLATFORM_TENANT_SUSPENDED`/`PLATFORM_TENANT_REACTIVATED` dengan alasan,
`fromStatus`, `toStatus`, atau `metadata.denial`.

Audit viewer `GET /platform-admin/audit-events` membaca tabel append-only
tersebut dengan filter `actorAdminId`, `action` (allowlist aksi yang dikenal),
dan rentang `from`/`to` inklusif, diurutkan terbaru lebih dulu dengan `id`
sebagai tiebreaker. Membaca log audit **tidak** menulis event baru — pembacaan
yang menulis log akan menumbuhkan log tanpa batas dan membuka jalan log
flooding; aksesnya tetap dibatasi permission `platform.audit.read` + sesi admin
terverifikasi MFA + `Cache-Control: no-store`.

Penugasan role admin (`assign`/`revoke`) memakai dua permission terpisah
`platform.roles.assign` dan `platform.roles.revoke`, wajib `reason` 10–500
karakter, plus CSRF + Origin admin. `roleCode` divalidasi terhadap tabel
`platform_roles` (admin/role tak dikenal → `404`, id bukan UUID → `400`),
assignment yang sudah aktif → `409`, dan revoke menyimpan `revokedAt` tanpa
menghapus baris. Unique `(adminUserId, roleId)` membuat assign ulang setelah
revoke menghidupkan kembali baris yang sama, dan mutasi + audit berada dalam
satu transaksi sehingga percobaan gagal pun tercatat `PLATFORM_ADMIN_ROLE_ASSIGNED`/
`PLATFORM_ADMIN_ROLE_REVOKED` dengan `metadata.denial`. Karena permission
efektif dihitung ulang dari database setiap permintaan sesi, perubahan role
langsung terasa pada request berikutnya.

Direktori admin (`GET /platform-admin/admins` dan `/admins/:id`) memakai
permission terpisah `platform.roles.read`: daftar menampilkan identitas
minimal (email, status, jejak MFA/login) beserta penugasan role yang masih
aktif — hash password dan secret TOTP tidak pernah ikut — dan setiap halaman
menulis `PLATFORM_ADMIN_DIRECTORY_VIEWED` ke audit di transaksi yang sama
(query pencarian tidak disimpan mentah). Detail menambahkan permission
efektif hasil gabungan role aktif dan mencatat `PLATFORM_ADMIN_DETAIL_VIEWED`
untuk pembacaan sukses maupun gagal (`outcome: FAILED`), sehingga pencarian
id sembarangan tetap meninggalkan jejak.

Proteksi anti-lockout berlaku di dalam transaksi assign/revoke yang sama dan
ditolak `422 BUSINESS_RULE_VIOLATION`: admin tidak boleh menugaskan role ke
diri sendiri (denial `SELF_ASSIGNMENT` — mencegah eskalasi privilese mandiri),
dan penugasan `PLATFORM_SUPER_ADMIN` terakhir tidak dapat dicabut (denial
`LAST_SUPER_ADMIN`). Pemeriksaan terakhir memakai `SELECT … FOR UPDATE` pada
baris super admin aktif (urut `id` agar bebas deadlock), sehingga dua
pencabutan bersamaan diserialisasi dan jumlah super admin tidak pernah jatuh
ke nol. Keduanya tetap tercatat di audit dengan `outcome: FAILED` beserta
alasan.

Membuat Super Admin pertama (hanya lewat shell server, bukan HTTP):

```bash
pnpm --filter @rentalio/api admin:bootstrap
```

Perintah ini interaktif (email, password diketik dua kali tanpa echo, konfirmasi
`BOOTSTRAP`) dan hanya berhasil bila belum ada satu pun admin platform. Login
pertama meminta enrollment TOTP sebelum sesi diterbitkan.

Untuk development ada jalur cepat non-interaktif dan idempoten:

```bash
pnpm --filter @rentalio/api admin:seed
```

Seed ini membuat/menyelaraskan akun `admin@rentalio.my.id` dengan password
`admlogin123` dan role `PLATFORM_SUPER_ADMIN`, mencatat
`PLATFORM_ADMIN_BOOTSTRAPPED`, dan **menolak berjalan saat `NODE_ENV=production`**.
Password default (11 karakter) sengaja di bawah kebijakan 12–128, jadi hanya
untuk lokal; override lewat `PLATFORM_ADMIN_DEFAULT_EMAIL` /
`PLATFORM_ADMIN_DEFAULT_PASSWORD`, dan pakai `admin:bootstrap` untuk akun
sungguhan.

> Aplikasi admin memanggil API ini lewat **proxy same-origin** agar cookie tetap
> host-only untuk origin admin. Origin tunggal yang sah untuk mutasi ditentukan
> `PLATFORM_ADMIN_BASE_URL`.

### Tenant (`/api/v1/tenants`)

| Method | Path | Akses | Keterangan |
|--------|------|-------|------------|
| GET | `/tenants` | Semua member | Daftar tenant actor |
| POST | `/tenants` | Terautentikasi | Buat tenant baru (actor menjadi OWNER) |
| GET | `/tenants/:id` | Member aktif | Detail + pengaturan tenant |
| PATCH | `/tenants/:id/settings` | OWNER | Ubah bookingMode, catalogPolicy, dll |
| GET | `/tenants/:id/members` | OWNER | Daftar member |
| POST | `/tenants/:id/members` | OWNER | Undang staf — kirim email bertoken (`emailDelivered` di respons) |
| PATCH | `/tenants/:id/members/:userId` | OWNER | Update role/status member |

### Akun & Pelanggan

| Method | Path | Permission | Keterangan |
|--------|------|------------|------------|
| GET | `/me` | session | Profil akun aktif + ringkasan membership (id/slug/nama tenant, role) |
| GET | `/tenants/:tenantId/customers` | `customer.read` | Daftar pelanggan + total; `q` mencari nama/email/nomor, `limit` 1-100, `offset` |
| POST | `/tenants/:tenantId/customers` | `customer.write` | Tambah pelanggan; email lowercase, email/nomor duplikat → 422 + `details.customerId` |

`GET /me` hanya membaca akun milik sesi — tidak ada parameter yang dapat
menunjuk akun lain — dan tidak menulis audit karena tidak ada perubahan state.
Direktori pelanggan selalu tenant-scoped (RLS + membership); pelanggan buatan
staff ber-`isGuest: false`, sedangkan pelanggan booking tamu dibuat alur booking
dengan `isGuest: true`. Permission default: MANAGER/STAFF `customer.read` +
`customer.write`, CASHIER `customer.read`.

### Subscription guard & restricted mode

Satu policy server-side (`SubscriptionPolicyService`) mengevaluasi entitlement
dari tanggal tersimpan: trial berakhir tepat 72 jam setelah `activatedAt`,
renewal gagal mendapat grace 3 hari kalender, lalu tenant masuk restricted mode.
Endpoint yang membuat komitmen baru ditolak `403 TENANT_RESTRICTED`:

- `POST .../reservations`, `POST .../reservations/:id/confirm`
- `POST .../orders`, `POST .../reservations/:id/convert-to-order`
- seluruh mutasi katalog: kategori, produk, tarif, unit/asset, maintenance

Tetap diizinkan sesuai permission: baca data/laporan, pembatalan/penolakan
reservasi, serta penyelesaian order aktif (serah-terima, return/inspection,
pembayaran yang sudah ada, refund, dan ledger deposit). Penanda
`@BlockInRestrictedMode()` dipakai eksplisit per handler agar pengecualian
lifecycle tidak ikut terblokir.

### Reconciler status subscription

`SubscriptionReconcilerService` menjaga kolom `subscriptions.status` tetap
konsisten dengan policy guard. Setiap putaran:

1. Memindai subscription TERBARU per tenant yang trial/grace-nya sudah berakhir
   (batch terbatas, `SUBSCRIPTION_RECONCILE_BATCH_SIZE`).
2. Untuk tiap kandidat, mengunci baris subscription di transaksi tenant,
   mengevaluasi ulang dengan `SubscriptionPolicyService`, lalu mengubah status
   menjadi `RESTRICTED` bila hasilnya memang restricted.
3. Menulis audit `SUBSCRIPTION_RESTRICTED` (`fromState`, `toState`, `reason`,
   serta tanggal trial/grace) di transaksi yang sama, sehingga status dan audit
   tidak pernah terpisah.

`CANCELLED`/`EXPIRED` tidak ditimpa. Job idempoten: putaran berikutnya tidak
menemukan baris yang sudah `RESTRICTED`, dan kegagalan satu tenant tidak
membatalkan tenant lain. Aktif hanya bila
`SUBSCRIPTION_RECONCILER_ENABLED=true`; interval diatur lewat
`SUBSCRIPTION_RECONCILE_INTERVAL_MS` (default 15 menit).

### Billing langganan (QRIS dinamis)

Tenant membayar langganannya ke Rentalio lewat QRIS dinamis:

| Method | Path | Akses | Keterangan |
|--------|------|-------|------------|
| GET | `/api/v1/tenants/:tenantId/subscription-invoices` | `settings.subscription.manage` (OWNER) | 10 tagihan terbaru |
| POST | `/api/v1/tenants/:tenantId/subscription-invoices` | `settings.subscription.manage` (OWNER) + CSRF | buat tagihan (QRIS bernominal), atau kembalikan tagihan `PENDING` yang masih berlaku |
| POST | `/api/v1/platform-admin/tenants/:tenantId/subscription-invoices/:invoiceId/settle` | `platform.subscriptions.settle` + CSRF admin | tandai lunas setelah dana terverifikasi |

QRIS statis merchant Rentalio disimpan di `PLATFORM_QRIS_STATIC_PAYLOAD`.
Untuk setiap tagihan, API mengubahnya menjadi **QRIS dinamis** yang sudah memuat
nominal (tag `54`), menghitung ulang CRC16, lalu mengembalikan payload dan
gambar QR (`qrImageDataUrl`). Konversi memakai port library
[qris-dinamis](https://github.com/verssache/qris-dinamis) (MIT) di
`apps/api/src/billing/qris/`.

Aturan yang dipegang:

1. **Harga bukan hard-code.** `SUBSCRIPTION_PRICE_AMOUNT` adalah konfigurasi
   deployment; bila `0`, endpoint menolak `503 BILLING_NOT_CONFIGURED` alih-alih
   membuat tagihan Rp0. UI lalu menampilkan jalur manual (hubungi tim Rentalio).
2. **Satu tagihan aktif per tenant.** Partial unique index pada status `PENDING`
   membuat klik ganda (atau request paralel) memakai tagihan yang sama, bukan
   membuat dua baris/QR.
3. **Tidak ada konfirmasi otomatis.** QRIS dinamis hanya membawa data, bukan
   status. Status `PAID` **hanya** ditetapkan operator platform lewat Admin
   Platform (`platform.subscriptions.settle`) setelah dana terverifikasi;
   endpoint tenant tidak pernah bisa menandai lunas sendiri. Klaim memakai
   `updateMany` bersyarat status `PENDING`, sehingga dua operator yang menekan
   bersamaan hanya memperpanjang langganan satu kali — percobaan kedua `409`.
4. **Perpanjangan idempoten.** Penyelesaian memindahkan `PENDING` → `PAID`,
   memperpanjang periode dari `max(sekarang, periodEnd)` sebesar
   `SUBSCRIPTION_PERIOD_DAYS`, lalu menulis `subscription_events`
   (`qris`, `${externalId}:PAID`) + audit di transaksi yang sama.
5. **Nominal diterima tidak boleh kurang.** `paidAmount` < nilai tagihan
   ditolak `400`; tagihan tetap `PENDING`.
6. **Percobaan settle gagal tetap diaudit.** Id tidak valid, tagihan tidak
   ditemukan, status bukan `PENDING`, dan balapan klaim semuanya menulis
   `PLATFORM_SUBSCRIPTION_INVOICE_SETTLED` dengan `outcome: FAILED` beserta
   alasan penolakan.

Karena tidak ada provider yang memanggil API, tidak ada webhook dan tidak ada
job rekonsiliasi tagihan. Proses worker hanya menjalankan outbox, reconciler
subscription, dan job pengingat tagihan.

#### Pengingat tagihan ke operator

QRIS tidak memberi tahu apa pun saat dibayar, sehingga tagihan bisa menggantung
tanpa ada yang menyadari. `BillingReminderService` di proses worker menutup celah
itu dengan email ke `PLATFORM_OPERATOR_EMAIL`:

1. **Pengingat pertama** — tagihan `PENDING` yang sudah melewati
   `BILLING_REMINDER_MIN_AGE_SECONDS` (default 10 menit), supaya penyewa diberi
   kesempatan membayar lebih dulu.
2. **Pengingat kedua** — sisa waktu ke `expiresAt` sudah di dalam
   `BILLING_REMINDER_EXPIRY_WINDOW_SECONDS` (default 1 jam).

Isi email: nama/slug tenant, nominal, batas waktu (WIB), dan id tagihan --
cukup untuk mencocokkan mutasi bank. Payload QRIS tidak disertakan.

Sifat yang dipegang:

- **Satu email per tahap per tagihan.** Klaim memakai `UPDATE` bersyarat kolom
  `operatorNotifiedAt`/`expiryNotifiedAt` masih `NULL`, jadi beberapa replika
  worker tidak mengirim ganda.
- **Kegagalan kirim tidak menghilangkan pengingat.** Klaim dikembalikan (`NULL`)
  dan putaran berikutnya mencoba lagi. Konsekuensinya bisa ada email ganda bila
  proses mati setelah provider menerima tetapi sebelum klaim tersimpan —
  notifikasi bersifat *at-least-once*, bukan transaksional.
- **Tidak mengingatkan tagihan yang sudah PAID/EXPIRED**, dan tidak menyentuh
  status tagihan maupun langganan sama sekali. Ini murni notifikasi.
- Scan lintas tenant memakai konteks baca `app.billing_reminder` (SELECT saja,
  migration 030); klaim tetap di `app.tenant_id`.

Job mati bila `PLATFORM_OPERATOR_EMAIL` kosong — worker mencatat peringatan
terakhir maksimal sekali sejam, tanpa mengirim apa pun.

### Reservasi & Ketersediaan (`/api/v1/tenants/:tenantId/...`)

| Method | Path | Akses | Keterangan |
|--------|------|-------|------------|
| GET | `.../availability` | Semua member | Cek ketersediaan produk untuk periode |
| GET | `.../reservations` | Semua member | Daftar reservasi + item + alokasi |
| POST | `.../reservations` | OWNER/MANAGER/STAFF | Buat reservasi (mendukung header `Idempotency-Key`) |
| GET | `.../reservations/:id` | Semua member | Detail reservasi |
| POST | `.../reservations/:id/confirm` | OWNER/MANAGER | PENDING_APPROVAL → CONFIRMED (cek ulang + alokasi atomik) |
| POST | `.../reservations/:id/reject` | OWNER/MANAGER | PENDING_APPROVAL → REJECTED |
| POST | `.../reservations/:id/cancel` | OWNER/MANAGER | Nonterminal → CANCELLED (lepas alokasi) |

`POST .../reservations` menerima `Idempotency-Key` opsional (8–128 karakter).
Request berikutnya dengan key yang sama mengembalikan hasil yang sama tanpa
membuat booking ganda (replay 24 jam); payload berbeda dengan key sama ditolak
`409 IDEMPOTENCY_KEY_REUSED`. Record ditulis di akhir transaksi yang sama,
sehingga request paralel dengan key sama menunggu index unik dan hanya satu
yang membuat reservasi.

### Katalog & Inventaris (`/api/v1/tenants/:tenantId/...`)

| Method | Path | Akses | Keterangan |
|--------|------|-------|------------|
| GET | `.../categories` | Semua member | Daftar kategori |
| POST | `.../categories` | OWNER/MANAGER | Buat kategori |
| PATCH | `.../categories/:id` | OWNER/MANAGER | Update nama kategori |
| DELETE | `.../categories/:id` | OWNER/MANAGER | Hapus (gagal jika ada produk) |
| GET | `.../products` | Semua member | Daftar produk (filter: categoryId, isActive) |
| POST | `.../products` | OWNER/MANAGER | Buat produk |
| GET | `.../products/:id` | Semua member | Detail produk + tarif + jumlah asset |
| PATCH | `.../products/:id` | OWNER/MANAGER | Update produk |
| DELETE | `.../products/:id` | OWNER/MANAGER | Nonaktifkan (soft delete) |
| GET | `.../products/:id/rates` | Semua member | Ambil tarif sewa |
| POST | `.../products/:id/rates` | OWNER/MANAGER | Set/update tarif (upsert, IDR rupiah utuh) |
| GET | `.../products/:id/assets` | Semua member | Daftar unit fisik (INDIVIDUAL_UNITS) |
| POST | `.../products/:id/assets` | OWNER/MANAGER | Tambah unit fisik |
| PATCH | `.../assets/:assetId` | OWNER/MANAGER | Update status/kondisi unit |
| GET | `.../assets/:assetId/maintenance` | OWNER/MANAGER/STAFF | Riwayat maintenance |
| POST | `.../assets/:assetId/maintenance` | OWNER/MANAGER | Catat periode maintenance |

### Order, Pembayaran Manual & Deposit (`/api/v1/tenants/:tenantId/...`)

| Method | Path | Permission | Keterangan |
|--------|------|------------|------------|
| POST | `.../reservations/:id/convert-to-order` | `order.create` | Reservasi CONFIRMED → order (idempoten per reservasi) |
| POST | `.../orders` | `order.create` | Alias konversi (`{ reservationId }`; order langsung belum MVP) |
| GET | `.../orders` | `order.read` | Daftar order + paginasi + filter status |
| GET | `.../orders/:id` | `order.read` | Detail order, pembayaran, saldo/ledger deposit |
| POST | `.../orders/:id/ready-for-handover` | `order.handover` | CONFIRMED → READY_FOR_HANDOVER |
| POST | `.../orders/:id/handover` | `order.handover` | READY_FOR_HANDOVER → ACTIVE (waktu, kondisi, bukti diaudit) |
| POST | `.../orders/:id/complete` | `order.return` | RETURN_IN_PROGRESS → COMPLETED (tanpa return PENDING) |
| GET | `.../orders/:id/payments` | `payment.read` | Daftar pembayaran (termasuk VOIDED) |
| POST | `.../orders/:id/payments` | `payment.record` | Catat pembayaran manual (RECORDED, append-only) |
| POST | `.../payments/:id/void` | `payment.void` | Koreksi beralasan → VOIDED, histori tetap ada |
| GET | `.../payment-methods` | `payment.read` | Matriks 3 konteks × 3 metode (default aktif) |
| PUT | `.../payment-methods` | `settings.payment_methods.manage` | Ubah matriks; minimal satu metode aktif per konteks |
| GET | `.../orders/:id/refunds` | `payment.read` | Daftar refund + sisa refundable per payment |
| POST | `.../orders/:id/refunds` | `refund.request` | Ajukan refund payment (REQUESTED, batas dihitung server) |
| POST | `.../refunds/:id/approve` | `refund.approve` | REQUESTED → APPROVED, batas dicek ulang |
| POST | `.../refunds/:id/record-result` | `refund.process` | Catat hasil manual SUCCEEDED/FAILED |
| GET | `.../orders/:id/deposits` | `deposit.read` | Saldo + ledger + permintaan potongan |
| POST | `.../orders/:id/deposits` | `deposit.receive` | Movement RECEIPT |
| POST | `.../orders/:id/deposit-deductions` | `deposit.deduct` | Ajukan potongan (PENDING, saldo belum berubah) |
| POST | `.../deposit-deductions/:id/approve` | `deposit.deduct.approve` | Aktor berbeda; membuat movement DEDUCTION |
| POST | `.../deposit-deductions/:id/reject` | `deposit.deduct.approve` | PENDING → REJECTED tanpa movement |
| POST | `.../orders/:id/deposit-refunds` | `deposit.refund` | Movement REFUND (terpisah dari refund payment) |
| POST | `.../orders/:id/deposit-movements/:id/reverse` | `deposit.deduct.approve` | Movement REVERSAL, sekali per movement |

Aturan yang ditegakkan service + database:

- Total order dihitung server dari snapshot item reservasi; harga dari client
  tidak pernah dipercaya.
- Konversi reservasi unik (unique `tenantId + sourceReservationId` + row lock),
  sehingga retry/paralel tidak membuat order ganda.
- Payment tidak dihapus/ditimpa. `VOIDED` tidak dihitung dalam `paidAmount`.
  Pembayaran tidak otomatis mengubah status order/booking. `payments.context`
  menyimpan snapshot konteks (`NEW_BOOKING`/`ADD_UNIT`/`EXTENSION`).
- Metode pembayaran divalidasi terhadap matriks tenant sebelum dicatat.
  Metode nonaktif ditolak `422 PAYMENT_METHOD_DISABLED` walau request langsung
  ke API; konfigurasi yang menyisakan nol metode aktif pada satu konteks ditolak
  `422 BUSINESS_RULE_VIOLATION`. Hanya OWNER/custom permission yang boleh
  mengubah matriks; staf tetap dapat membacanya untuk menampilkan opsi.
- Refund payment adalah entitas terpisah: `REQUESTED → APPROVED →
  SUCCEEDED|FAILED`. Payment asli tetap `RECORDED`. Nilai refundable =
  amount payment − seluruh refund aktif; baris payment dikunci saat pengajuan
  sehingga dua request paralel tidak dapat melebihi nilai payment (diuji).
  `FAILED` melepas kembali nilai refundable; hasil dicatat staf, bukan gateway.
- Saldo deposit dihitung dari `deposit_movements` (RECEIPT +, DEDUCTION/REFUND −,
  REVERSAL membalik arah asal). Command saldo mengunci baris deposit
  (`SELECT ... FOR UPDATE`), sehingga approval/refund paralel tidak menghasilkan
  saldo negatif (diuji dengan request paralel).
- Potongan deposit dua langkah: pengaju dan penyetuju harus aktor berbeda;
  saldo dicek ulang saat approval.
- `Idempotency-Key` didukung pada seluruh command di atas; replay mengembalikan
  hasil sebelumnya tanpa mutasi/audit ganda.

### Perpanjangan sewa & override konflik (`/api/v1/tenants/:tenantId/...`)

| Method | Path | Permission | Keterangan |
|--------|------|------------|------------|
| GET | `.../orders/:id/extensions` | `order.read` | Daftar permintaan perpanjangan |
| GET | `.../orders/:id/extensions/:extensionId` | `order.read` | Detail + konflik/override |
| GET | `.../extensions` | `order.read` | Antrean permintaan lintas order (default `PENDING_APPROVAL`, `?status=ALL` untuk riwayat) |
| POST | `.../orders/:id/extensions` | `rental.extension.request` | Ajukan perpanjangan (tidak mengubah periode) |
| POST | `.../orders/:id/extensions/:extensionId/approve` | `rental.extension.approve` | Setujui + alokasi atomik; 409 bila konflik |
| POST | `.../orders/:id/extensions/:extensionId/reject` | `rental.extension.approve` | Tolak dengan alasan |
| POST | `.../orders/:id/extensions/:extensionId/override-conflict` | `rental.extension.override_conflict` | Setujui konflik Opsi B + alasan + risiko |
| POST | `.../orders/:id/extensions/:extensionId/conflicts/:conflictId/resolve` | `rental.extension.resolve_conflict` | Tandai konflik selesai + catatan; flag dihitung ulang |
| GET | `.../extension-conflicts` | `order.read` | Data operasional: order & reservasi ber-flag + detail konflik |
| POST | `/api/v1/portal/orders/:token/extensions` | `public` (token) | Pengajuan perpanjangan oleh penyewa dari portal; aktor `null` |

Aturan yang ditegakkan service + trigger PostgreSQL:

- Hanya order `ACTIVE` dengan reservasi sumber; toggle
  `rentalExtensionEnabled` wajib aktif. Pengajuan tidak mengubah
  tanggal/alokasi; biaya dihitung server dari Rate/snapshot item.
- Pengajuan dari portal tamu memakai inti aturan yang sama
  (`POST /portal/orders/:token/extensions`): token hanya membuka satu pesanan,
  status order, periode, batas satu permintaan pending, dan biaya dihitung
  server. `requestedByUserId` serta aktor audit bernilai `null` dan
  `metadata.source = "PORTAL"`; persetujuan tetap lewat command approve
  internal. Toggle fitur nonaktif → 422, pesanan belum dibuat → 409.
- Portal menampilkan statusnya sendiri: `GET /portal/orders/:token` memuat
  `extensionsEnabled` dan `extensions[]` (maks 10, terbaru dulu) sehingga tamu
  melihat hasil keputusan staff setelah menutup halaman. Form di
  `apps/web/src/features/portal/extension-panel.tsx` hanya mengirim tanggal
  akhir baru + catatan; tanggal yang tidak melewati akhir sewa ditolak klien
  sebelum request.
- Halaman Pesanan staf memuat antrean keputusan lintas order
  (`apps/web/src/features/orders/pending-extensions.tsx`) dari
  `GET /tenants/:tenantId/extensions` — terlama lebih dulu, plus nomor/status
  pesanan dan nama pelanggan. Panel hanya tampil bagi peran dengan
  `rental.extension.approve`; aksi Setujui/Tolak tetap memanggil command
  approve/reject per order (CSRF + aturan ketersediaan/override yang sama),
  jadi tidak ada jalur keputusan kedua. Setelah keputusan, daftar dimuat ulang
  sehingga baris langsung hilang dari antrean.
- Opsi A (`CHECK_AVAILABILITY`) menolak approval saat konflik. Opsi B
  (`SKIP_AVAILABILITY`) boleh melewati pemeriksaan awal, tetapi approval
  konflik hanya lewat command override dengan permission khusus, `reason`,
  dan `riskConfirmed: true`. Konfirmasi/alasan yang hilang → 422; tanpa
  permission → 403; konflik tanpa override → 409 + `details.conflicts`.
- Daftar konflik selalu dihitung ulang server di dalam transaksi. Client tidak
  boleh mengirim daftar booking terdampak sebagai sumber kebenaran.
- Override membuat alokasi periode tambahan, memperbarui periode/biaya order,
  menandai `hasOpenConflict` pada order dan reservasi terdampak, membuat relasi
  konflik/tugas `OPEN`, dan menulis audit — semuanya atomik dan idempoten.
- Trigger database tetap menolak overlap yang tidak tercatat (23P01 → 409),
  termasuk alokasi normal yang menabrak alokasi override dan dua override
  paralel. Tidak ada endpoint untuk mematikan constraint.
- Konflik `OPEN` adalah tugas operasional. Command resolve memerlukan
  permission `rental.extension.resolve_conflict` (default MANAGER) dan catatan
  penyelesaian; konflik yang sudah `RESOLVED` dikembalikan apa adanya tanpa
  audit ganda. Setelah setiap penyelesaian, server menghitung ulang flag dari
  konflik `OPEN` yang tersisa pada order perpanjangan, order terdampak, dan
  reservasi terdampak — flag bersih tepat ketika konflik terakhir selesai.
  Penyelesaian tidak mengubah periode, alokasi, atau lifecycle apa pun.Data untuk tampilan operasional tersedia di
`GET /api/v1/tenants/:tenantId/extension-conflicts?status=OPEN|RESOLVED|ALL`
(`order.read`, `Cache-Control: no-store`). Respons memuat ringkasan konflik,
order dan reservasi ber-flag, serta detail periode/unit/pelanggan dan pasangan
booking yang bentrok. API tetap tanpa UI: konsumen frontend nanti yang merender
dan memanggil command resolve dengan sesi + CSRF seperti mutasi lain.

### Template WhatsApp (`/api/v1/tenants/:tenantId/whatsapp-templates`)

| Method | Path | Permission | Keterangan |
|--------|------|------------|------------|
| GET | `.../whatsapp-templates` | `payment.read` | Daftar template (filter konteks/metode/tujuan/status) |
| POST | `.../whatsapp-templates` | `settings.whatsapp_templates.manage` | Buat template baru (kombinasi unik), versi 1 |
| POST | `.../whatsapp-templates/preview` | `payment.read` | Render preview; tidak mengirim pesan |
| GET | `.../whatsapp-templates/:id` | `payment.read` | Detail + histori versi terbaru |
| PATCH | `.../whatsapp-templates/:id` | `settings.whatsapp_templates.manage` | Ubah nama/body/status → versi baru |
| POST | `.../whatsapp-templates/:id/restore-default` | `settings.whatsapp_templates.manage` | Pulihkan bawaan → versi baru |

Aturan yang ditegakkan backend: tenant baru mendapat 9 template bawaan
(3 konteks × 3 metode) dengan versi 1; placeholder resmi adalah
`nama_bisnis`, `nama_penyewa`, `nomor_pesanan`, `daftar_barang`, `periode`,
`nominal_tagihan`, `jenis_transaksi`, dan `waktu_pembayaran`. Placeholder tak
dikenal atau format rusak ditolak `400`, bukan diganti `undefined`. Setiap
perubahan body membuat baris `whatsapp_template_versions` baru; histori lama
tidak ditimpa. Template hanya menghasilkan teks click-to-chat dan tidak pernah
dieksekusi sebagai HTML/JavaScript.

Template aktif juga dipakai oleh command transaksi. Respons konversi booking
(`POST .../orders` dan `POST .../reservations/:id/convert-to-order`) memuat
`whatsappMessages`: satu pesan per metode pembayaran aktif yang punya template
aktif pada konteks `NEW_BOOKING`. Respons pencatatan payment memuat
`whatsappMessage` (konfirmasi diutamakan, instruksi sebagai fallback). Keduanya
dirender dengan data nyata order/payment dan disimpan ke
`transaction_message_snapshots` beserta `templateId` + `templateVersion`,
sehingga mengedit template kemudian tidak mengubah pesan yang sudah dipakai.
Histori juga tersedia inline pada `GET .../orders/:orderId` sebagai
`whatsappMessages` (`order.read`), atau terpisah lewat
`GET .../orders/:orderId/whatsapp-messages` (`payment.read`).

### Pengembalian & Inspeksi (`/api/v1/tenants/:tenantId/...`)

| Method | Path | Akses | Keterangan |
|--------|------|-------|------------|
| GET | `.../orders/:orderId/returns` | Semua member | Daftar pengembalian order |
| POST | `.../orders/:orderId/returns` | OWNER/MANAGER/STAFF | Catat pengembalian (PENDING) |
| GET | `.../returns/:returnId` | Semua member | Detail + inspeksi terkait |
| PATCH | `.../returns/:returnId/complete` | OWNER/MANAGER/STAFF | PENDING → COMPLETED |
| PATCH | `.../returns/:returnId/cancel` | OWNER/MANAGER | PENDING → CANCELLED |
| GET | `.../orders/:orderId/inspections` | Semua member | Daftar inspeksi order |
| POST | `.../orders/:orderId/inspections` | OWNER/MANAGER/STAFF | Buat inspeksi (DRAFT) |
| GET | `.../inspections/:inspectionId` | Semua member | Detail inspeksi + lampiran |
| PATCH | `.../inspections/:inspectionId/submit` | OWNER/MANAGER/STAFF | DRAFT → SUBMITTED |
| PATCH | `.../inspections/:inspectionId/decision` | OWNER/MANAGER | SUBMITTED → APPROVED/REJECTED |

Aturan yang ditegakkan service (bukan hanya UI): jumlah kumulatif pengembalian
per produk tidak boleh melebihi jumlah yang disewa, satu unit fisik hanya boleh
muncul pada satu pengembalian aktif per order, `assetId` wajib ber-`quantity` 1,
inspeksi hanya boleh dikaitkan ke return `COMPLETED` pada order yang sama dan
maksimal satu inspeksi aktif per return record. Menyelesaikan pengembalian
mengembalikan unit fisik berstatus `RESERVED` menjadi `AVAILABLE`. Denda
(`penaltyAmount`) dikembalikan sebagai string IDR rupiah utuh.

> **Future:** `POST .../inspections/:inspectionId/attachments` (lampiran R2)
> sudah ada di kontrak OpenAPI tetapi belum diimplementasikan dan ditandai
> `x-implementation-status: future`.

Semua mutasi (`POST`/`PATCH`/`DELETE`) memerlukan header `X-CSRF-Token`.
Semua endpoint memerlukan sesi aktif kecuali disebutkan lain.

## Kontrak OpenAPI

Kontrak **sumber tunggal** ada di [docs/openapi.yaml](docs/openapi.yaml)
(OpenAPI 3.1.1). Salinan kedua di `apps/api/openapi.yaml` sudah dihapus agar
kontrak tidak bercabang.

```bash
pnpm openapi:validate
```

Skrip (`scripts/validate-openapi.mjs`) memeriksa YAML, memvalidasi dokumen
terhadap skema OpenAPI 3.1 (termasuk resolusi seluruh `$ref` dan deteksi
`operationId` ganda), serta menegakkan aturan internal: setiap path wajib punya
`x-implementation-status` bernilai `implemented` atau `future`, setiap operasi
wajib mencantumkan `x-required-permission` non-empty (permission `membership`
wajib mencantumkan daftar `x-required-roles` valid), dan endpoint berstatus
`future` wajib berlabel `[FUTURE]` pada summary (dan sebaliknya). Nilai permission
adalah salah satu `public`, `session`, `membership`, atau key permission tenant
seperti `order.read` sesuai guard di backend.
Jadikan perintah ini gate CI — pipeline `pnpm openapi:validate` sudah menjadi
Gate 1 pada workflow [.github/workflows/ci.yml](.github/workflows/ci.yml).

## Continuous integration

Workflow [.github/workflows/ci.yml](.github/workflows/ci.yml) menjalankan enam gate
berurutan pada push (`main`/`master`) dan pull request; gagal cepat di gate
pertama yang rusak:

1. `bash scripts/actionlint.sh` (**Gate 0**) — static check untuk workflow itu
   sendiri: sintaks, tipe ekspresi `${{ }}`, label runner, validasi input action
   yang dikenal, dan integrasi `shellcheck` pada blok `run:` (shellcheck sudah
   terpasang di runner Ubuntu; di lokal gate tetap jalan tanpa shellcheck)
2. `pnpm openapi:validate` — kontrak OpenAPI 3.1.1 + aturan status implementasi
3. `pnpm typecheck`
4. `pnpm lint`
5. `pnpm build`
6. `pnpm test` — unit + integration

Untuk memeriksa workflow secara lokal:

```bash
pnpm actionlint        # Gate 0 — validasi .github/workflows
```

Binari actionlint (v1.7.12) diunduh sekali dari rilis resmi ke `.tools/`
(berada di `.gitignore`), dipin lewat `ACTIONLINT_VERSION` di
[scripts/actionlint.sh](scripts/actionlint.sh). Catatan: actionlint memvalidasi
input action hanya untuk versi major yang ada di basis data bawaannya, jadi typo
pada `actions/checkout@v4` tertangkap sedangkan `actions/checkout@v7` belum.
Untuk mengganti versi: hapus `.tools/`, setel `ACTIONLINT_VERSION`, jalankan ulang.

Rincian konfigurasi:

- **PostgreSQL 18** berjalan sebagai service container (`postgres:18`,
  `POSTGRES_HOST_AUTH_METHOD=trust`), lalu [scripts/ci/bootstrap-postgres.sql](scripts/ci/bootstrap-postgres.sql)
  membuat role `sewain_migrator`/`sewain_dev` dan database `sewain_test`
  secara idempoten — SQL yang sama bisa dipakai untuk setup lokal dari nol.
  Skrip ini terbukti aman dijalankan berulang (dijalankan dua kali di lingkungan
  dev: run kedua no-op, kedua role non-superuser, database dimiliki migrator).
- **Versi tunggal**: Node dari `.node-version`, pnpm dari `packageManager`,
  lockfile dikunci dengan `pnpm install --frozen-lockfile`.
- `permissions: contents: read`, `concurrency` membatalkan run lama, dan
  `timeout-minutes: 30`.
- Action dipin ke major terkini: `actions/checkout@v7`, `actions/setup-node@v7`,
  `pnpm/action-setup@v6`, dan **Gate 0 memakai actionlint v1.7.12** yang dipin
  lewat skrip agar workflow-nya sendiri ikut diperiksa sebelum gate lain.

> Catatan: workspace ini **belum menjadi repository Git**, sehingga workflow belum
> pernah dieksekusi oleh GitHub Actions. Yang diverifikasi lokal adalah (a) YAML
> valid + struktur gate/urutan/pin action sesuai, dan (b) bootstrap SQL berjalan
> sukses dan idempoten terhadap PostgreSQL 18.4. Begitu repo di-push, aktifkan
> branch protection agar enam gate ini menjadi syarat merge.

## Logging terstruktur

Log akses dan error ditulis sebagai **satu baris JSON** ke stdout oleh
`StructuredLogger` (`apps/api/src/common/`):

```json
{"method":"POST","path":"/api/v1/auth/sessions","status":201,"durationMs":12.4,"correlationId":"…","userId":"…","level":"info","time":"…","service":"rentalio-api","msg":"http_request"}
```

- **Redaksi wajib** (`common/redact.ts`): field bernama token/secret/password/
cookie/authorization/session/CSRF disamarkan, begitu pula pola nilai seperti
`Bearer …`, `rentalio_session=…`, `?otp=…`, dan `"resetToken":"…"`. OTP pada field
`code` disamarkan hanya bila berbentuk 4–8 digit, sehingga `ERROR_CODE` tetap
terbaca. Nilai password, OTP, dan token tidak pernah masuk log — diuji di
`test/unit/redact.test.ts`.
- Request logging **tidak** mencatat body, header, maupun query string.
- Di test, log akses ditekan agar keluaran ringkas. Untuk menampilkan (mis. saat
  mendiagnosis kegagalan 500): `RENTALIO_DEBUG_LOG=1 pnpm --filter @rentalio/api test:integration`.

## Menjalankan test

```bash
pnpm test              # semua test (unit + integration)
pnpm --filter @rentalio/api test:unit
pnpm --filter @rentalio/api test:integration
```

Unit test tidak memerlukan database (`vitest.unit.config.ts`); integration test
memerlukan PostgreSQL berjalan.

Integration test berjalan terhadap **PostgreSQL nyata** pada database
`sewain_test` (role runtime `sewain_dev`), bukan mock. `globalSetup`
mereset schema `sewain_test` lalu menjalankan seluruh migrasi **dari database
kosong** — sekaligus membuktikan database dapat dibangun dari nol.

> Catatan: test memakai `EMAIL_PROVIDER=in-memory`, sehingga OTP dibaca dari
> adapter memori, bukan file.

### Catatan SWC untuk test

NestJS bergantung pada `emitDecoratorMetadata` untuk meresolusi dependensi
constructor (DI). Vite/esbuild yang dipakai vitest **tidak mendukung** fitur
tersebut, sehingga tanpa konfigurasi tambahan inisialisasi NestJS akan
menggantung. `vitest.config.ts` karena itu memakai `unplugin-swc` dengan
`legacyDecorator` + `decoratorMetadata` aktif. Jangan hapus plugin tersebut.

## Backup dan pemulihan

Prosedur lengkap ada di [docs/runbooks/backup-restore.md](docs/runbooks/backup-restore.md).
Ringkasnya:

- Backup memakai `pg_dump --format=custom` dengan role **superuser atau
  `BYPASSRLS`**. Role runtime/migrator akan gagal pada tabel ber-FORCE RLS;
  itu perilaku yang benar, jangan dimatikan RLS-nya.
- Latihan restore diotomasi: dump → restore ke database sementara → bandingkan
  jumlah baris tiap tabel, tabel ber-RLS, dan policy → hapus database sementara.

```bash
# butuh pg_dump/pg_restore/psql >= versi server
BACKUP_DATABASE_URL="postgresql://rentalio_backup@localhost:5432/sewain_dev" \
  pnpm db:backup:verify
```

Hasil 20 Oktober 2026 pada `sewain_test`: 43 tabel / 7.093 baris, 37 tabel
ber-RLS, 45 policy — identik setelah restore, exit code 0. Jadwal, retensi, dan
RPO/RTO masih usulan yang menunggu keputusan pemilik produk.

## Perintah umum

| Perintah | Fungsi |
| --- | --- |
| `pnpm build` | build semua package |
| `pnpm typecheck` | typecheck semua package |
| `pnpm lint` | lint semua package |
| `pnpm test` | semua test |
| `pnpm db:migrate` | jalankan migrasi (deploy) |
| `pnpm db:migrate:dev` | migrasi interaktif (butuh shadow DB) |
| `pnpm db:generate` | regenerate Prisma client |
| `pnpm db:backup:verify` | dump + uji restore ke database sementara, lalu bandingkan isi |
| `pnpm --filter @rentalio/database build && DATABASE_URL=… pnpm --filter @rentalio/database seed` | pasang plan platform default (idempoten; butuh `DATABASE_URL` role runtime) |
| `pnpm api:dev` | jalankan server dev |
| `pnpm openapi:validate` | validasi kontrak OpenAPI 3.1.1 + aturan status implementasi |
| `pnpm actionlint` | validasi workflow GitHub Actions (Gate 0 CI) |

## Pemecahan masalah

**Startup gagal: `Konfigurasi wajib tidak lengkap`**
`DATABASE_URL` atau `HMAC_PEPPER` kosong. Salin `.env.example` ke `.env`.

**`HMAC_PEPPER minimal 32 karakter`**
Hasilkan nilai acak (lihat bagian konfigurasi).

**`PORT harus integer 1-65535`**
Lingkungan shell kemungkinan membawa `PORT=0`. Jalankan dengan `PORT=3000`
eksplisit atau hapus variabel tersebut.

**Test integration menggantung saat inisialisasi NestJS**
`unplugin-swc` belum aktif atau tidak terpasang. Pastikan ada di
`devDependencies` dan plugin terdaftar di `vitest.config.ts`.

**Migrasi gagal dengan error IMMUTABLE pada exclusion constraint**
Kolom `DateTime` Prisma adalah `timestamp` tanpa zona; `tstzrange` butuh
`timestamptz`. Gunakan `tsrange` (sudah diperbaiki di migrasi kedua).

**`permission denied` saat koneksi**
`DATABASE_URL` memakai role runtime `sewain_dev`, sedangkan DDL butuh role
`sewain_migrator`. Jalankan migrasi dengan URL migrator.

**`pg_dump: query would be affected by row-level security policy`**
Role yang dipakai bukan superuser dan tanpa `BYPASSRLS`, sedangkan tabel memakai
`FORCE ROW LEVEL SECURITY`. Buat role backup `BYPASSRLS` yang hanya punya
`SELECT` (lihat runbook), lalu pakai lewat `BACKUP_DATABASE_URL`.
