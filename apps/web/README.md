# Rentalio — Frontend (`apps/web`)

Frontend Rentalio: satu aplikasi Next.js (App Router) berisi pengalaman **desktop** dan **mobile**
yang terpisah pada level shell/navigasi, plus katalog publik dan PWA terbatas.
Semua data operasional berasal dari REST API backend (`docs/openapi.yaml`); UI tidak pernah
menjadi sumber kebenaran untuk harga, stok, permission, status pembayaran, atau status langganan.

## Stack

- Next.js 16 (App Router) + React 19 + TypeScript strict.
- Tanpa framework UI eksternal: design tokens CSS + komponen bersama di `src/shared/ui`.
- Validasi form: Zod (`src/shared/validation/schemas.ts`). Backend tetap validator utama.
- Tes: Vitest + Testing Library (unit/component), Playwright (E2E).
- Tipe API dihasilkan dari OpenAPI: `pnpm --filter @rentalio/web openapi:types`.

## Struktur

```
src/
  app/            route App Router (publik, auth, /app/*, legal, offline)
  desktop/        shell + navigasi desktop
  mobile/         shell + navigasi mobile (bottom tabs + drawer)
  features/       kode per domain (auth, inventory, bookings, pos, orders, returns, settings, ...)
  shared/
    api/          client fetch terpusat, endpoint, error mapping, tipe OpenAPI
    auth/         sesi (cookie HttpOnly + CSRF), permission/matriks role
    config/       NAV_GROUPS + ROUTE_MATRIX (peta route & role)
    format/       format Rupiah, tanggal/jam + zona waktu tenant, label status
    hooks/        useApi, useMediaQuery
    layout/       app shell, public shell, tenant switcher
    ui/           tombol, form, panel/tabel, dialog, toast, tab, state
    validation/   skema form Zod
    styles/       tokens.css + base.css

docs/state-matrix.md   matriks state + acceptance criteria per fitur
```

## Menjalankan lokal (Windows & Linux)

Baseline: Node.js **26.1.0**, pnpm **11.9.0** (tanpa Docker).

```bash
pnpm install
cp apps/web/.env.example apps/web/.env.local   # PowerShell: Copy-Item apps/web/.env.example apps/web/.env.local
pnpm --filter @rentalio/web dev                  # http://localhost:3001
```

Environment `apps/web/.env.local`:

| Variabel | Fungsi |
| --- | --- |
| `API_INTERNAL_URL` | target rewrite server-side `/api/v1/*` → backend (default `http://localhost:3000`). Tidak masuk bundle browser. |
| `NEXT_PUBLIC_APP_URL` | origin aplikasi untuk metadata/tautan absolut. |
| `NEXT_PUBLIC_PLATFORM_ROOT_DOMAIN` | domain platform (default `rentalio.my.id`); subdomain langsung di bawahnya dibaca sebagai slug tenant. |
| `NEXT_PUBLIC_DEFAULT_TENANT_SLUG` | slug tenant default untuk `/katalog` bila host bukan subdomain tenant maupun domain kustom. |
| `SUPPORT_WHATSAPP` | nomor WhatsApp tim Rentalio (digit) untuk tautan perpanjangan/upgrade langganan di Pengaturan usaha. Dibaca server saat request (bukan `NEXT_PUBLIC_*`), jadi mengganti nomor cukup restart proses tanpa build ulang. Kosong → WhatsApp membuka pemilih kontak. |

Jangan menaruh secret backend (API key Resend, `DATABASE_URL`, kredensial R2, dsb.) di env frontend:
semua `NEXT_PUBLIC_*` ikut terkirim ke browser. Variabel tanpa prefix itu (`API_INTERNAL_URL`,
`SUPPORT_WHATSAPP`) hanya dibaca di sisi server; nilainya bisa berubah tanpa build ulang.

Perintah lain:

```bash
pnpm --filter @rentalio/web lint
pnpm --filter @rentalio/web typecheck
pnpm --filter @rentalio/web test        # Vitest
pnpm --filter @rentalio/web test:e2e    # Playwright (butuh backend berjalan)
pnpm --filter @rentalio/web build
```

## Peta route

