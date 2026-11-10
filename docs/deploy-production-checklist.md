# Checklist Deploy Production — Vercel + Supabase

Checklist operasional untuk rilis production Rentalio. Prosedur latar belakang
ada di [`docs/deploy-supabase-vercel.md`](./deploy-supabase-vercel.md); dokumen
ini adalah urutan eksekusi dan gerbang verifikasinya.

Isi saat mulai:

| Item | Nilai |
| --- | --- |
| Tanggal rilis | |
| Commit / tag | |
| Operator | |
| Supabase project ref | |
| API production URL | |
| Web production URL | |
| Admin production URL | |
| Rollback deployment sebelumnya | |

> **Peringatan plan:** repo default tidak mendaftarkan `crons` karena target
> deployment adalah Vercel Hobby. Cron per menit hanya untuk **Vercel Pro**;
> Hobby menggagalkan deployment bila `crons` per menit ditambahkan. Untuk
> Hobby, panggil endpoint cron dari scheduler eksternal atau jalankan worker
> long-lived di host lain.

---

## 0. Gerbang awal

- [ ] Plan Vercel diketahui: **Hobby** dengan cron dipindahkan ke scheduler
      eksternal/worker, atau **Pro** dengan cron per menit.
- [ ] Supabase production adalah project **khusus Rentalio**, bukan project
      bersama aplikasi lain.
- [ ] Akses tersedia: Vercel, Supabase SQL Editor, DNS/domain, Resend, R2, dan
      repo/CI.
- [ ] Staging Supabase terpisah dari production; migrasi dan uji destruktif
      tidak dijalankan langsung ke production.
- [ ] Domain final sudah ditentukan: apex web, `api`, `admin`, dan wildcard
      tenant.
- [ ] Backup/snapshot Supabase production dibuat sebelum migrasi.
- [ ] Jendela deploy disepakati; tidak ada perubahan schema lain bersamaan.
- [ ] Build CI untuk commit rilis hijau.

---

## 1. Supabase

### 1.1 Project dan keamanan dasar

- [ ] Project Supabase production dibuat di region terdekat dengan region
      function API (mis. Singapore).
- [ ] Project ref dan password database disimpan di password manager, bukan di
      repo/chat.
- [ ] **Data API dimatikan** bila tidak dipakai (Project Settings → API).
- [ ] SSL/TLS database aktif; `DIRECT_URL` memakai `sslmode=require`, dan
      `DATABASE_URL` memakai `sslmode=require&uselibpqcompat=true` (lihat 1.3).
- [ ] Akses jaringan sudah sesuai: pooler Supabase, atau direct connection +
      IPv4 add-on bila dipakai.

### 1.2 Bootstrap role dan extension

- [ ] Salin `database/sql/supabase-bootstrap.sql`, ganti **kedua password
      placeholder**, lalu jalankan seluruh file sebagai role `postgres` di SQL
      Editor.
- [ ] Verifikasi role:

      ```sql
      SELECT rolname, rolsuper, rolbypassrls
      FROM pg_roles
      WHERE rolname IN ('sewain_migrator', 'sewain_dev');
      ```

      Keduanya harus `rolsuper = false` dan `rolbypassrls = false`.
- [ ] Verifikasi extension `btree_gist` terpasang di schema `extensions`.
- [ ] Verifikasi `anon` dan `authenticated` tidak punya akses ke schema
      `public`.
- [ ] `sewain_migrator` hanya untuk DDL/migrasi; `sewain_dev` hanya untuk
      runtime aplikasi.
- [ ] `DATABASE_URL` runtime **tidak** memakai role `postgres` (role itu
      memiliki `BYPASSRLS`, sehingga RLS tenant tidak melindungi data).

### 1.3 Connection string

- [ ] `DATABASE_URL` runtime memakai **transaction pooler port 6543** dengan
      username `sewain_dev.<project-ref>`.
- [ ] `DIRECT_URL` migrasi memakai **session pooler port 5432** dengan username
      `sewain_migrator.<project-ref>`.
- [ ] Password dengan karakter khusus sudah di-URL-encode.
- [ ] `DIRECT_URL` hanya ada di mesin operator/CI migrasi, tidak dipakai
      runtime Vercel.
- [ ] Tes koneksi migrator dan runtime berhasil sebelum lanjut.

### 1.4 Migrasi

Urutan dari root repo, dengan `DIRECT_URL` production diekspor di shell:

