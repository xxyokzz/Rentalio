# Deploy Rentalio: Supabase + Vercel

Dokumen ini adalah prosedur deploy yang dipakai repository ini. Untuk urutan
eksekusi dan gerbang verifikasi saat rilis, gunakan
[`docs/deploy-production-checklist.md`](./deploy-production-checklist.md).

Ada tiga project Vercel dari satu repo:

| Project Vercel | Root Directory | Framework | Isi |
| --- | --- | --- | --- |
| `rentalio-api` | `apps/api` | NestJS (zero-config) | REST API `/api/v1`, termasuk cron |
| `rentalio-web` | `apps/web` | Next.js | Frontend tenant |
| `rentalio-admin` | `apps/admin` | Next.js | Admin Platform (origin sendiri) |

Database berjalan di Supabase PostgreSQL. R2 tetap dipakai untuk object
storage; Supabase hanya menggantikan PostgreSQL.

---

## 1. Supabase

### 1.1 Buat project

1. Buat project Supabase (pilih region terdekat, mis. Singapore).
2. Simpan **project ref** dan password database.
3. Rentalio tidak memakai Supabase Auth/PostgREST. Di **Project Settings ->
   API**, matikan Data API bila tidak diperlukan.

### 1.2 Bootstrap role dan extension

Buka **SQL Editor**, ganti dulu kedua password placeholder di
`database/sql/supabase-bootstrap.sql`, lalu jalankan seluruh file itu sebagai
role `postgres`.

File tersebut:

- memasang `btree_gist` di schema `extensions`;
- membuat `sewain_migrator` (DDL) dan `sewain_dev` (runtime);
- memastikan keduanya **bukan** superuser dan **tidak** punya `BYPASSRLS`;
- memberi `CREATE` pada schema `public` hanya ke migrator;
- mencabut akses `anon`/`authenticated` ke schema `public`.

> Penting: jangan memakai role `postgres` sebagai `DATABASE_URL` runtime.
> Di Supabase role itu memiliki `BYPASSRLS`, sehingga `FORCE ROW LEVEL SECURITY`
> tidak lagi melindungi data tenant.

Verifikasi hasilnya:

```sql
SELECT rolname, rolsuper, rolbypassrls
FROM pg_roles
WHERE rolname IN ('sewain_migrator', 'sewain_dev');
```

Keduanya harus `rolsuper = false` dan `rolbypassrls = false`.

### 1.3 Connection string

Supabase Dashboard -> **Connect**:

- **Transaction pooler (port 6543)** untuk `DATABASE_URL` runtime.
  Username pooler untuk custom role: `sewain_dev.<project-ref>`.
- **Session pooler (port 5432)** untuk `DIRECT_URL` migrasi.
  Username: `sewain_migrator.<project-ref>`.

Contoh (ganti semua placeholder):

```dotenv
DATABASE_URL=postgresql://sewain_dev.[PROJECT_REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres?sslmode=require&uselibpqcompat=true&schema=public
DIRECT_URL=postgresql://sewain_migrator.[PROJECT_REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres?sslmode=require&schema=public
```

Catatan:

- Transaction pooler tidak mendukung session state. Aplikasi hanya memakai
  `SET LOCAL`/`set_config(..., true)` di dalam transaksi, jadi aman.
- `@prisma/adapter-pg` tidak meng-cache prepared statement kecuali
  `statementNameGenerator` diisi, sehingga tidak perlu `pgbouncer=true`.
- `sslmode=require` wajib, dan `DATABASE_URL` juga wajib memuat
  `uselibpqcompat=true`. Sejak pg 8.16 `sslmode=require` diperlakukan seperti
  `verify-full`, sementara sertifikat pooler Supabase ditandatangani CA privat
  (`Supabase Root 2021 CA`) yang tidak ada di trust store Node — tanpa flag itu
  API gagal konek dengan `SELF_SIGNED_CERT_IN_CHAIN`. Dengan flag tersebut
  koneksi tetap terenkripsi tetapi identitas server tidak diverifikasi; bila
  butuh verifikasi penuh, unduh `prod-ca-2021.crt` dari Database Settings → SSL
  Configuration lalu pasang sebagai `ca` pada driver.