| Route | Akses | Keterangan |
| --- | --- | --- |
| `/` | publik | Landing marketing pada host platform; pada host tenant (subdomain/`{slug}.localhost`/domain kustom terverifikasi) langsung menampilkan katalog tenant tersebut |
| `/katalog`, `/t/[slug]/katalog` | publik | Katalog tenant, cek ketersediaan server, CTA WhatsApp; `/katalog` mengikuti host, `/t/[slug]` eksplisit |
| `/login`, `/register` | publik | Layout split-screen: panel merek + formulir |
| `/register/verify` | publik | Verifikasi OTP (cooldown 60 dtk, 5 percobaan) |
| `/forgot-password`, `/reset-password` | publik | Permintaan reset generik + form reset token |
| `/invitations/accept` | publik + sesi | Terima undangan staf |
| `/app/onboarding` | sesi | Lengkapi data tenant setelah verifikasi |
| `/app` | `order.create` | Ringkasan operasional |
| `/app/bookings` | `order.create` | Kalender + reservasi (setujui/tolak/konversi) |
| `/app/orders`, `/app/orders/[orderId]` | `order.create` | Pesanan + antrean perpanjangan menunggu keputusan (setujui/tolak), panel pembayaran, deposit, pengembalian, inspeksi, perpanjangan; menu Pesanan memuat badge jumlah permintaan yang menunggu (peran dengan `rental.extension.approve`) yang ikut berubah setelah keputusan tanpa pindah halaman |
| `/app/pos` | `order.create` | Kasir: keranjang, periode, deposit, metode pembayaran aktif |
| `/app/returns` | `order.return` | Pengembalian & inspeksi kondisi |
| `/app/conflicts` | `rental.extension.resolve_conflict` | Tugas penyelesaian konflik perpanjangan; menu memuat badge jumlah konflik OPEN (tone bahaya, ikut turun setelah ditandai selesai); badge dan halaman berbagi satu request lewat cache singkat |
| `/app/inventory`, `/app/inventory/[productId]` | `catalog.write` | Produk, tarif, unit fisik, maintenance |
| `/app/categories` | `catalog.write` | Kategori |
| `/app/reports` | `report.read` | Rekap operasional |
| `/app/settings` | `settings.payment_methods.manage` | Identitas tenant, mode booking, policy katalog/perpanjangan |
| `/app/settings/payment-methods` | idem | Matriks metode × konteks transaksi |
| `/app/settings/whatsapp-templates` | `settings.whatsapp_templates.manage` | Template per konteks × metode × tujuan |
| `/app/settings/staff` | OWNER | Undang/ubah staf |
| `/offline`, `/legal/terms`, `/legal/privacy` | publik | Halaman PWA offline dan dokumen legal |

Matriks route → permission/aksi lengkap ada di [`src/shared/config/navigation.ts`](src/shared/config/navigation.ts)
(`ROUTE_MATRIX`), dan permission default per role di
[`src/shared/auth/permissions.ts`](src/shared/auth/permissions.ts). Menyembunyikan menu **bukan**
kontrol keamanan: backend tetap memeriksa membership, status tenant, dan permission.

## Pola implementasi yang dipakai

- **Sesi**: cookie HttpOnly dari backend, tidak dibaca JavaScript. Mutasi mengirim `X-CSRF-Token`
  yang diambil dari `/auth/csrf`; 401 memicu `rentalio:unauthenticated` → kembali ke `/login?next=…`.
- **Tenant context**: daftar tenant berasal dari API; tenant terpilih disimpan di cookie non-sensitif
  dan selalu divalidasi ulang backend. Ganti tenant memuat ulang detail tenant.
- **Error API**: dipetakan ke pesan yang bisa ditindaklanjuti (`403` ≠ data kosong, `409` konflik
  stok/periode, `422` validasi, `429` coba lagi, timeout/putus koneksi → status tidak diketahui).
- **State**: setiap halaman punya loading/skeleton, empty, error+retry, dan sukses. Submit dicegah
  ganda (`loading` pada tombol), dan dialog konfirmasi menjelaskan konsekuensi spesifik.
- **Format**: Rupiah (`formatIDR`), tanggal/jam dengan zona waktu tenant (`formatDateTime`,
  `isoToZonedLocal`, `zonedLocalToIso`), label status terpusat (`status.ts`). Tidak ada format
  hard-coded di komponen.
- **Status terpisah**: booking/persetujuan, alokasi/lifecycle, pembayaran, deposit, dan perpanjangan
  ditampilkan sebagai badge berbeda.