```bash
pnpm db:generate
pnpm db:migrate
```

- [ ] Backup/snapshot dibuat **sebelum** `pnpm db:migrate`.
- [ ] `prisma migrate deploy` selesai tanpa migrasi gagal.
- [ ] Jumlah migrasi yang diterapkan sesuai repo: **32 migrasi**.
- [ ] Tabel `_prisma_migrations` tidak memiliki baris `failed` atau
      `rolled_back`.
- [ ] Tabel baru `cron_runs` ada dan dapat diakses role runtime.
- [ ] Seed plan platform dijalankan bila diperlukan:

      ```bash
      pnpm --filter @rentalio/database seed
      ```

- [ ] Akun admin pertama dibuat lewat terminal interaktif:

      ```bash
      pnpm --filter @rentalio/api admin:bootstrap
      ```

      `admin:seed` **tidak boleh** dipakai di production (menolak
      `NODE_ENV=production`).
- [ ] Admin pertama menyelesaikan enrollment TOTP saat login pertama.
- [ ] Email admin production dicatat di tempat aman.

### 1.5 Backup dan restore

- [ ] Backup otomatis Supabase aktif; retensi sesuai plan.
- [ ] PITR aktif bila plan mendukung.
- [ ] Prosedur restore sudah diketahui; minimal satu restore di staging pernah
      diuji.
- [ ] Backup manual sebelum rilis disimpan dan lokasinya dicatat.

---

## 2. Vercel — tiga project

Import repository yang sama tiga kali:

| Project | Root Directory | Framework |
| --- | --- | --- |
| `rentalio-api` | `apps/api` | NestJS |
| `rentalio-web` | `apps/web` | Next.js |
| `rentalio-admin` | `apps/admin` | Next.js |

Untuk setiap project:

- [ ] Root Directory diisi sesuai tabel.
- [ ] **Include source files outside of the Root Directory in the Build Step**
      diaktifkan (dibutuhkan untuk workspace `@rentalio/database`).
- [ ] Framework preset terdeteksi otomatis.
- [ ] Node.js 26.x dipakai (cocok dengan `engines.node` repo).
- [ ] Install command dari `vercel.json` berjalan dari root workspace.
- [ ] Region function API dipilih dekat dengan Supabase.
- [ ] API project memakai `buildCommand` yang men-generate Prisma Client dan
      membangun `@rentalio/database` sebelum `apps/api`.
- [ ] Preview deployment API diuji **sebelum** production; konfirmasi entrypoint
      `src/main.ts` terdeteksi dan function dapat melayani `/api/v1/health`.
- [ ] Tidak ada `DIRECT_URL` di environment Vercel.
- [ ] Deployment Protection tidak menghalangi rewrite server-side dari web/admin
      ke API. Jika API dilindungi Vercel Authentication, siapkan bypass yang
      sesuai atau matikan proteksi untuk origin production.
- [ ] Auto-deploy branch `main`/`master` dimatikan di ketiga `vercel.json`
      (`git.deploymentEnabled`); deploy production hanya lewat Deploy Hook
      workflow. Preview branch lain tetap boleh otomatis.
- [ ] Deploy Hook untuk API, web, dan admin sudah dibuat di Vercel
      (Settings → Git → Deploy Hooks) dan disimpan sebagai secret GitHub.

---

## 3. Domain dan DNS

Rekomendasi pemisahan host:

| Host | Project |
| --- | --- |
| `rentalio.my.id` | `rentalio-web` |
| `www.rentalio.my.id` | redirect ke apex |
| `api.rentalio.my.id` | `rentalio-api` |
| `admin.rentalio.my.id` | `rentalio-admin` |
| `*.rentalio.my.id` | `rentalio-web` (wildcard tenant) |

- [ ] Domain apex dan `www` terpasang di project web; redirect canonical
      dipilih.
- [ ] `api.rentalio.my.id` terpasang di project API.
- [ ] `admin.rentalio.my.id` terpasang di project admin.
- [ ] Wildcard `*.rentalio.my.id` terpasang di project web.
- [ ] DNS record (A/CNAME) sesuai instruksi Vercel dan sudah propagate.
- [ ] Sertifikat SSL aktif untuk apex, `www`, `api`, `admin`, dan wildcard.
- [ ] Subdomain tenant diuji resolve dan menampilkan tenant yang benar.
- [ ] Domain kustom tenant didaftarkan di Vercel + DNS tenant; kepemilikan
      domain diverifikasi lewat alur aplikasi.