- `DIRECT_URL` (migrasi) tidak butuh flag tersebut: Prisma CLI memakai schema
  engine Rust dengan trust store sendiri, dan sudah terverifikasi bisa konek
  dengan `sslmode=require` saja.
- Bila mesin Anda punya IPv6 atau project memakai IPv4 add-on, direct
  connection `db.[PROJECT_REF].supabase.co:5432` juga bisa dipakai sebagai
  `DIRECT_URL`.

### 1.4 Migrasi dan seed

Migrasi **tidak** dijalankan otomatis oleh Vercel. Jalankan dari mesin
operator/CI yang punya akses ke Supabase:

```bash
# dari root repo; DIRECT_URL dibaca database/prisma.config.ts
pnpm db:generate
pnpm db:migrate

# opsional: data plan platform default
pnpm --filter @rentalio/database seed
```

`prisma.config.ts` dijalankan dengan cwd `database`, jadi `dotenv/config`
membaca `database/.env`, bukan root `.env`. Ekspor variabel di shell atau taruh
salinan koneksi Supabase di `database/.env` (gitignored).

Gunakan `prisma migrate deploy` (script `pnpm db:migrate`). `prisma migrate
dev` membutuhkan shadow database dan sebaiknya tetap diarahkan ke PostgreSQL
lokal, bukan Supabase produksi.

> Perhatian: `database/prisma.config.ts` memprioritaskan `DIRECT_URL` untuk CLI.
> Bila `.env` lokal berisi `DIRECT_URL` produksi, `pnpm db:migrate:dev` akan
> menyentuh database produksi. Kosongkan `DIRECT_URL` saat development lokal,
> atau simpan kredensial Supabase di file env terpisah dan ekspor hanya saat
> menjalankan migrasi deploy.

Untuk development sehari-hari, tetap pakai PostgreSQL lokal seperti di
`README.md`; Supabase dipakai untuk staging/production.

---

## 2. Vercel

### 2.1 Import repo tiga kali

Di Vercel, import repository yang sama tiga kali, lalu set **Root Directory**
sesuai tabel di atas. Untuk setiap project:

1. **Settings -> Build and Deployment -> Root Directory**: isi direktori app.
2. Aktifkan **Include source files outside of the Root Directory in the Build
   Step** (dibutuhkan karena `@rentalio/database` berada di workspace).
3. Biarkan Framework Preset terdeteksi otomatis (NestJS/Next.js).
4. Node.js 26.x adalah default Vercel saat dokumen ini ditulis dan cocok
   dengan `engines.node` repo.

File `vercel.json` di tiap app sudah mengatur install command dari root
workspace. API juga mengatur build command yang men-generate Prisma Client dan
membangun `@rentalio/database` sebelum `apps/api`.

### 2.2 Environment variables API

Set di project `rentalio-api`, untuk **Production** (dan Preview bila perlu):