- **WhatsApp**: semua pesan click-to-chat (prefill) dengan template per konteks × metode × tujuan;
  membuka WhatsApp tidak pernah mengubah status pembayaran.
- **Langganan**: tombol bayar memanggil `POST /tenants/{id}/subscription-invoices` lalu menampilkan QRIS
  dinamis bernominal (gambar QR dari server). QRIS tidak punya callback: UI tidak pernah menandai lunas
  sendiri, status diperbarui operator platform, dan jalur manual (WhatsApp) tampil bila server
  melaporkan `billing.paymentEnabled: false`.
- **Landing & auth**: landing memakai animasi CSS + `Reveal` (IntersectionObserver) yang dimatikan
  otomatis pada `prefers-reduced-motion`; konten tetap tampil tanpa JS. Katalog tenant tidak
  ditautkan dari landing — pintu masuknya host tenant (subdomain `{slug}.rentalio.my.id`, domain kustom
  terverifikasi, atau `/t/{slug}/katalog`). Resolusi host ada di `src/shared/config/hosts.ts` dan
  `src/shared/api/public-tenant.ts`; domain kustom dipetakan lewat API (`/public/resolve-host`),
  bukan ditebak di browser. Keputusan stok kosong
  Opsi A/B dipusatkan di `src/features/catalog/policy.ts` (Opsi A menerima `PENDING_APPROVAL`,
  Opsi B memblokir booking dan menawarkan WhatsApp). Login dan daftar memakai
  layout split-screen (`AuthSplit`): panel merek di kiri, formulir di kanan; panel disembunyikan di
  layar kecil.
- **PWA**: `public/manifest.webmanifest` + `public/sw.js` yang hanya meng-cache aset statis dan
  halaman `/offline`; respons API/auth/tenant tidak masuk cache. Aksi finansial diblokir saat offline.

## Status pengujian

- `tsc --noEmit`, `eslint "src/**/*.{ts,tsx}"`, dan `vitest run` **135 tes (20 file)** lulus
  (diperiksa 31 Oktober 2026). Cakupan badge navigasi yang ikut terjaga:
  `src/features/dashboard/overview.test.tsx` (Ringkasan dan badge konflik berbagi satu request
  ringkasan), `src/features/conflicts/conflict-overview-cache.test.ts` + `open-conflict-count.test.tsx`
  (cache, single-flight, dan badge turun tanpa navigasi), serta
  `src/features/orders/pending-extension-count.test.tsx` (badge antrean perpanjangan).
  Status langganan juga dijaga `subscription-summary.test.ts` (badge + kalimat per `reason`) dan
  `subscription-request.test.ts` (tautan pengajuan perpanjangan/upgrade, termasuk fallback tanpa
  nomor tujuan).
  `next build` (production) juga lulus pada pemeriksaan yang sama: 31 route, 27 di antaranya
  dirender statis — `/app/settings` sengaja dinamis (`force-dynamic`) agar `SUPPORT_WHATSAPP`
  dibaca dari environment server saat request, bukan saat build.
- E2E Playwright `e2e/public.spec.ts` **lulus 14 tes** pada project desktop + mobile, 2 tes dilewati
  (diukur ulang 30 Oktober 2026). Jalankan terhadap server yang sudah hidup:

  ```bash
  E2E_BASE_URL=http://localhost:3001 pnpm --filter @rentalio/web exec playwright test e2e/public.spec.ts
  ```

  Tes alur masuk → ringkasan dilewati kecuali `E2E_EMAIL`, `E2E_PASSWORD`, dan backend aktif tersedia.
- **Sesi E2E dibagi lewat `storageState`.** Project `setup` ([e2e/auth.setup.ts](e2e/auth.setup.ts))
  login **sekali** lalu menyimpan sesi ke `e2e/.auth/state.json` (git-ignored); `desktop` dan `mobile`
  bergantung pada project itu, dan spec yang butuh sesi memakai
  `test.use({ storageState })` — tidak ada lagi login ulang per project. Ini perlu karena API
  membatasi login ke **5 percobaan per akun / 15 menit** (`loginAccount`), yang sebelumnya membuat
  project kedua gagal `429` sebelum satu tes pun berjalan. Kredensial fixture memakai
  `E2E_EMAIL`/`E2E_PASSWORD` dengan fallback `demo@rentalio.test`.
