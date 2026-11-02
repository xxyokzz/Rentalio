# Matriks state & acceptance criteria per fitur

Dokumen kerja frontend Rentalio (`apps/web`). Artefak ini melengkapi
[09 — Panduan Pengembangan Frontend](https://app.notion.com/p/3f691fc2859381ff8314eaa9972ae745):
setiap layar dipetakan ke route, operasi API, permission UX, state yang wajib
ditangani, dan acceptance criteria yang bisa diuji.

Dokumen ini **tidak** menyatakan fitur lulus. Status bukti pengujian ada di
bagian [Bukti pengujian](#bukti-pengujian); kotak yang belum terbukti dibiarkan
terbuka.

Semua path API tenant memakai prefix `/api/v1/tenants/{tenantId}`; di bawah ini
prefix tersebut ditulis singkat sebagai `{t}`.

## Kosakata state

| State | Kapan muncul | Perilaku UI yang dipakai |
| --- | --- | --- |
| `loading` | permintaan pertama belum selesai | skeleton `LoadingBlock` (bukan spinner penuh layar yang menutupi konteks) |
| `loading-ulang` | data lama ada, permintaan baru berjalan | konten tetap tampil, tombol aksi `loading` untuk mutasi |
| `empty` | respons sukses tetapi tanpa baris | `EmptyState` dengan penjelasan berikutnya, bukan tabel kosong |
| `sukses` | aksi selesai | toast `notify(..., "success")` + data dimuat ulang dari server |
| `error` | 4xx/5xx/jaringan | `InlineAlert`/`ErrorState` berisi pesan yang bisa ditindaklanjuti + tombol `Coba lagi` (`state.reload`) |
| `forbidden` | 403 / permission tidak ada | menu & tombol disembunyikan lewat `can(role, permission)`; 403 ditampilkan sebagai "akses ditolak", bukan data kosong |
| `conflict` | 409 (stok/periode/perpanjangan) | pesan konflik spesifik + opsi memuat ulang ketersediaan sebelum mencoba lagi |
| `offline` | `navigator.onLine === false` | banner/indikator offline + halaman `/offline`; aksi finansial tidak diklaim berhasil |
| `timeout`/`tidak-diketahui` | request timeout atau koneksi putus di tengah mutasi | pesan "status tidak diketahui, periksa di server" — tidak ada retry otomatis transaksi |
| `restricted` | tenant dalam mode terbatas (trial habis) | `RestrictedBanner` + tombol pembuatan booking/order/POS dinonaktifkan, alur penyelesaian order tetap tersedia |

Komponen bersama: `QueryState` (loading → error+retry → empty → konten),
`InlineAlert`, `EmptyState`, `ErrorState`, `LoadingBlock`, `ConfirmDialog`
(konsekuensi spesifik + alasan wajib bila aturan bisnis menuntut), `useToast`.

## Matriks per fitur

### 0. Landing publik

- Route: `/` (`src/features/marketing/landing-page.tsx`), tanpa panggilan API.
- Izin: publik.

| State | Perilaku |
| --- | --- |
| loading | tidak ada (konten statis); animasi hero berjalan saat mount |
| reveal | section muncul saat masuk viewport (`IntersectionObserver`); konten tetap terlihat tanpa JS karena animasi hanya aktif setelah `data-reveal="ready"` |
| reduced motion | semua animasi/transisi landing dimatikan lewat `prefers-reduced-motion` |
| responsif | dua kolom → satu kolom di bawah 980px; grid kartu satu kolom di bawah 640px |
| navigasi | header hanya menautkan Masuk dan Daftar owner; katalog tenant sengaja tidak ditautkan dari landing |

- [ ] AC: CTA utama menuju `/register` dan CTA sekunder menuju `/login`.
- [ ] AC: tidak ada tautan "Katalog" di header maupun section katalog di landing.
- [ ] AC: visual ketersediaan diberi label "Ilustrasi tampilan, bukan data nyata" dan tidak menampilkan metrik palsu.
- [ ] AC: reduced motion tidak memunculkan animasi apa pun dan seluruh teks tetap terbaca.

### 1. Masuk (login)

- Route: `/login` (`src/features/auth/login-page.tsx`, `login-form.tsx`)
- API: `POST /auth/sessions`, `GET /auth/sessions/current`, `GET /auth/csrf`
- Izin: publik

| State | Perilaku |
| --- | --- |
| loading | tombol "Masuk" `loading`, input nonaktif |
| error validasi | pesan per field + `aria-invalid` + `aria-describedby` |
| error server | `InlineAlert` generik (tidak membedakan akun tidak ada vs password salah) |
| sukses | redirect ke `next` atau `/app`, sesi dimuat ulang |
| offline/timeout | pesan koneksi, bukan "password salah" |

- [ ] AC: submit ganda dicegah (tombol `loading`).
- [ ] AC: email tidak valid ditolak di klien tanpa mengirim request.
- [ ] AC: pesan error tidak membocorkan keberadaan akun.
- [ ] AC: `?next=` hanya menerima path internal (tidak open redirect).

### 2. Daftar owner + verifikasi OTP

- Route: `/register`, `/register/verify` (`register-form.tsx`, `otp-form.tsx`)
- API: `POST /auth/registrations`, `POST /auth/registrations/verify-email`,
  `POST /auth/registrations/resend-otp`
- Kontrak API saat ini hanya menerima `email` + `password`
  (`RegisterRequest` di `docs/openapi.yaml`); field nama pemilik/nama bisnis/subdomain
  dari baseline desain belum ada di schema sehingga belum dikirim.

| State | Perilaku |
| --- | --- |
| loading | tombol kirim `loading` |
| error validasi | password < 12 karakter, konfirmasi tidak cocok, syarat layanan belum dicentang (role `alert`, `aria-invalid` pada checkbox) |
| sukses | email disimpan sebagai `pendingEmail`, lanjut ke layar OTP |
| OTP | countdown 10 menit, cooldown kirim ulang 60 detik, penghitung 5 percobaan |
| error OTP | kode salah/kedaluwarsa/limit/resend-too-soon/rate-limited/jaringan dipisah pesannya, tanpa enumerasi |
| gagal kirim email | pesan retry aman; akun tidak diklaim aktif |

- [ ] AC: cooldown & sisa percobaan tampil, server tetap sumber kebenaran.
- [ ] AC: OTP bisa di-paste dan hanya menerima 6 digit.
- [ ] AC: OTP/password tidak masuk log, analytics, atau storage.

### 3. Lupa & reset kata sandi

- Route: `/forgot-password`, `/reset-password` (`password-reset-forms.tsx`)
- API: `POST /auth/password-resets`, `POST /auth/password-resets/complete`

| State | Perilaku |
| --- | --- |
| loading | tombol `loading` |
| sukses permintaan | pesan generik "bila email terdaftar, tautan dikirim" |
| token invalid/used | pesan khusus + tautan meminta tautan baru |
| rate limited | pesan tunggu + `Retry-After` bila tersedia |
| sukses reset | redirect ke `/login`, sesi lama dianggap dicabut |

- [ ] AC: respons permintaan identik untuk email terdaftar/tidak.
- [ ] AC: token reset tidak ditulis ke log/telemetry.

### 4. Terima undangan staf

- Route: `/invitations/accept` (`invitation-form.tsx`)
- API: `POST /auth/invitations/accept`, `GET /tenants`
- State: loading, token tidak valid/kedaluwarsa, sudah pernah diterima, sukses → `markAnonymous()` lalu login ulang.

### 5. Onboarding owner

- Route: `/app/onboarding` (`onboarding-form.tsx`)
- API: `POST /tenants`, `PATCH /tenants/{tenantId}`
- State: loading, slug tidak tersedia/slug invalid (400), konflik slug (409), sukses → pilih tenant dan lanjut `/app`.

### 6. Ringkasan operasional (dashboard)

- Route: `/app` (`dashboard/overview.tsx`)
- API: `{t}/orders`, `{t}/products`, `{t}/reservations`, `GET /tenants/{tenantId}`
- State: skeleton, empty ("belum ada aktivitas"), error+retry, `restricted` banner.
- [ ] AC: status booking, lifecycle, dan pembayaran tampil terpisah; angka berasal dari API (tidak ada KPI dekoratif).

### 7. Kalender booking & reservasi

- Route: `/app/bookings` (`bookings-page.tsx`, `create-reservation-dialog.tsx`, `booking-calendar.tsx`)
- API: `{t}/reservations` (GET/POST), `{t}/reservations/{id}/confirm|reject|cancel|convert-to-order`, `{t}/availability`
- Izin: `order.create`, `reservation.create/approve/cancel`
- State: skeleton, empty ("belum ada reservasi"), error+retry, 409 stok habis (dialog menampilkan konflik + cek ulang ketersediaan), 403 tombol setujui/tolak disembunyikan.
- [ ] AC: konfirmasi manual menampilkan status `PENDING_APPROVAL` sebelum disetujui; konversi ke pesanan hanya dari reservasi `CONFIRMED`.

### 8. POS (kasir)

- Route: `/app/pos` (`pos-page.tsx`)
- API: `{t}/products`, `{t}/payment-methods`, `{t}/reservations`
- Izin: `order.create`
- State: pencarian kosong, keranjang kosong, metode pembayaran nonaktif tidak ditawarkan, error 409 (stok), error 402/403 mode terbatas, submit `loading`.
- [ ] AC: total & deposit adalah estimasi berlabel sampai server mengonfirmasi; WhatsApp hanya menyiapkan pesan; tidak ada metode nonaktif di UI.
- [ ] AC: stok kosong mengikuti policy tenant — Opsi A mengirim `PENDING_APPROVAL` tanpa alokasi, Opsi B memblokir booking dan menampilkan WhatsApp.

### 9. Pesanan & detail pesanan

- Route: `/app/orders`, `/app/orders/[orderId]` (`orders-page.tsx`, `order-detail.tsx`)
- API: `{t}/orders`, `{t}/orders/{id}`, `{t}/orders/{id}/ready-for-handover|handover|complete`
- State: pagination server-side, empty, error+retry, aksi per status lifecycle, 403 per aksi.
- [ ] AC: aksi yang tidak valid untuk status tidak ditampilkan; nomor pesanan immutable dipakai di semua panel.

### 10. Pembayaran

- Panel: `orders/payments-panel.tsx`
- API: `{t}/orders/{id}/payments` (GET/POST), `{t}/payments/{paymentId}/void`, `{t}/orders/{id}/refunds`, `{t}/refunds/{refundId}/approve|record-result`
- Izin: `payment.record`, `payment.void`
- State: loading, empty, error, `loading` per tombol.
- [ ] AC: mencatat/menekan tombol WhatsApp tidak mengubah status menjadi lunas; void meminta alasan dan tersimpan di audit.

### 11. Deposit & refund

- Panel: `orders/deposit-panel.tsx`
- API: `{t}/orders/{id}/deposits` (GET/POST), `{t}/orders/{id}/deposit-deductions`, `{t}/deposit-deductions/{requestId}/approve|reject`, `{t}/orders/{id}/deposit-refunds`, `{t}/orders/{id}/deposit-movements/{movementId}/reverse`
- State: 403 untuk approval, 409 bila melebihi saldo deposit, konfirmasi menjelaskan dampak finansial.
- [ ] AC: potongan butuh alasan; approval terpisah dari pengajuan; refund tidak menghapus histori.

### 12. Pengembalian & inspeksi

- Route: `/app/returns`, panel `orders/returns-panel.tsx`
- API: `{t}/orders/{id}/returns` (GET/POST), `{t}/returns/{returnId}/complete|cancel`, `{t}/orders/{id}/inspections` (GET/POST), `{t}/inspections/{inspectionId}/submit|decision`
- Izin: `order.return`, `order.inspect`
- State: loading, empty, error+retry, 409 transisi state tidak valid, dialog konfirmasi kondisi.
- [ ] AC: kondisi awal vs akhir dan nominal denda ditampilkan sebelum keputusan; menyetujui denda tidak berarti sudah dibayar.

### 13. Perpanjangan sewa & konflik

- Panel: `orders/extensions-panel.tsx`; halaman `conflicts/conflicts-page.tsx` di `/app/conflicts`
- API: `{t}/orders/{id}/extensions` (GET/POST), `{t}/orders/{id}/extensions/{extensionId}/approve|reject|override-conflict`, `{t}/orders/{id}/extensions/{extensionId}/conflicts/{conflictId}/resolve`, `{t}/extension-conflicts?status=`
- Izin: `rental.extension.request|approve|override_conflict`, `rental.extension.resolve_conflict`
- State: tombol ajukan hanya bila toggle tenant aktif; konflik ditampilkan sebagai dialog risiko (bukan sukses); override butuh alasan + konfirmasi eksplisit; 403 bila permission khusus tidak ada.
- [ ] AC: perpanjangan dinyatakan efektif hanya setelah server menyetujui + alokasi; pembayaran tetap terpisah.

### 14. Inventaris, tarif, unit, maintenance

- Route: `/app/inventory`, `/app/inventory/[productId]` (`products-page.tsx`, `product-detail.tsx`), `/app/categories`
- API: `{t}/products` (GET/POST), `{t}/products/{id}` (GET/PATCH), `{t}/products/{id}/deactivate`, `{t}/products/{id}/rates` (GET/PUT), `{t}/products/{id}/assets` (GET/POST), `{t}/assets/{assetId}` (PATCH), `{t}/assets/{assetId}/maintenance` (GET/POST), `{t}/categories` (GET/POST), `{t}/categories/{categoryId}` (PATCH/DELETE)
- State: skeleton, empty, error+retry, 422 validasi, 409 slug/nama duplikat, 403 tombol dinonaktifkan.
- [ ] AC: unit fisik individual dibedakan dari stok kuantitas; tarif per hari disimpan sebagai integer rupiah.

### 15. Laporan

- Route: `/app/reports` (`reports-page.tsx`)
- API: `{t}/orders` (page size besar, agregasi di klien dengan label jelas)
- Izin: `report.read`
- State: loading, empty, error+retry.
- [ ] AC: angka adalah rekap dari data server; ekspor PDF/CSV belum tersedia (dicatat sebagai gap).

### 16. Pengaturan usaha

- Route: `/app/settings` (`tenant-settings.tsx`)
- API: `GET /tenants/{tenantId}` (melalui sesi), `PATCH /tenants/{tenantId}/settings`
- Izin: `settings.payment_methods.manage` (praktis OWNER/MANAGER sesuai permission backend)
- State: loading tenant, error sesi, draft lokal hanya untuk field yang diubah, sukses → refresh + reset draft.
- [ ] AC: opsi B menampilkan peringatan overlap; toggle perpanjangan tidak menghapus policy A/B.
- [ ] AC: panel "Langganan" menampilkan status dari `subscription` server (bukan tanggal trial). Bila
  `tenant.billing.paymentEnabled` true, owner melihat harga periode + tombol "Tampilkan QR pembayaran"
  yang memuat QRIS dinamis bernominal, serta batas waktu tagihan `PENDING`; status lunas hanya ditetapkan
  operator platform dan tombol "Cek status pembayaran" memuat ulang data server. Bila pembayaran belum
  dikonfigurasi, panel menampilkan jalur manual WhatsApp (nomor dari `SUPPORT_WHATSAPP` di environment
  server; halaman `force-dynamic`) tanpa nominal/nomor karangan.

### 17. Metode pembayaran

- Route: `/app/settings/payment-methods` (`payment-methods-page.tsx`)
- API: `{t}/payment-methods` (GET/PUT)
- State: loading matriks, error simpan, validasi "setiap konteks minimal satu metode aktif".
- [ ] AC: matriks diturunkan dari server + perubahan lokal; perubahan hanya berlaku untuk transaksi baru.

### 18. Template WhatsApp

- Route: `/app/settings/whatsapp-templates` (`whatsapp-templates-page.tsx`)
- API: `{t}/whatsapp-templates` (GET/POST), `{t}/whatsapp-templates/{id}` (GET/PATCH), `{t}/whatsapp-templates/{id}/restore-default`, `{t}/whatsapp-templates/preview`
- State: loading, empty, error, preview gagal (placeholder tidak dikenal), sukses simpan/pulihkan.
- [ ] AC: placeholder divalidasi; variabel kosong tidak menghasilkan `undefined`; template nonaktif tidak ditawarkan di alur transaksi.

### 19. Staf & akses

- Route: `/app/settings/staff` (`staff-page.tsx`)
- API: `{t}/members` (GET/POST/undang), `{t}/members/{userId}` (PATCH)
- Izin: OWNER (`canManageMembers`)
- State: 403 untuk non-owner, error undangan (email sudah anggota), sukses menampilkan status undangan.

### 20. Katalog publik

- Route: `/`, `/katalog`, `/t/[slug]/katalog` (`catalog-page.tsx`, `shared/layout/public-shell.tsx`)
- Titik masuk: host tenant (subdomain `{slug}.rentalio.my.id`, `{slug}.localhost`, atau domain kustom terverifikasi) membuka katalog langsung di `/` dan `/katalog`; landing dan header publik tidak menautkan katalog (keputusan produk).
- Resolusi host: `shared/config/hosts.ts` (parsing) + `shared/api/public-tenant.ts` (lookup server-side ke `GET /public/resolve-host`, `cache()` per request). Domain kustom hanya aktif bila `tenant_domains.isActive`, `verifiedAt` terisi, dan tenant `ACTIVE`; selain itu 404 netral.
- API: `/public/{slug}/catalog`, `/public/{slug}/products/{id}`, `/public/{slug}/availability`, `/public/{slug}/bookings`, `/portal/orders/{token}` (kontrak OpenAPI tag `Public`/`portal`).
- State: memuat, katalog kosong (pesan jelas), ketersediaan tidak tersedia (opsi A: minta `PENDING_APPROVAL`; opsi B: tombol "Tanyakan via WhatsApp"), error kontrak (menjelaskan endpoint belum tersedia, bukan data palsu), offline.
- [ ] AC: tidak ada checkout gateway; WhatsApp click-to-chat; angka stok dari server.
- [ ] AC: stok kosong tidak membalik policy — Opsi A (`CHECK_AVAILABILITY`) tetap menerima permintaan `PENDING_APPROVAL`, Opsi B (`SKIP_AVAILABILITY`) memblokir booking.

### 21. PWA & offline

- Route: `/offline`, `public/manifest.webmanifest`, `public/sw.js`
- State: indikator offline, halaman offline informatif, cache hanya aset statis.
- [ ] AC: respons API/auth/tenant tidak masuk cache; aksi finansial tidak diklaim berhasil saat offline; SW punya strategi update/fallback.

### 22. Mode terbatas (trial/subscription)

- Komponen: `subscription/restricted-banner.tsx`
- State: banner alasan + tombol pembuatan baru dinonaktifkan; baca inventaris/laporan dan penyelesaian order tetap jalan.
- [ ] AC: UI mengikuti status dari server; tombol bayar hanya muncul bila `tenant.billing.paymentEnabled` true
  dan tetap tidak menandai lunas sendiri (status dari webhook).

## Bukti pengujian

Dijalankan di `apps/web` (diukur ulang 31 Oktober 2026):

| Perintah | Hasil |
| --- | --- |
| `tsc --noEmit` | lulus |
| `eslint "src/**/*.{ts,tsx}"` (skrip `lint`; `e2e/` belum masuk cakupan eslint) | 0 error, 0 warning |
| `vitest run` | 135 tes lulus (20 file) — format Rupiah/tanggal, error API, skema validasi, navigasi/role, komponen panel, policy katalog A/B, badge antrean perpanjangan & konflik, serta banner, label sidebar, ringkasan Pengaturan, dan tautan pengajuan perpanjangan per status `subscription` |
| `next build` | lulus, 31 route (27 dirender statis; `/app/settings` dinamis untuk membaca `SUPPORT_WHATSAPP` saat request) |
| `E2E_BASE_URL=http://localhost:3001 playwright test e2e/public.spec.ts` | **14 lulus, 2 dilewati** (desktop + mobile) |
| `E2E_BASE_URL=http://localhost:3001 playwright test` (semua `e2e/`) | **45 lulus, 0 gagal, 2 dilewati** (47 eksekusi termasuk project `setup`) — lihat catatan di bawah |

E2E yang lulus: landing, manifest PWA, halaman offline, validasi email login,
validasi persetujuan syarat pada registrasi (termasuk `role="alert"` +
`aria-invalid`), dan katalog tanpa sesi.

Dilewati: alur masuk → ringkasan (`public.spec.ts`), karena butuh
`E2E_EMAIL`, `E2E_PASSWORD`, dan backend + database aktif.

Sesi E2E dibagi: project `setup` (`e2e/auth.setup.ts`) login sekali dan menyimpan `storageState` ke
`e2e/.auth/state.json`, lalu `desktop`/`mobile` memakainya — termasuk `audit_all_features.spec.ts`.
Tanpa ini, login berulang per project melewati batas 5 login/akun per 15 menit dan memunculkan
`429`. Form masuk diuji terpisah di `e2e/login-form.spec.ts` tanpa mengirim kredensial valid,
sehingga satu suite hanya melakukan satu login.

Suite penuh (30 Oktober 2026) kini hijau kecuali dua tes yang memang dilewati. Dua hal yang
sebelumnya membuatnya merah, keduanya terikat tenant demo (`demo@rentalio.test`, slug `demo-sewa`):

- `catalog_editor.spec.ts` tes 9 (desktop + mobile) menyimpan draf, dan command katalog ditolak
  `403 TENANT_RESTRICTED` bila tenant hanya punya trial yang habis. Fixture langganan aktif
  (`node database/prisma/activate_demo_subscription.mjs`, idempoten, plan `free`, periode 1 tahun)
  membuat tes 9–12 berjalan; tanpa langganan aktif tes 9 gagal dan tes 10–12 tidak jalan.
- `audit_all_features.spec.ts` (desktop + mobile) lulus **13 titik**: assertion status langganan
  menerima state yang dikenal (`Coba gratis N hari lagi`, `Masa coba habis hari ini`, `Paket aktif`,
  `Toko ditangguhkan`) alih-alih satu nilai trial, jadi tur tetap jalan ketika trial berakhir atau
  langganan berubah.

Selector id blok lama (`#ce-edit-btn-hero`, sekarang bersufiks `ce-edit-btn-hero-1`) dan teks
konfirmasi simpan di spec tersebut sudah diperbaiki; tes 1–8 kini lulus di kedua project.

Belum ada bukti untuk: alur booking/POS/pembayaran/pengembalian end-to-end,
audit kontras & screen reader, uji perangkat nyata, visual regression, dan
Core Web Vitals.

## Gap yang belum diimplementasikan

Billing SaaS (paket/upgrade), portal penyewa berbasis token, editor visual &
branding katalog, verifikasi domain kustom, upload foto via presigned URL R2,
ekspor PDF/CSV, impor inventaris CSV/XLSX, notifikasi, dan Admin Platform
(`admin.rentalio.my.id`, aplikasi terpisah).