| Variable | Nilai |
| --- | --- |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | transaction pooler `sewain_dev` (port 6543) |
| `DATABASE_POOL_MAX` | `5` (serverless). Nilai `1` membuat beberapa request paralel pada satu halaman mengantre di satu koneksi dan gagal `P2028` |
| `HMAC_PEPPER` | minimal 32 karakter acak |
| `PLATFORM_ADMIN_ENCRYPTION_KEY` | base64 dari 32 byte |
| `PLATFORM_ADMIN_BASE_URL` | origin admin, mis. `https://admin.rentalio.my.id` |
| `CORS_ORIGINS` | origin web + admin, dipisah koma |
| `APP_BASE_URL` | origin web, mis. `https://rentalio.my.id` |
| `COOKIE_SECURE` | `true` |
| `EMAIL_PROVIDER` | `resend` (wajib di production) |
| `RESEND_API_KEY` | API key Resend |
| `EMAIL_FROM` | pengirim domain terverifikasi |
| `CRON_SECRET` | string acak; dipakai Vercel Cron |
| `CRON_STATUS_TOKEN` | opsional; token endpoint status (fallback `CRON_SECRET`) |
| `CRON_ALERT_EMAIL` | opsional; penerima alert (fallback `PLATFORM_OPERATOR_EMAIL`) |
| `API_ALERT_EMAIL` | opsional; penerima alert 5xx/P2028 endpoint tenant (fallback `PLATFORM_OPERATOR_EMAIL`) |
| `API_ALERT_COOLDOWN_SECONDS` | default `300`; jeda minimum antar-alert per instance |
| `CRON_ALERT_COOLDOWN_SECONDS` | `3600`; jeda minimum antar-alert |
| `CRON_STALE_AFTER_SECONDS` | `300`; batas umur run terakhir |
| `OUTBOX_WORKER_ENABLED` | `false` |
| `SUBSCRIPTION_RECONCILER_ENABLED` | `false` |
| `BILLING_REMINDER_ENABLED` | `false` |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_URL` | kredensial R2 |
| `PLATFORM_QRIS_STATIC_PAYLOAD`, `SUBSCRIPTION_PRICE_AMOUNT`, `PLATFORM_OPERATOR_EMAIL` | opsional, sesuai billing |

Flag worker **harus tetap `false`** di project API. Cron memanggil
`runOnce()` langsung; bila flag dinyalakan, interval juga hidup di dalam
function serverless.

`DIRECT_URL` tidak perlu di-set di Vercel karena migrasi dijalankan di luar
build. Bila ingin tersedia untuk keperluan operator, set sebagai secret
terpisah dan jangan dipakai runtime.

Pastikan `DATABASE_URL` juga tersedia pada tahap **Build** di Vercel (opsi
Build dicentang saat menambah env). `prisma generate` memuat
`database/prisma.config.ts`, yang membaca `DATABASE_URL`/`DIRECT_URL` saat
konfigurasi dimuat.

### 2.3 Environment variables web dan admin

Project `rentalio-web`:

| Variable | Nilai |
| --- | --- |
| `API_INTERNAL_URL` | URL API production, mis. `https://api.rentalio.my.id` |
| `NEXT_PUBLIC_APP_URL` | origin web, mis. `https://rentalio.my.id` |
| `NEXT_PUBLIC_PLATFORM_ROOT_DOMAIN` | domain root katalog, mis. `rentalio.my.id` |
| `NEXT_PUBLIC_DEFAULT_TENANT_SLUG` | tidak dipakai lagi; katalog hanya di subdomain tenant |
| `SUPPORT_WHATSAPP` | opsional |

Project `rentalio-admin`:

| Variable | Nilai |
| --- | --- |
| `API_INTERNAL_URL` | URL API production |
| `NEXT_PUBLIC_ADMIN_APP_URL` | origin admin; **harus persis sama** dengan `PLATFORM_ADMIN_BASE_URL` API |

`API_INTERNAL_URL` dibaca saat **build** oleh `next.config.ts` (rewrites), bukan
saat request. Set nilainya sebelum deploy; mengubahnya memerlukan redeploy.
Karena browser memanggil `/api/v1/*` secara same-origin, cookie sesi tetap
host-only dan tidak perlu CORS kredensial di browser.

### 2.4 Urutan deploy

1. Set env API, web, dan admin final; `API_INTERNAL_URL` harus sudah benar
   sebelum build web/admin.
2. Siapkan Deploy Hook API, web, dan admin di Vercel.
3. Jalankan workflow `Deploy production`; workflow membackup, memigrasi, lalu
   mendeploy API dan menunggu health sebelum web/admin.
4. Pasang/verifikasi domain, lalu jalankan smoke test.

Preview deployment memiliki URL acak. Untuk Admin Platform, `Origin` harus
exact match dengan `PLATFORM_ADMIN_BASE_URL`, jadi preview admin tidak bisa
melakukan mutasi bila env-nya menunjuk origin production. Gunakan domain
production yang stabil untuk admin, atau set env per preview secara sadar.

### 2.5 Release production lewat GitHub Actions

Workflow `.github/workflows/deploy-production.yml` menjalankan urutan wajib:
backup Supabase → `prisma migrate deploy` → trigger Deploy Hook Vercel API →
tunggu health API → trigger Deploy Hook web/admin.