- [ ] `NEXT_PUBLIC_PLATFORM_ROOT_DOMAIN` **tanpa** protokol dan tanpa wildcard
      (contoh: `rentalio.my.id`).

---

## 4. Environment API (`rentalio-api`)

Set untuk **Production**. Jika Preview memakai database staging, gunakan nilai
terpisah dan jangan mencampur secret production.

| Variable | Nilai production | Catatan |
| --- | --- | --- |
| `NODE_ENV` | `production` | Wajib |
| `DATABASE_URL` | transaction pooler `sewain_dev` port 6543 | **Centang Build** |
| `DATABASE_POOL_MAX` | `1` | Serverless |
| `HMAC_PEPPER` | acak, minimal 32 karakter | Jangan pernah diganti sembarangan |
| `PLATFORM_ADMIN_ENCRYPTION_KEY` | base64 tepat 32 byte | Jangan rotasi tanpa rencana |
| `PLATFORM_ADMIN_BASE_URL` | `https://admin.rentalio.my.id` | Origin exact, tanpa path/trailing slash |
| `CORS_ORIGINS` | origin web + admin + `https://*.rentalio.my.id`, pisahkan koma | Tanpa trailing slash; wildcard hanya satu label subdomain |
| `SESSION_COOKIE_DOMAIN` | `rentalio.my.id` | Sesi berlaku di subdomain tenant; kosong = host-only |
| `APP_BASE_URL` | `https://rentalio.my.id` | Origin web |
| `COOKIE_SECURE` | `true` | Wajib HTTPS |
| `EMAIL_PROVIDER` | `resend` | Wajib di production |
| `RESEND_API_KEY` | API key Resend | Secret |
| `EMAIL_FROM` | `Rentalio <no-reply@domain-terverifikasi>` | Domain harus terverifikasi |
| `RESEND_OTP_TEMPLATE` | nama template published, bila dipakai | Opsional |
| `CRON_SECRET` | string acak | Vercel Cron mengirim bearer ini |
| `CRON_STATUS_TOKEN` | string acak terpisah | Opsional; fallback `CRON_SECRET` |
| `CRON_ALERT_EMAIL` | email operator | Opsional; fallback `PLATFORM_OPERATOR_EMAIL` |
| `CRON_ALERT_COOLDOWN_SECONDS` | `3600` | Default aman |
| `CRON_STALE_AFTER_SECONDS` | `300` | Default aman |
| `OUTBOX_WORKER_ENABLED` | `false` | Jangan hidupkan interval di serverless |
| `SUBSCRIPTION_RECONCILER_ENABLED` | `false` | Cron memanggil job langsung |
| `BILLING_REMINDER_ENABLED` | `false` | Cron memanggil job langsung |
| `R2_ACCOUNT_ID` | dari Cloudflare | Wajib untuk upload |
| `R2_ACCESS_KEY_ID` | dari Cloudflare | Secret |
| `R2_SECRET_ACCESS_KEY` | dari Cloudflare | Secret |
| `R2_BUCKET_NAME` | bucket production | Jangan campur dengan staging |
| `R2_PUBLIC_URL` | custom domain/R2 public URL | Tanpa trailing slash |
| `PLATFORM_QRIS_STATIC_PAYLOAD` | payload QRIS merchant | Opsional |
| `SUBSCRIPTION_PRICE_AMOUNT` | harga IDR | Opsional |
| `PLATFORM_OPERATOR_EMAIL` | email operator | Opsional |

- [ ] Semua variable wajib terisi; API menolak startup bila `DATABASE_URL` atau
      `HMAC_PEPPER` kosong.
- [ ] `EMAIL_PROVIDER=resend` disertai `RESEND_API_KEY`; jika tidak, startup
      gagal.
- [ ] `PLATFORM_ADMIN_ENCRYPTION_KEY` didekode menjadi **tepat 32 byte**.
- [ ] `PLATFORM_ADMIN_BASE_URL` HTTPS dan persis sama dengan origin admin.
- [ ] `DATABASE_URL` tersedia saat **Build**, bukan hanya Runtime.
- [ ] `DIRECT_URL` tidak di-set di Vercel.
- [ ] Flag worker tetap `false` agar tidak ada interval yang hidup di function.
- [ ] Secret production dan preview tidak sama.
- [ ] Setelah mengubah env, lakukan redeploy; env runtime lama tidak berubah
      otomatis.

