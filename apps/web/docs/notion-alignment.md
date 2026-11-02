# Keselarasan frontend dengan dokumentasi Notion

Audit tanggal **21 Oktober 2026** untuk `apps/web`. Dokumen ini memetakan
keputusan di Notion ke kode yang ada, mencatat perbedaan yang sudah diperbaiki,
dan memisahkan gap yang **terblokir kontrak backend** dari pekerjaan frontend
yang masih bisa dikerjakan.

Dokumen ini bukan bukti bahwa fitur lulus. Status bukti pengujian ada di
[`state-matrix.md`](state-matrix.md#bukti-pengujian).

## Dokumen acuan yang dibaca

| Dokumen | Bagian yang mengikat frontend |
| --- | --- |
| 00 — Indeks Dokumentasi | domain & route, parameter auth final, keputusan pembayaran, template WhatsApp |
| 02 — Arsitektur Teknis | Next.js, `src/desktop` + `src/mobile` + `src/shared` + `src/features`, routing host tenant, PWA |
| 04 — Spesifikasi REST API | kontrak `/auth/registrations`, lifecycle booking/order/payment/deposit, error & idempotency, permission |
| 06 — Backlog & Roadmap | prioritas P0/P1 (katalog publik, booking tamu, portal order), urutan sprint |
| 09 — Panduan Pengembangan Frontend | art direction, design tokens, state wajib, format Indonesia, PWA, DoD per fitur |
| 14 — Alur Penyewa | katalog → booking tamu → portal pesanan → pembayaran manual → serah-terima → pengembalian |
| 15 — Pemeriksaan Kerusakan & Denda | sakelar tenant, nominal per tingkat, kondisi awal/akhir, snapshot order |
| 16 — Audit Konsistensi | register keputusan kanonis, termasuk aturan Opsi A/B yang menggantikan teks lama |

Dokumen 01/03/05/07/08/10/11/12/13/17 dan ADR-001 dipakai sebagai rujukan
kontrak (produk, data, keamanan, QA, admin); keputusan yang berdampak ke UI
sudah diringkas di dokumen 09/14/16 di atas.

## Aturan kanonis yang sudah dipatuhi kode

- **Stack**: Next.js 16 App Router + React 19 + TypeScript strict, tanpa framework UI
  eksternal; token di `src/shared/styles/tokens.css`; validasi Zod.
- **Struktur**: shell desktop (`src/desktop`) dan mobile (`src/mobile`) terpisah,
  kode domain di `src/features`, kontrak/format/auth di `src/shared`.
- **Sesi**: cookie HttpOnly tidak dibaca JavaScript; mutasi mengirim `X-CSRF-Token`;
  401 memicu logout UX dan `?next=` internal.
- **Status terpisah**: booking, lifecycle order, pembayaran, deposit, dan
  perpanjangan memakai badge sendiri; tidak ada status gabungan.
- **Uang & waktu**: integer rupiah + `formatIDR`; timestamp UTC, tampilan zona waktu tenant.
- **Pembayaran**: Cash/Transfer/QRIS per konteks (`NEW_BOOKING`, `ADD_UNIT`,
  `EXTENSION`), hanya metode aktif yang ditawarkan; WhatsApp click-to-chat tidak
  mengubah status pembayaran.
- **Restricted mode**: banner + tombol pembuatan baru dinonaktifkan; alur
  penyelesaian order tetap tersedia.
- **PWA**: manifest + service worker yang hanya meng-cache aset statis dan `/offline`.
- **Opsi A/B katalog**: dipusatkan di `src/features/catalog/policy.ts` dan diuji.

## Perbaikan pada audit ini

### 1. Perilaku katalog Opsi A/B terbalik

Sebelumnya katalog dan POS memblokir booking saat stok kosong ketika policy
`CHECK_AVAILABILITY` (Opsi A), lalu mengizinkan permintaan ketika
`SKIP_AVAILABILITY` (Opsi B) — kebalikan dari dokumen 14 §A.6 dan 16 §1.

Sekarang:

- `CHECK_AVAILABILITY` → permintaan tetap dikirim sebagai `PENDING_APPROVAL`
  tanpa alokasi (termasuk saat mode booking otomatis), tombol berubah menjadi
  "Ajukan permintaan stok".
- `SKIP_AVAILABILITY` → booking diblokir dan CTA "Tanyakan via WhatsApp" menjadi jalur.
- Keputusan dipusatkan di `src/features/catalog/policy.ts`; dipakai katalog dan POS;
  diuji di `policy.test.ts` (3 tes).

### 2. Dokumentasi internal

- `README.md`: path styles yang benar (`src/shared/styles`), jumlah tes, catatan policy.
- `state-matrix.md`: AC Opsi A/B untuk POS (§8) dan katalog (§20).

## Gap yang belum bisa ditutup dari frontend saja

Semua item di bawah membutuhkan kontrak/endpoint backend lebih dulu. UI tidak
boleh mengarang data atau status untuk menutupinya.

| Gap | Bukti | Yang dibutuhkan |
| --- | --- | --- |
| Pemeriksaan kerusakan & denda | tidak ada `damage_inspection_enabled` atau nominal Ringan/Sedang/Parah di API/DB; UI hanya menerima usulan denda saat inspeksi | setting tenant, konfigurasi per produk, snapshot order |
| Billing SaaS | belum ada endpoint paket/trial/upgrade; UI hanya menampilkan status | kontrak subscription |
| Admin Platform | API fondasi `/platform-admin/*` sudah ada di backend (29 Okt 2026); `admin.rentalio.my.id` adalah aplikasi terpisah yang belum ada | aplikasi/route admin terpisah |

Catatan penting: dokumen 04 menetapkan `POST /auth/registrations` menerima
`email, password, ownerName, tenantName, tenantSlug`. Sejak 29 Okt 2026
ketiganya sudah diteruskan controller ke service dan divalidasi (lihat Update
29 Okt 2026 di bawah); sebelumnya controller hanya meneruskan `email`,
`password`, dan persetujuan legal, sehingga form sengaja tidak mengirimnya.
Verifikasi email tidak membuat tenant — pembuatan tenant tetap lewat
`POST /tenants` pada onboarding, jadi mengirim slug saat mendaftar hanya
menyimpan prefill, bukan membuat tenant lebih awal.

Update 29 Okt 2026 — lima gap yang sebelumnya tercatat pada tabel di atas
(katalog publik tanpa login, booking tamu, portal pesanan berbasis token,
nomor WhatsApp/QRIS tenant, dan perpanjangan dari portal) **sudah tertutup**
dan karena itu tidak lagi masuk daftar gap:

- Endpoint publik ada di `apps/api/src/public/public.controller.ts` dan tercatat
  di `docs/openapi.yaml`: `GET /public/{tenantSlug}/catalog`,
  `/catalog-config`, `/products/{productId}`, `/availability`,
  `POST /public/{tenantSlug}/bookings`, dan `GET /portal/orders/{token}`;
  resolusi tenant dari hostname lewat policy token-bound pada `tenant_domains`
  (migrasi `20261022090000`).
- Halaman frontend ada: `app/katalog`, `app/t/[slug]/katalog`, dan
  `app/portal/[token]`.
- Field `Tenant.whatsappNumber`, `bankTransferInstructions`, dan
  `qrisImageUrl` (migrasi `20261021090000`) dipakai di settings, katalog
  publik, dan portal — `whatsappShareUrl()` kini menerima nomor tenant.
- Alur verifikasi email tidak lagi membuat tenant (perbaikan P0 27 Okt 2026):
  satu-satunya jalur pembuatan tenant adalah `POST /tenants` lewat onboarding,
  sehingga keluhan “slug pendaftaran membuat akun tanpa tenant” tidak berlaku
  lagi.
- **Perpanjangan dari portal sudah tersedia** (29 Okt 2026):
  `POST /portal/orders/{token}/extensions` kini ada di kontrak dan backend
  (`apps/api/src/public/public.controller.ts` → `PublicService` → inti aturan
  `ExtensionsService`). Token hanya membuka satu pesanan; biaya/konflik
  dihitung server, `requestedByUserId` dan aktor audit `null`, dan permintaan
  tetap menunggu keputusan staff lewat command approve internal.
- **Form perpanjangan di portal** (29 Okt 2026):
  `src/features/portal/extension-panel.tsx` menampilkan form tanggal akhir baru
  + catatan (opsional), lalu riwayat permintaan beserta statusnya. Status
  dibaca dari server, bukan hanya dari respons POST: `GET /portal/orders/{token}`
  kini menyertakan `extensions[]` (maks 10, terbaru dulu) dan
  `extensionsEnabled`. Form disembunyikan saat masih ada permintaan
  `PENDING_APPROVAL`, pesanan belum dibuat, atau toggle tenant mati; tanggal
  yang tidak melewati akhir sewa ditolak sebelum memanggil API.
- **Antrean keputusan di halaman Pesanan staf** (29 Okt 2026):
  `src/features/orders/pending-extensions.tsx` menampilkan semua permintaan
  `PENDING_APPROVAL` lintas order (terlama lebih dulu) lengkap dengan nomor
  dan status pesanan, nama pelanggan, periode, biaya, serta aksi Setujui /
  Tolak. Daftar datang dari endpoint baru `GET /tenants/{tenantId}/extensions`
  (`order.read`, `?status=ALL` untuk riwayat); panel hanya dirender bagi peran
  dengan `rental.extension.approve`, dan aksinya memanggil command
  approve/reject per order yang sama dengan halaman detail — keputusan tidak
  pernah diproses di klien. Keputusan memuat ulang daftar sehingga baris
  langsung hilang; konflik ketersediaan tetap 409 dan diselesaikan dari
  detail pesanan.
- **Badge antrean di menu** (29 Okt 2026):
  `usePendingExtensionCount()` + komponen `NavCountBadge`
  (`src/shared/ui/nav-badge.tsx`) menampilkan jumlah
  permintaan yang menunggu pada item **Pesanan** — sidebar desktop, tab bar
  dan drawer mobile. Hanya dihitung bagi peran dengan
  `rental.extension.approve`, nilai `null` (tanpa izin / belum dimuat / 0)
  tidak merender badge sehingga angka 0 palsu tidak pernah tampil, dan teks
  alternatif disertakan untuk pembaca layar.
- **Badge konflik terbuka + refresh tanpa navigasi** (29 Okt 2026):
  `useOpenConflictCount()` (`src/features/conflicts/open-conflict-count.tsx`)
  memakai `summary.openConflicts` dari ringkasan `GET
  /tenants/{tenantId}/extension-conflicts?status=OPEN` (dedupe server) pada
  item **Konflik perpanjangan** (sidebar + drawer, tone bahaya), hanya untuk
  peran dengan `rental.extension.resolve_conflict`. Kedua badge berlangganan
  sinyal `src/shared/events/extension-activity.ts`: panel antrean, panel
  perpanjangan di detail pesanan, dan halaman konflik memanggilnya setelah
  setujui/tolak/override/penyelesaian berhasil, sehingga angka berubah tanpa
  menunggu pindah halaman. Sinyal hanya memberi tahu “data berubah”; angkanya
  tetap dibaca ulang dari server.
  Ringkasan konflik dibaca lewat cache singkat + single-flight
  (`src/features/conflicts/conflict-overview-cache.ts`, TTL 5 detik, dibuang
  setiap sinyal aktivitas dan tidak menyimpan kegagalan), sehingga membuka
  `/app/conflicts` hanya memicu satu request meskipun badge dan halaman aktif
  bersamaan. Sejak 30 Okt 2026 halaman **Ringkasan** (`/app`) memakai jalur yang
  sama, bukan memanggil endpoint langsung, jadi kartu “Konflik perpanjangan” di
  dashboard tidak lagi menambah request ringkasan kedua. Tombol "Muat ulang"
  membuang cache itu lebih dulu, jadi aksi manual selalu membaca ulang dari
  server.
- **Akun & pelanggan** (29 Okt 2026): `GET /me` mengembalikan profil akun +
  membership aktif, dan `GET/POST /tenants/{tenantId}/customers` memberi
  direktori pelanggan dengan permission `customer.read`/`customer.write`.
- **Field pendaftaran 09/04 sudah tersambung** (29 Okt 2026): controller
  meneruskan `ownerName`/`tenantName`/`tenantSlug` ke service dengan validasi
  (1–120 / 1–100 / 3–63 + regex slug `CreateTenantDto`), form registrasi
  mengirim ketiganya (slug opsional + usulan otomatis dari nama toko), sesi
  login/`GET /auth/sessions/current` mengembalikannya, dan halaman onboarding
  memprefill nama toko + link katalog dari profil sesi. Gap “Form pendaftaran
  sesuai 09/04” karena itu tidak lagi masuk daftar di atas.

Update 28 Okt 2026: **persetujuan legal sudah diwajibkan dan direkam**. Form
mengirim `termsAccepted: true`, `termsVersion`, `privacyVersion` (versi dari
`apps/web/src/shared/config/legal.ts`, ditampilkan juga di `/legal/terms` dan
`/legal/privacy`); backend menyimpannya ke `users.termsConsentVersion`,
`users.privacyConsentVersion`, `users.legalConsentAt` (migrasi
`20261028090000_user_legal_consent`) dan mencatat versinya pada audit
`OWNER_SIGNUP_STARTED`. Pendaftaran tanpa persetujuan ditolak 400.

## Verifikasi badge perpanjangan & konflik — 30 Oktober 2026

Bukti untuk badge **Pesanan** (antrean perpanjangan) dan **Konflik
perpanjangan**, dijalankan dengan dev server aktif dan data QA nyata.

### Perubahan kode pada verifikasi ini

- `src/features/dashboard/overview.tsx` membaca ringkasan konflik lewat
  `loadConflictOverview` (cache + single-flight) alih-alih
  `extensionApi.conflictOverview` langsung. Sebelumnya dashboard memicu satu
  request tambahan di samping badge saat `/app` dibuka.
- Test regresi baru `src/features/dashboard/overview.test.tsx` merender
  `DashboardOverview` bersama pemakai `useOpenConflictCount()` dan menuntut
  endpoint ringkasan dipanggil **tepat sekali**. Test ini terbukti gagal
  (`expected "spy" to be called 1 times, but got 2 times`) saat pemanggilan
  langsung dikembalikan sementara.
- `src/features/orders/pending-extension-count.tsx` kini mengembalikan `null`
  saat antrean kosong (sebelumnya `0`), seragam dengan `useOpenConflictCount()`:
  badge tidak pernah menampilkan angka nol. Test `mengembalikan null ketika
  antrean kosong` gagal (`expected +0 to be null`) sebelum perbaikan ini dan
  deterministik setelahnya.

### Data QA yang bisa diulang

`scripts/qa/seed-badge-data.mjs` lewat `pnpm qa:seed:badges` menyiapkan satu
permintaan `PENDING_APPROVAL` dan satu konflik `OPEN` secara **idempoten**
(bagian yang sudah ada dilewati; dijalankan dua kali tidak menambah baris).
Kredensial hanya dari `--email/--password` atau `QA_SEED_EMAIL` /
`QA_SEED_PASSWORD`; tenant dipilih dengan `--tenant` (slug atau nama).
Skrip memakai endpoint aplikasi — reservasi → konfirmasi → pengajuan
perpanjangan → `approve` (409 `AVAILABILITY_CONFLICT`) → `override-conflict`
berizin — sehingga konflik dihitung server, bukan ditanam ke database. Bila
`approve` justru berhasil (mis. tenant memakai `CHECK_AVAILABILITY`), skrip
berhenti dengan pesan jelas alih-alih memalsukan konflik.

### Bukti perilaku di browser (data nyata)

| Aksi di halaman | Badge Pesanan | Badge Konflik | Angka pembanding API |
| --- | --- | --- | --- |
| Kondisi awal (antrean 1, konflik 1) | `1` | `1` | `pending 1`, `openConflicts 1` |
| Setujui permintaan di `/app/orders` | hilang, tanpa navigasi | tetap `1` | `pending 0` |
| Tandai selesai konflik di `/app/conflicts` | tetap `0` | hilang, tanpa navigasi | `openConflicts 0`, `resolvedConflicts 1` |
| Tolak permintaan (diajukan ulang) | hilang, tanpa navigasi | tetap `0` | `pending 0` |
| Buka `/app` (cache dingin) | — | — | satu request `extension-conflicts?status=OPEN` untuk dashboard + badge |

Statistik halaman konflik ikut konsisten: `Konflik terbuka 0 / selesai 1 /
Pesanan bertanda 0 / Reservasi bertanda 0` setelah penyelesaian, dan kartu
Ringkasan menampilkan angka yang sama dari cache bersama.

### Bukti otomatis

| Perintah | Hasil |
| --- | --- |
| `pnpm --filter @rentalio/web test` | 135 tes lulus (20 file), termasuk test regresi badge, banner, label sidebar, ringkasan langganan, tautan pengajuan perpanjangan, dan panel pembayaran QRIS |
| `pnpm --filter @rentalio/web typecheck` | lulus |
| `pnpm --filter @rentalio/web lint` | lulus |
| `pnpm --filter @rentalio/api test` | lulus (unit + integrasi), termasuk suite billing QRIS |
| `pnpm --filter @rentalio/web build` | lulus, 31 route (27 dirender statis; `/app/settings` dinamis untuk membaca `SUPPORT_WHATSAPP` saat request) |
| `vitest run test/integration/extensions.integration.test.ts` | 12 tes lulus (Opsi A/B, override, konkurensi, ringkasan & penyelesaian konflik, antrean lintas order) |

Test API memakai database `sewain_test` (global setup menolak URL selain
`/sewain_test`), jadi data tenant dev/QA tidak tersentuh. Badge pada theme
mobile (tab bar + drawer) belum diuji ulang secara visual pada verifikasi ini.

E2E Playwright juga dijalankan ulang pada 30 Oktober 2026: `e2e/public.spec.ts`
**14 tes lulus, 2 dilewati**, sedangkan suite penuh `playwright test` memberi
**45 lulus / 0 gagal / 2 dilewati** (47 eksekusi; sesi dibagi lewat
`storageState` dari project `setup`, sehingga satu suite hanya melakukan satu
login dan `429` tidak lagi muncul; `audit_all_features` ikut memakai sesi itu,
sedangkan form masuk diuji terpisah di `e2e/login-form.spec.ts`).
`audit_all_features` lulus penuh 13 titik di kedua project karena assertion
status langganan menerima state yang dikenal (`Coba gratis N hari lagi`, `Masa
coba habis hari ini`, `Paket aktif`, `Toko ditangguhkan`). `catalog_editor`
tes 1–12 juga lulus di kedua project setelah langganan tenant demo diaktifkan
lewat fixture idempoten `database/prisma/activate_demo_subscription.mjs` — tanpa
itu command simpan draf ditolak `403 TENANT_RESTRICTED`. Detail di
`apps/web/README.md`.

## Pembaruan backend — 28 Oktober 2026

Walau detail server berada di repo root, perubahan backend berikut berpengaruh
pada kontrak yang dipakai frontend:

- Seluruh 112 operasi OpenAPI kini memuat `x-required-permission` (135 operasi
  per 31 Okt 2026 setelah penambahan endpoint Admin Platform, portal
  perpanjangan, `/me`, direktori pelanggan, antrean perpanjangan staf, serta
  billing langganan QRIS); operasi yang
  memerlukan membership mencantumkan role yang diizinkan. Gate
  `pnpm openapi:validate` menolak anotasi permission yang kosong atau tidak
  konsisten.
- Transaksi tenant dicoba ulang secara utuh pada SQLSTATE PostgreSQL `40P01`
  (deadlock) dan `40001` (serialization failure), dengan backoff terbatas.
  Integration test terhadap PostgreSQL nyata memicu kedua kegagalan dan
  memverifikasi retry; error non-retryable tidak diulang.
- (31 Okt 2026) `TenantResponse` menambah object `subscription`
  (`status`, `restricted`, `reason`, `trialEndsAt`, `graceEndsAt`, `periodEnd`)
  yang dihitung `SubscriptionPolicyService.compute` — fungsi murni yang sama
  dengan guard `403 TENANT_RESTRICTED`. Banner mode terbatas kini memakai nilai
  itu; sebelumnya klien menebak dari `tenant.status` + `trialEndsAt`, sehingga
  peringatan "aktifkan paket langganan" tetap muncul pada tenant yang
  langganannya sudah aktif. Label status di sidebar memakai sumber yang sama
  (`useTenantStatusBadge`), jadi tenant yang langganannya dibatalkan tidak lagi
  tampil sebagai "Coba gratis N hari lagi" hanya karena trial-nya belum lewat.
  Halaman Pengaturan usaha menampilkan baris "Status langganan" (badge + detail
  periode/tenggang/alasan dibatasi) lewat `subscriptionSummary`, dan baris
  "Akhir masa coba" tidak lagi menambahkan "(0 hari lagi)" pada tenant yang
  trial-nya sudah lewat.
- (31 Okt 2026) Panel "Langganan" di Pengaturan usaha menyediakan tautan
  pengajuan perpanjangan/upgrade ke tim Rentalio. Belum ada endpoint billing,
  jadi tautan hanya menyiapkan pesan WhatsApp (pengguna tetap menekan Kirim);
  nomor tujuan dibaca dari `SUPPORT_WHATSAPP` di environment **server** saat
  request dirender (`/app/settings` di-`force-dynamic`), bukan dari
  `NEXT_PUBLIC_*` yang tertanam di bundle — jadi mengganti nomor tidak menuntut
  build ulang. Nomor **tidak** di-hard-code: bila kosong, WhatsApp membuka
  pemilih kontak.
  `GET /tenants/{id}` tetap satu-satunya sumber status langganan.
- (2 Nov 2026) Pembayaran langganan memakai **QRIS dinamis**. Panel
  "Langganan" menampilkan harga periode dari `tenant.billing` (server),
  menawarkan tombol "Tampilkan QR pembayaran" ke owner, lalu menampilkan
  gambar QRIS bernominal beserta batas waktu tagihan. QRIS tidak punya callback:
  status lunas hanya ditetapkan operator platform setelah dana terverifikasi,
  dan UI tidak pernah menandai lunas sendiri. Bila server belum dikonfigurasi
  (`paymentEnabled: false`), panel kembali ke jalur manual WhatsApp yang sudah
  ada — tidak ada tagihan Rp0 atau nomor/nominal karangan.

## Urutan pekerjaan berikutnya (sesuai backlog Sprint 4)

1. ~~Kontrak publik~~ — sudah ada (lihat Update 29 Okt 2026 di atas): katalog
   publik + detail produk, booking tamu, dan `GET /portal/orders/{token}`.
2. ~~Frontend penyewa~~ — halaman katalog publik, booking, dan portal pesanan
   sudah ada (`app/katalog`, `app/t/[slug]/katalog`, `app/portal/[token]`).
3. ~~Konfigurasi tenant~~ — nomor WhatsApp, instruksi rekening, dan gambar
   QRIS tersedia di settings dan sudah ditampilkan pada portal/katalog.
4. ~~Pendaftaran~~ — field 09/04 (`ownerName`, `tenantName`, `tenantSlug`) sudah
   diteruskan controller, divalidasi, dikirim form, dan dipakai sebagai prefill
   onboarding (29 Okt 2026). Persetujuan legal selesai 28 Okt 2026.
5. **Pemeriksaan kerusakan**: setting tenant + nominal per produk + form
   kondisi awal/akhir setelah kontrak 15 tersedia.
6. ~~Perpanjangan dari portal~~ — kontrak, backend, dan form di halaman
   `app/portal/[token]` sudah lengkap (29 Okt 2026), termasuk tampilan status
   permintaan.

## Verifikasi audit ini (snapshot 21 Oktober 2026)

Angka di bawah adalah catatan saat audit 21 Oktober 2026, bukan status terkini.
Hasil ukur terbaru (31 Oktober 2026) ada di §Verifikasi badge perpanjangan &
konflik: **135 tes web (20 file)**, **401 tes API (30 file)**, `next build` 31
route (27 statis).

| Perintah | Hasil |
| --- | --- |
| `tsc --noEmit` | lulus |
| `eslint "src/**/*.{ts,tsx}" "e2e/**/*.ts"` | 0 error, 0 warning |
| `vitest run` | 103 tes lulus (15 file) |
| `next build` | lulus, 27 route |

Belum dijalankan ulang: E2E Playwright (butuh dev server), uji dengan backend
aktif, audit aksesibilitas/screen reader, dan pengukuran Core Web Vitals.