`apps/api/vercel.json`, `apps/web/vercel.json`, dan `apps/admin/vercel.json`
memakai `git.deploymentEnabled` untuk mematikan auto-deploy branch `main` dan
`master`. Dengan begitu, push ke branch production tidak memicu build Vercel
sebelum migrasi selesai; deploy production hanya lewat Deploy Hook dari
workflow. Preview branch lain tetap dapat dibuat otomatis.

Secret yang dibutuhkan pada environment `production` di GitHub:

| Secret | Isi |
| --- | --- |
| `SUPABASE_BACKUP_URL` | role backup dengan `BYPASSRLS`/superuser, mis. `postgres` lewat session pooler |
| `SUPABASE_MIGRATION_URL` | `sewain_migrator` lewat session pooler port 5432 |
| `BACKUP_ENCRYPTION_PASSPHRASE` | passphrase acak untuk mengenkripsi artifact |
| `VERCEL_DEPLOY_HOOK_API` | Deploy Hook project API |
| `VERCEL_DEPLOY_HOOK_WEB` | Deploy Hook project web |
| `VERCEL_DEPLOY_HOOK_ADMIN` | Deploy Hook project admin |
| `API_HEALTH_URL` | `https://api.../api/v1/health/ready` |

Workflow hanya berjalan lewat `workflow_dispatch`; jalankan dari branch
`main`/`master` dan isi `DEPLOY` pada input konfirmasi. Backup mencakup schema
`public` (data aplikasi) dan disimpan sebagai artifact terenkripsi selama 30
hari.
Deploy Hook hanya mengantrekan build; status build tetap dicek di dashboard
Vercel. Jangan gunakan role `postgres` sebagai `DATABASE_URL` runtime.

---

## 3. Worker dan Vercel Cron

`apps/api/src/worker.ts` adalah proses long-lived dan **tidak** bisa dijalankan
sebagai function Vercel. Dua pilihan:

### Opsi A — Vercel Cron

Endpoint `/api/v1/internal/cron` sudah tersedia dan dilindungi
`Authorization: Bearer $CRON_SECRET`. Endpoint menjalankan satu putaran outbox,
reconciler subscription, dan pengingat billing.

Repo ini **tidak** mendaftarkan `crons` di `apps/api/vercel.json` karena target
deployment saat ini adalah Vercel Hobby. Di Hobby, cron hanya boleh berjalan
sekali sehari; jadwal per menit akan menggagalkan deployment. Pilih salah satu:

- **Vercel Pro** — tambahkan blok berikut ke `apps/api/vercel.json`:

  ```json
  "crons": [
    { "path": "/api/v1/internal/cron", "schedule": "* * * * *" }
  ]
  ```

- **Scheduler eksternal** — panggil endpoint dengan bearer setiap 1–5 menit:

  ```bash
  curl -fsS -X POST \
    -H "Authorization: Bearer $CRON_SECRET" \
    https://api.<domain>/api/v1/internal/cron
  ```

- **Worker long-lived** — gunakan Opsi B di bawah.

Tanpa salah satu opsi tersebut, endpoint cron tetap ada tetapi tidak dipanggil
otomatis.

- Vercel Cron hanya berjalan pada deployment **production**.
- Dengan Vercel Cron, outbox yang biasanya dipoll tiap 5 detik diproses tiap
  menit; dengan worker long-lived, interval asli tetap dipakai.

### Monitoring dan alert

Setiap putaran cron menulis satu baris ke tabel `cron_runs` (status
`SUCCEEDED`/`PARTIAL`/`FAILED`, hasil per job, durasi, dan waktu alert).
Riwayat disimpan 14 hari agar tabel tidak tumbuh tanpa batas.

- **Status endpoint** — `GET /api/v1/internal/cron/status`, dilindungi
  `Authorization: Bearer $CRON_STATUS_TOKEN` (fallback ke `CRON_SECRET`).
  Respons `200` berarti run terakhir sukses dan masih segar; `503` berarti
  `degraded` (ada job gagal), `stale` (tidak ada run dalam
  `CRON_STALE_AFTER_SECONDS`), atau `unknown` (database tidak dapat dibaca).
  Endpoint ini tidak menjalankan job, aman dipoll tiap 1–5 menit.