Contoh membuat nilai acak (jangan tempel hasilnya ke chat/commit):

```bash
openssl rand -base64 48   # HMAC_PEPPER
openssl rand -base64 32   # PLATFORM_ADMIN_ENCRYPTION_KEY (32 byte)
openssl rand -hex 32      # CRON_SECRET / CRON_STATUS_TOKEN
```

> `PLATFORM_ADMIN_ENCRYPTION_KEY` mengenkripsi secret TOTP admin. Menggantinya
> tanpa re-enrollment/recovery akan membuat TOTP lama tidak terbaca. Simpan
> sebagai secret jangka panjang dan backup di password manager.

---

## 5. Environment web dan admin

### `rentalio-web`

| Variable | Nilai |
| --- | --- |
| `API_INTERNAL_URL` | `https://api.rentalio.my.id` |
| `NEXT_PUBLIC_APP_URL` | `https://rentalio.my.id` |
| `NEXT_PUBLIC_PLATFORM_ROOT_DOMAIN` | `rentalio.my.id` |
| `NEXT_PUBLIC_DEFAULT_TENANT_SLUG` | tidak dipakai lagi; `/katalog` di domain platform menjawab 404 |
| `SUPPORT_WHATSAPP` | digit tanpa `+`, opsional |

### `rentalio-admin`

| Variable | Nilai |
| --- | --- |
| `API_INTERNAL_URL` | `https://api.rentalio.my.id` |
| `NEXT_PUBLIC_ADMIN_APP_URL` | `https://admin.rentalio.my.id` |

- [ ] `API_INTERNAL_URL` diisi **sebelum build**; nilainya dibaca saat build
      oleh `next.config.ts`, bukan saat request.
- [ ] `NEXT_PUBLIC_ADMIN_APP_URL` persis sama dengan
      `PLATFORM_ADMIN_BASE_URL` API.
- [ ] Tidak ada secret backend (`DATABASE_URL`, `RESEND_API_KEY`,
      `HMAC_PEPPER`, kredensial R2) di project frontend.
- [ ] `NEXT_PUBLIC_*` hanya berisi nilai yang memang boleh publik.
- [ ] Setelah mengubah `API_INTERNAL_URL`, web/admin di-redeploy.

---

## 6. Layanan eksternal

### Resend

- [ ] Domain pengirim terverifikasi.
- [ ] SPF, DKIM, dan DMARC sudah benar.
- [ ] `EMAIL_FROM` memakai domain terverifikasi.
- [ ] Template OTP (bila dipakai) berstatus **published**.
- [ ] Satu email OTP production benar-benar diterima.
- [ ] Bounce/complaint handling dipantau.

### Cloudflare R2

- [ ] Bucket production dibuat dan terpisah dari staging.
- [ ] API token dibatasi ke bucket tersebut.
- [ ] CORS bucket mengizinkan `PUT` dari origin web production (upload memakai
      presigned URL langsung dari browser).
- [ ] `R2_PUBLIC_URL` dapat diakses publik sesuai kebutuhan aset.
- [ ] Object lifecycle/retensi ditentukan.
- [ ] Upload dan delete diuji dari web production.

---

## 7. Urutan deploy

- [ ] Freeze perubahan schema dan merge commit rilis.
- [ ] Backup Supabase otomatis/manual sebelum migrasi.
- [ ] Bootstrap role (sekali) dan jalankan 32 migrasi.
- [ ] Seed plan dan bootstrap admin.
- [ ] Siapkan Deploy Hook API, web, dan admin di Vercel.
- [ ] Jalankan workflow `Deploy production` dari branch `main`/`master`;
      ketik `DEPLOY`.
- [ ] Workflow membuat backup terenkripsi, menjalankan migrasi, lalu trigger
      Deploy Hook API dan menunggu `/api/v1/health/ready`.
- [ ] Setelah API sehat, workflow trigger Deploy Hook web dan admin.
- [ ] Catat URL production API dan pasang domain `api`.
- [ ] Set `CORS_ORIGINS`, `PLATFORM_ADMIN_BASE_URL`, dan env API final.
- [ ] Pasang domain web, admin, dan wildcard.
- [ ] Jalankan smoke test web/admin.
- [ ] Aktifkan scheduler cron eksternal/worker atau Vercel Pro cron.
- [ ] Pasang uptime monitor dan alert.

> Jangan menjalankan migrasi dari build Vercel. Build hanya men-generate Prisma
> Client; migrasi tetap dijalankan operator/CI sebelum aplikasi baru menerima
> trafik.