- **Satu-satunya login per suite ada di project `setup`.** `audit_all_features.spec.ts` ikut memakai
  sesi tersimpan dan tidak lagi mengisi form masuk; pengujian halaman masuk dipindah ke
  [e2e/login-form.spec.ts](e2e/login-form.spec.ts), yang sengaja **tidak** mengirim kredensial valid
  agar tidak menambah percobaan login.
- **Seluruh isi `e2e/` hijau** setelah `pnpm qa:seed:e2e` (pengukuran 9 November 2026):
  **desktop 23 lulus / 0 gagal / 2 dilewati**, **mobile 22 lulus / 0 gagal / 2 dilewati**.
  Dua yang dilewati adalah alur masuk → ringkasan di `public.spec.ts` (butuh
  `E2E_EMAIL`/`E2E_PASSWORD`) dan `billing_qris.spec.ts` (butuh `EMAIL_PROVIDER=dev-file`).
- **Fixture E2E dibuat oleh skrip, bukan data manual.** Suite membutuhkan akun
  `demo@rentalio.test`, tenant `demo-sewa` ("Rental Kamera Bandung"), dua kategori, tiga produk
  (Canon EOS R50, DJI Mic 2, Sony A7 III), serta langganan aktif — `catalog_editor.spec.ts` tes 9
  menyimpan draf dan ditolak server (`403 TENANT_RESTRICTED`) bila tenant hanya punya trial habis.
  Sediakan seluruhnya dengan satu perintah idempoten:

  ```bash
  pnpm qa:seed:e2e            # ulangi kapan saja; tidak menambah baris duplikat
  pnpm qa:seed:e2e --dry-run  # hanya menampilkan rencana
  ```

  Skrip (`database/prisma/seed-e2e.mjs`) membuat user ACTIVE + email terverifikasi, tenant, membership
  OWNER, subscription ACTIVE 365 hari (plan platform `free`), kategori/produk/rate/aset, dan menyetel
  ulang password fixture bila hash lama tidak cocok. Jalankan setelah `pnpm --filter @rentalio/database build`.
- **Artefak tes ditulis ke `test-results/`** melalui `testInfo.outputPath()` (git-ignored), sehingga
  suite portabel di mesin lain dan CI — tidak ada path absolut di spec.
- `audit_all_features.spec.ts` lulus penuh (13 titik, desktop + mobile). Assertion status langganan
  di sidebar menerima salah satu state yang dikenal — `Coba gratis N hari lagi`, `Masa coba habis
  hari ini`, `Paket aktif`, `Toko ditangguhkan` — bukan satu nilai tetap, sehingga tur tidak patah
  saat trial tenant demo berakhir atau langganan berubah.

  Selector id blok (`#ce-edit-btn-hero` kini bersufiks, mis. `ce-edit-btn-hero-1`) dan teks konfirmasi
  simpan sudah diperbaiki; dengan langganan demo aktif, tes 1–12 lulus di kedua project.

  `pnpm --filter @rentalio/web test:e2e` menjalankan **semua** spec; untuk spec publik saja gunakan
  perintah berpola di atas.
- Matriks state dan acceptance criteria per fitur: [docs/state-matrix.md](docs/state-matrix.md).
- Audit keselarasan terhadap dokumentasi Notion (keputusan, gap, dan item yang
  terblokir kontrak): [docs/notion-alignment.md](docs/notion-alignment.md).
- Bukti verifikasi badge perpanjangan/konflik, data QA yang bisa diulang, dan hasil suite API:
  [docs/notion-alignment.md § Verifikasi badge perpanjangan & konflik — 30 Oktober 2026](docs/notion-alignment.md#verifikasi-badge-perpanjangan--konflik--30-oktober-2026).
- Audit aksesibilitas dengan screen reader, uji perangkat nyata, visual regression, dan pengukuran
  Core Web Vitals belum dilakukan.

## Belum termasuk (menunggu kontrak/backlog)

- Billing SaaS (paket/trial/upgrade) — belum ada endpoint di OpenAPI; UI hanya menampilkan status
  tenant dan alasan mode terbatas.
- Portal penyewa berbasis token (`/portal`), editor visual katalog, unggah foto produk via presigned
  URL R2, ekspor PDF/CSV, dan impor inventaris CSV/XLSX.
- Admin Platform (`admin.rentalio.my.id`) adalah aplikasi terpisah dan tidak dibangun di sini.