- **Uptime monitor** — arahkan monitor (Better Stack, Checkly, UptimeRobot,
  atau layanan serupa) ke endpoint status, kirim header bearer, dan alert
  pada respons non-2xx. Ini menangkap kondisi cron berhenti berjalan.
- **Alert email** — bila satu atau lebih job gagal, API mengirim email ke
  `CRON_ALERT_EMAIL` (fallback `PLATFORM_OPERATOR_EMAIL`) lewat Resend.
  Alert dibatasi `CRON_ALERT_COOLDOWN_SECONDS` (default 1 jam) agar cron per
  menit tidak membanjiri inbox. Kegagalan mengirim alert tidak mengubah
  respons cron; kegagalan itu dicatat sebagai `cron_alert_failed`.
- **Vercel Observability** — aktifkan alert untuk error rate/5xx function
  `rentalio-api`, dan bila perlu pasang Log Drain. Log cron memakai JSON
  lines dengan event `cron_run_finished`, `cron_job_failed`,
  `cron_alert_sent`, `cron_run_persist_failed`, dan `cron_status_failed`.
- Di Hobby, gunakan Opsi B atau panggil endpoint dari scheduler eksternal.

### Opsi B — worker long-lived di host lain

Jalankan `pnpm --filter @rentalio/api start:worker` di Railway/Fly/Render/VPS
dengan env yang sama seperti API. Ini mempertahankan interval asli
(`OUTBOX_POLL_INTERVAL_MS`, dsb.) dan lebih tepat untuk beban produksi.
Repo default sudah tidak memiliki properti `crons`, jadi Opsi B dapat langsung
dipakai tanpa mengubah `vercel.json`.

Jangan menjalankan keduanya tanpa memahami idempotensi: job memang dirancang
aman untuk beberapa worker (lease/klaim di database), tetapi outbox dan
pengingat akan saling berebut baris.

---

## 4. Verifikasi setelah deploy

1. `GET https://<api>/api/v1/health` -> `{"status":"ok"}`.
2. `GET https://<api>/api/v1/health/ready` -> `database: "ok"`.
3. Login web dan admin dari origin production; cookie harus `Secure`,
   `HttpOnly`, dan host-only.
4. Uji isolasi tenant: query sebagai `sewain_dev` tanpa `app.tenant_id` harus
   menghasilkan nol baris pada tabel tenant-scoped.
5. Verifikasi endpoint cron (request valid akan menjalankan job sungguhan):

   ```bash
   API=https://<api>
   curl -i "$API/api/v1/internal/cron"                                        # 401
   curl -i -H "Authorization: Bearer salah" "$API/api/v1/internal/cron"        # 401
   curl -i -H "Authorization: Bearer $CRON_SECRET" "$API/api/v1/internal/cron" # 200
   curl -i -H "Authorization: Bearer $CRON_STATUS_TOKEN" \
     "$API/api/v1/internal/cron/status"                                      # 200
   ```
6. Cek Vercel Runtime Logs / Log Drain untuk event `cron_run_finished`,
   `cron_job_failed`, dan error koneksi pooler/Prisma.
7. Pastikan `EMAIL_PROVIDER=resend` dan kirim satu OTP sungguhan.

---

## 5. Catatan operasional

- Backup: gunakan fitur backup Supabase (sesuai plan) dan uji restore.
  Script `scripts/ops/backup-restore.mjs` tetap berguna untuk verifikasi
  dump/restore manual dengan `BACKUP_DATABASE_URL`.
- Migrasi selalu dijalankan sebelum deploy aplikasi yang membutuhkan kolom
  baru. Vercel build tidak menjalankan migrasi.
- Rotasi password role: `ALTER ROLE sewain_dev WITH PASSWORD '...'` lalu
  perbarui `DATABASE_URL` di Vercel dan redeploy.
- Bila Supabase project dipakai bersama aplikasi lain, **jangan** jalankan
  `REVOKE` anon/authenticated dari bootstrap SQL; buat project terpisah.