### Secret workflow production

Simpan pada environment `production` di GitHub:

| Secret | Isi |
| --- | --- |
| `SUPABASE_BACKUP_URL` | role backup dengan `BYPASSRLS`/superuser, mis. `postgres` lewat session pooler |
| `SUPABASE_MIGRATION_URL` | `sewain_migrator` lewat session pooler port 5432 |
| `BACKUP_ENCRYPTION_PASSPHRASE` | passphrase acak untuk artifact backup |
| `VERCEL_DEPLOY_HOOK_API` | Deploy Hook project API |
| `VERCEL_DEPLOY_HOOK_WEB` | Deploy Hook project web |
| `VERCEL_DEPLOY_HOOK_ADMIN` | Deploy Hook project admin |
| `API_HEALTH_URL` | `https://api.../api/v1/health/ready` |

- [ ] Semua secret di atas tersedia di environment `production`.
- [ ] Passphrase backup disimpan di password manager; tanpa itu artifact tidak
      dapat direstore.
- [ ] Required reviewer pada environment `production` diaktifkan.
- [ ] Backup artifact terenkripsi tersimpan 30 hari.
- [ ] Deploy Hook hanya mengantrekan build; status build dicek di dashboard
      Vercel.

---

## 8. Verifikasi setelah deploy

### Dasar

- [ ] `GET https://api.../api/v1/health` → `200`, `{"status":"ok"}`.
- [ ] `GET https://api.../api/v1/health/ready` → `200` dan body
      `database: "ok"` (cek body, bukan hanya status HTTP).
- [ ] Web apex menampilkan halaman tanpa error 5xx.
- [ ] Subdomain tenant menampilkan tenant yang benar.
- [ ] Admin tampil di origin `https://admin...`.

### Auth dan isolasi

- [ ] Registrasi/login web berhasil; cookie `Secure`, `HttpOnly`, dan host-only.
- [ ] OTP production diterima dan dapat diverifikasi.
- [ ] Reset password berfungsi.
- [ ] Login admin berhasil, TOTP enrollment/login berhasil.
- [ ] Mutasi admin dari origin production berhasil (tidak kena CSRF origin).
- [ ] Dua tenant diuji: data tenant A tidak terlihat dari tenant B.
- [ ] Query runtime tanpa `app.tenant_id` pada tabel tenant-scoped menghasilkan
      nol baris, bukan data tenant:

      ```bash
      psql "$DATABASE_URL" -c "select count(*) from customers;"
      ```

- [ ] Akses langsung ke API tanpa sesi mengembalikan 401, bukan data.

### Upload dan billing

- [ ] Upload file dari web berhasil (presigned URL + CORS R2).
- [ ] File dapat diunduh dari URL publik.
- [ ] Delete file berhasil dan object benar-benar hilang.
- [ ] Bila billing aktif: tagihan QRIS dibuat, dibayar, dan status subscription
      berubah sesuai alur.
- [ ] Bila billing belum aktif: UI memakai jalur manual dan tidak error.

### Cron

- [ ] Request tanpa bearer ke `/api/v1/internal/cron` → 401.
- [ ] Bearer salah → 401.
- [ ] Bearer `CRON_SECRET` → 200 dan job berjalan.
- [ ] `/api/v1/internal/cron/status` dengan token status → 200.
- [ ] Halaman admin `/cron` menampilkan run terbaru dan status per job.
- [ ] Jika memakai Vercel Pro cron: entri Cron muncul di tab Cron Jobs dan
      berjalan di production.
- [ ] Jika memakai scheduler eksternal: panggilan terjadwal benar-benar tiba
      dan run baru muncul di `/cron`.
- [ ] Log `cron_run_finished` terlihat di Vercel Runtime Logs.
- [ ] Tidak ada `cron_run_persist_failed` atau error pooler berulang.
- [ ] Alert email cron diuji dengan satu kegagalan terkontrol (opsional).

---

## 9. Monitoring dan alert

- [ ] Vercel Observability aktif untuk project API: error rate, 5xx, durasi
      function, invocation.
- [ ] Alert Vercel dikirim ke channel/email operator.
- [ ] Uptime monitor memanggil endpoint status cron tiap 1–5 menit dengan
      bearer token; alert pada non-2xx.
- [ ] Alert email cron diarahkan ke `CRON_ALERT_EMAIL`/operator.
- [ ] Log Drain dipasang bila diperlukan retensi/analisis log.
- [ ] Dashboard Supabase dipantau: koneksi pooler, CPU, disk, slow query.
- [ ] Biaya/kuota Vercel dan Supabase dipantau.
- [ ] Runbook insiden dan kontak eskalasi diketahui operator.

---

## 10. Keamanan

- [ ] Tidak ada secret di repo, build log, source map publik, atau bundle
      frontend.
- [ ] `.env` dan file kredensial tetap gitignored.
- [ ] Vercel Environment Variables ditandai **Sensitive** untuk secret.
- [ ] `COOKIE_SECURE=true`; seluruh origin production HTTPS.
- [ ] `CORS_ORIGINS` hanya origin yang dikenal.
- [ ] `PLATFORM_ADMIN_BASE_URL` exact match; tidak memakai wildcard.
- [ ] Runtime Supabase bukan `postgres` dan tidak punya `BYPASSRLS`.
- [ ] Data API/PostgREST Supabase dimatikan bila tidak dipakai.
- [ ] `anon`/`authenticated` tidak punya akses schema `public`.
- [ ] R2 bucket tidak publik kecuali aset yang memang publik; CORS dibatasi.
- [ ] Rate limit API aktif; `RATE_LIMIT_SCALE` tidak dinaikkan di production.
- [ ] Deployment Protection tidak memblokir rewrite web/admin ke API.
- [ ] Akses Vercel/Supabase memakai 2FA dan least privilege.
- [ ] Rencana rotasi `CRON_SECRET`, password DB, dan kunci R2 diketahui.

---

## 11. Rollback

- [ ] Deployment API, web, dan admin sebelumnya diketahui URL/ID-nya.
- [ ] Rollback Vercel dilakukan dengan promote deployment sebelumnya; urutan
      API dan frontend disesuaikan dengan kompatibilitas schema.
- [ ] Migrasi bersifat forward-only; tidak ada `migrate reset` di production.
- [ ] Perubahan schema memakai pola expand/contract agar deployment lama tetap
      bisa jalan selama rollback.
- [ ] Jika migrasi merusak data: hentikan trafik, restore backup/PITR, lalu
      deploy ulang versi aplikasi yang sesuai.
- [ ] Cron dapat dihentikan dengan menghapus `crons` (bila memakai Vercel
      Pro) lalu redeploy, atau menonaktifkan scheduler eksternal/worker.
- [ ] Perubahan env dikembalikan dan diikuti redeploy (terutama
      `API_INTERNAL_URL` yang dibaca saat build).
- [ ] Insiden dan keputusan rollback dicatat.

---

## 12. Go / No-Go

Deploy production hanya jika semua ini terpenuhi:

- [ ] Cron sudah dipindahkan ke scheduler eksternal/worker, atau Vercel Pro
      dengan `crons` yang valid.
- [ ] Supabase bootstrap selesai; role aman; 32 migrasi berhasil.
- [ ] Backup production tersedia dan restore telah diuji.
- [ ] Env API lengkap, termasuk `DATABASE_URL` pada tahap Build.
- [ ] Env web/admin lengkap dan `API_INTERNAL_URL` final.
- [ ] Domain + SSL + wildcard tenant aktif.
- [ ] Admin pertama sudah dibuat dan TOTP dapat dipakai.
- [ ] Resend dan R2 terverifikasi end-to-end.
- [ ] Smoke test auth, tenant isolation, upload, dan cron lolos.
- [ ] Monitoring/alert aktif.
- [ ] Rollback plan disepakati.
- [ ] Tidak ada perubahan unrelated yang ikut ter-deploy.

---

## 13. Setelah rilis

**24 jam pertama**

- [ ] Pantau 5xx, durasi function, dan error Prisma/pooler.
- [ ] Pantau `cron_runs`: tidak ada `FAILED` berulang atau status `stale`.
- [ ] Pantau pengiriman email (bounce/complaint).
- [ ] Pantau upload R2 dan error CORS.
- [ ] Cek pertumbuhan koneksi Supabase dan disk.
- [ ] Konfirmasi backup berikutnya berhasil.

**7 hari pertama**

- [ ] Review biaya dan kuota Vercel/Supabase.
- [ ] Review log error yang berulang.
- [ ] Review alert yang terlalu noisy.
- [ ] Cabut akses sementara dan kredensial uji.
- [ ] Catat perbaikan untuk rilis berikutnya.
