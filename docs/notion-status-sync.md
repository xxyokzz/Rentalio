# Sinkronisasi status Notion ↔ kode — 27 Oktober – 16 November 2026

Dokumen kerja hasil pemeriksaan ulang seluruh dokumentasi Notion proyek Rentalio
terhadap kondisi kode di workspace ini. Sumber spec: dokumen Notion 04, 06, 07,
08, 12, 13, 15, 16, 17. Sumber bukti: perintah yang benar-benar dijalankan di
workspace ini (Windows, Node.js 26.1.0, pnpm 11.9.0, PostgreSQL 18.4 lokal,
role runtime `sewain_dev`).

Pembaruan audit 28 Oktober: permission OpenAPI per operasi dan retry transaksi
PostgreSQL `40P01`/`40001` telah ditambahkan; gate terkait dijalankan ulang di bawah.

Dokumen ini **tidak** menyatakan fitur siap produksi; ia hanya memisahkan mana
yang sudah terbukti jalan lokal dan mana yang belum dikerjakan.

## Bukti eksekusi (dijalankan ulang setelah perbaikan di bawah)

| Perintah | Hasil |
| --- | --- |
| `pnpm openapi:validate` | lulus — OpenAPI 3.1.1, **108 path / 135 operasi**, semua operasi memiliki `x-required-permission`, 1 endpoint `future` |
| `pnpm typecheck` | lulus (apps/api, apps/web, database) |
| `pnpm lint` | lulus, 0 error / 0 warning |
| `pnpm build` | lulus (NestJS + Next.js) — **sebelumnya gagal**, lihat §Perbaikan |
| `pnpm --filter @rentalio/api test:unit` | **69 lulus** (9 file), termasuk periode langganan, pengingat tagihan, dan konversi/validasi QRIS |
| `pnpm --filter @rentalio/api test:integration` | **347 lulus** (23 file) terhadap PostgreSQL nyata, termasuk retry SQLSTATE `40P01`/`40001`, 7 test billing QRIS, dan 5 test pengingat tagihan |
| `pnpm --filter @rentalio/web test` | **135 lulus** (20 file) |
| **Total** | **551 test lulus** (69 unit + 347 integration + 135 web) |
| migrasi dari database kosong | **31 migrasi** terpasang berurutan |

> Baris frontend diukur ulang 31 Oktober 2026: 135 tes / 20 file (naik dari 103 / 15
> setelah test regresi badge perpanjangan & konflik, lalu 15 test banner + label
> sidebar, 7 test ringkasan status langganan, dan 5 test tautan pengajuan
> perpanjangan, lalu 3 test panel pembayaran QRIS di Pengaturan usaha). API bertambah test pada 31 Okt 2026
> (periode langganan + billing), lalu diganti menjadi suite QRIS pada 2 Nov 2026
> (unit konversi/validasi QRIS dan integrasi billing: `POST` tagihan idempoten,
> settle operator, replay, permission admin, isolasi cookie, dan tagihan
> kedaluwarsa). Assertion `GET /tenants/:id` juga mencakup field `billing`.
>
> 2 November 2026: billing Xendit diganti QRIS dinamis. Test rekonsiliasi
> tagihan (unit + integrasi) dihapus karena tidak ada provider yang dipolling;
> diganti suite QRIS (konversi/validasi + settle operator via Admin Platform).
> Ditambah pengingat tagihan ke operator (job worker + 4 unit test penyusun
> pesan dan 5 test integrasi idempotensi/retry) karena QRIS tidak memberi
> callback pembayaran.
>
> 16 November 2026: suite penuh dijalankan ulang lewat CI pada commit `2875108`
> — `apps/api` **42 file / 517 test** dan `apps/web` **20 file / 137 test**
> lulus, `pnpm openapi:validate` melaporkan 113 path / 140 operasi, dan migrasi
> dari database kosong kini **34 migrasi**. Angka pada tabel di atas adalah
> hasil audit 31 Okt–2 Nov dan sengaja dibiarkan sebagai riwayat.

Satu endpoint yang secara resmi masih `x-implementation-status: future`:
`POST /tenants/{tenantId}/inspections/{inspectionId}/attachments`.

## Perbaikan yang dikerjakan pada audit ini

Lima bug nyata; tiga di antaranya memblokir total.

1. **Build frontend gagal total.** `apps/web/src/shared/styles/base.css` memakai
   `)` sebagai penutup dua blok aturan (baris 4307 dan 4398) sehingga
   `next build` berhenti dengan error PostCSS. Diperbaiki menjadi `}`.
2. **`pnpm api:dev` tidak bisa dijalankan di Windows.**
   `apps/api/scripts/dev.mjs` memanggil `spawn('pnpm.cmd', …)`; sejak Node 20.12
   (perbaikan CVE-2024-27980) spawn berkas `.cmd` tanpa shell melempar `EINVAL`.
   Sekarang `tsc` dijalankan lewat `process.execPath` +
   `require.resolve('typescript/bin/tsc')`.
3. **P0 — tenant hasil registrasi tidak dapat dipakai sama sekali.**
   `POST /auth/registrations/verify-email` membuat tenant secara inline tanpa
   `activatedAt`/`trialEndsAt`, tanpa baris subscription, dan tanpa 9 template
   WhatsApp bawaan. Akibatnya `SubscriptionPolicyService` mengembalikan
   `NO_ENTITLEMENT` dan **semua** mutasi katalog/booking/order ditolak
   `403 TENANT_RESTRICTED` — owner baru tidak bisa menambah satu produk pun.
   Jalur inline tersebut juga membuat `/app/onboarding` (hanya tampil saat actor
   belum punya tenant) tidak pernah tercapai, sehingga nama toko, slug, dan zona
   waktu tidak pernah bisa ditentukan. Sekarang verifikasi email hanya
   mengaktifkan akun; pembuatan tenant sepenuhnya lewat
   `TenantService.createTenant` (`POST /tenants`) yang sudah benar. Alur
   registrasi → onboarding → produk pertama diuji ulang melalui UI.
4. **Subscription `TRIALING` tidak pernah dibuat pada database bersih.**
   `createTenant` mencari plan `code='free'`, sedangkan seed dev hanya membuat
   `trial-72h` dan tidak ada migrasi yang memasang plan platform. Karena
   `subscriptions.planId` NOT NULL, pembuatan subscription dilewati diam-diam
   (reconciler tidak punya baris untuk diproses). Ditambahkan migrasi
   `20261027130000_default_platform_plan` (idempoten) dan seed diselaraskan.
5. **Skrip seed tidak dapat dijalankan.** `database/prisma/seed.mjs` mengimpor
   `../prisma/generated/client/index.js` yang tidak pernah ada
   (`ERR_MODULE_NOT_FOUND`) dan memakai `upsert` pada unique gabungan
   ber-`tenantId` null (ditolak Prisma). Sekarang memakai entry build package
   dan `findFirst` + `create`; sudah diuji idempoten.

Test yang ditambahkan: konsumsi paralel token reset password
(`auth.integration.test.ts`) dan regresi P0 provisioning tenant baru
(`tenant.integration.test.ts`).

## Pembaruan 28 Oktober 2026

Dua pekerjaan lanjutan, keduanya sudah terpasang di Notion:

1. **`duplicate` template WhatsApp (menutup kotak QA dokumen 08).** Endpoint
   `POST /tenants/{tenantId}/whatsapp-templates/{templateId}/duplicate` beserta
   skema `DuplicateWhatsAppTemplateRequest` di `docs/openapi.yaml`.
   Perilaku: salinan versi 1 dengan body yang sama ke kombinasi konteks ×
   metode × tujuan lain, nama default `"<nama sumber> (salinan)"` (maks 120
   karakter), `isActive` mengikuti sumber bila tidak dispesifikkan, template
   sumber tidak diubah. Kombinasi tujuan terisi → 422, sumber hilang → 404,
   MANAGER/lintas-tenant → 403, tanpa sesi → 401, tanpa CSRF → 403. Audit
   `WHATSAPP_TEMPLATE_DUPLICATED` + snapshot versi `TEMPLATE_DUPLICATED`.
   Test baru: 3 test di `whatsapp-templates.integration.test.ts`.
2. **Bukti persetujuan legal saat registrasi OWNER (dokumen 04).**
   `RegisterRequest` kini mewajibkan `termsAccepted: true`, `termsVersion`,
   `privacyVersion`; backend menyimpannya di kolom baru
   `users.termsConsentVersion` / `users.privacyConsentVersion` /
   `users.legalConsentAt` (migrasi `20261028090000_user_legal_consent`, timestamp
   server) dan mencatat versinya pada audit `OWNER_SIGNUP_STARTED`. Form
   registrasi + halaman `/legal/terms` dan `/legal/privacy` memakai versi dari
   `apps/web/src/shared/config/legal.ts`. Test baru: 3 test di
   `auth.integration.test.ts` (bukti tersimpan, tanpa persetujuan → 400 tanpa
   baris user, nilai tidak valid → 400). Terverifikasi juga lewat UI di browser:
   `POST /auth/registrations` → 202 dan ketiga kolom terisi di `sewain_dev`.

## Pembaruan 29 Oktober 2026 — fondasi Admin Platform (PLAT-01/07)

Fondasi identitas, sesi, dan otorisasi Admin Platform sudah terpasang. Ruang
lingkupnya sengaja dibatasi pada fondasi; direktori tenant, announcement
center, dan promo **belum** termasuk.

- **Database.** Migrasi `20261028100000_platform_admin_identity`: tabel
  `platform_admin_users`, `platform_roles`, `platform_permissions`,
  `platform_admin_roles`, `platform_role_permissions`,
  `platform_admin_login_challenges`, `platform_admin_sessions`,
  `platform_admin_recovery_codes`, dan `platform_audit_events` (append-only via
  trigger). Role matrix di-seed di migrasi, jadi otorisasi runtime membaca baris
  database — bukan daftar hardcode di kode.
- **Sesi terpisah.** Cookie `rentalio_platform_admin` (HttpOnly, host-only,
  SameSite=Lax) hanya diterbitkan setelah password + TOTP. `rentalio_session`
  (tenant) tidak pernah menjadi bukti identitas admin; integration test
  membuktikan kedua arah penolakan.
- **MFA.** TOTP RFC 6238 (SHA-1, 6 digit, 30 detik, jendela ±1 langkah) dengan
  proteksi replay per langkah waktu; secret disimpan terenkripsi AES-256-GCM
  memakai `PLATFORM_ADMIN_ENCRYPTION_KEY`; 10 kode pemulihan sekali pakai
  dikembalikan hanya saat enrollment. Challenge 5 menit, maks 5 percobaan.
- **RBAC deny-by-default.** `@RequirePlatformPermission(...)` wajib ada pada
  handler; tanpa deklarasi → 403. Permission dihitung backend dari role
  assignment yang tidak dicabut pada setiap request.
- **Bootstrap aman.** `pnpm --filter @rentalio/api admin:bootstrap` — interaktif,
  password tanpa echo dan tanpa argumen CLI, konfirmasi `BOOTSTRAP`, advisory
  lock, dan hanya berhasil bila belum ada admin platform. Tidak ada endpoint
  HTTP untuk bootstrap.
- **Kontrak.** Enam operasi `/platform-admin/*` + skema
  `PlatformAdmin{Challenge,LoginResponse,SessionResponse,Principal}` di
  `docs/openapi.yaml`; validator OpenAPI lulus (93 path, 118 operasi kala itu;
  kontrak akhir 29 Okt setelah direktori, audit viewer, aksi status, assignment
  role, direktori admin, portal perpanjangan, `/me`, direktori pelanggan, dan
  billing langganan QRIS: **108 path / 135 operasi**).
- **Test baru.** 10 unit test TOTP/enkripsi (`platform-admin-crypto`), 10 unit
  test guard (`platform-admin-guards`), dan integration test
  `platform-admin.integration.test.ts` (bootstrap sekali, anti-enumerasi,
  enrollment, pemisahan cookie dua arah, CSRF/Origin, kode pemulihan).
- **Direktori tenant (lanjutan 29 Okt 2026).** `GET /platform-admin/tenants`
  dengan permission `platform.tenants.list`, paginasi `page`/`pageSize`, filter
  `status`, dan pencarian nama/slug. Migrasi
  `20261029100000_platform_admin_tenant_directory` menambah policy RLS
  **SELECT saja** pada `tenants` untuk konteks `app.platform_admin`
  (`PrismaService.withPlatformAdmin`); tabel tenant-scoped lain tetap tertutup
  dan context tidak bocor keluar transaksi (diuji). Setiap halaman menulis
  `PLATFORM_TENANT_DIRECTORY_VIEWED` di transaksi yang sama; role tanpa
  permission ditolak `403 PERMISSION_DENIED` (diuji dengan role buatan yang
  hanya punya `platform.dashboard.read`).
- **Audit viewer.** `GET /platform-admin/audit-events` dengan permission
  `platform.audit.read`, filter `actorAdminId` (UUID), `action` (allowlist 16
  aksi yang dikenal), dan `from`/`to` inklusif; `from > to` → 400, paginasi
  stabil dengan `id` sebagai tiebreaker. Membaca log sengaja tidak menulis
  event baru (menghindari pertumbuhan log tanpa batas/log flooding) dan respons
  `no-store`. Diuji 7 test: urutan terbaru-dulu, filter aksi (SUCCESS+FAILED),
  filter aktor, filter waktu, filter invalid, paginasi tanpa duplikasi, serta
  401 cookie tenant dan 403 role tanpa `platform.audit.read`.
- **Aksi status tenant.** `POST /platform-admin/tenants/:id/suspend` dan
  `/reactivate` dengan permission terpisah (`platform.tenants.suspend`,
  `platform.tenants.reactivate`), wajib `reason` 10–500 karakter + CSRF +
  Origin admin. Transisi dibatasi `ACTIVE`/`PENDING_ACTIVATION → SUSPENDED` dan
  `SUSPENDED → ACTIVE`; `CLOSED` final; selain itu `409`. Migrasi
  `20261029110000_platform_admin_tenant_status` menambah policy UPDATE untuk
  konteks `app.platform_admin` plus trigger yang menolak perubahan kolom selain
  `status`/`updatedAt` (diuji: percobaan ubah `name` lewat konteks admin
  ditolak database). Audit mencatat alasan, `fromStatus`/`toStatus`, dan
  `metadata.denial` untuk penolakan; perubahan memakai kunci optimistik status
  sumber sehingga dua admin paralel tidak menghasilkan dua transisi sah. Diuji
  10 test tambahan.
- **Ringkasan tenant.** `GET /platform-admin/tenants/:id` dengan permission
  terpisah `platform.tenants.read_summary`: identitas bisnis, status, zona
  waktu, mata uang, dan periode trial — tanpa kontak pemilik, anggota, atau
  transaksi. Setiap pembacaan (sukses maupun gagal: id bukan UUID → 400, UUID
  tak dikenal → 404)  menulis `PLATFORM_TENANT_SUMMARY_VIEWED` dengan
  `outcome`/`metadata.found`, sehingga percobaan enumerasi id oleh admin tetap
  meninggalkan jejak. Diuji 4 test tambahan (field minimum, no-store, 400/404,
  audit sukses+gagal, dan 403 untuk role tanpa `read_summary`).
- **Assignment role admin.** `POST /platform-admin/admins/:id/roles/assign` dan
  `/revoke` dengan dua permission terpisah (`platform.roles.assign`,
  `platform.roles.revoke`), wajib `reason` 10–500 karakter + CSRF + Origin
  admin, `roleCode` divalidasi terhadap `platform_roles` (tak dikenal → 404,
  id bukan UUID → 400). Transisi: assignment aktif → 409; revoke menyimpan
  `revokedAt` tanpa menghapus baris (riwayat tetap ada); assign ulang setelah
  revoke menghidupkan baris yang sama karena unique `(adminUserId, roleId)`.
  Mutasi + audit satu transaksi (`PLATFORM_ADMIN_ROLE_ASSIGNED`/
  `PLATFORM_ADMIN_ROLE_REVOKED`, sukses maupun `FAILED` + `metadata.denial`),
  dan permission efektif sesi dihitung ulang dari DB setiap request sehingga
  perubahan langsung terasa. Diuji 12 test: validasi alasan/kode, CSRF/Origin,
  pemisahan permission assign vs revoke (403 masing-masing), assign sukses +
  audit, perubahan permission efektif naik/turun, assign ulang 409, revoke
  sukses + revoke kedua 409, re-assign tanpa duplikat, 404/400 diaudit, filter
  audit viewer untuk aksi baru, dan 401 cookie tenant.
- **Proteksi anti-lockout + direktori admin (lanjutan 29 Okt 2026).** Dua
  aturan baru di dalam transaksi assign/revoke, keduanya ditolak
  `422 BUSINESS_RULE_VIOLATION` dan tetap tercatat audit `FAILED` +
  `metadata.denial`: `SELF_ASSIGNMENT` (admin tidak boleh menugaskan role ke
  diri sendiri — mencegah eskalasi privilese mandiri, terlepas dari punya
  `platform.roles.assign`) dan `LAST_SUPER_ADMIN` (penugasan
  `PLATFORM_SUPER_ADMIN` terakhir tidak dapat dicabut). Pemeriksaan terakhir
  memakai `SELECT … FOR UPDATE` urut `id` pada baris super admin aktif di
  transaksi yang sama, sehingga dua pencabutan bersamaan diserialisasi dan
  jumlah super admin tidak pernah jatuh ke nol. `GET /platform-admin/admins`
  dan `/admins/:id` dengan permission `platform.roles.read`, filter `q`
  (email) + paginasi: daftar menampilkan identitas minimal + role aktif per
  admin — riwayat penugasan tercabut tidak ikut, hash password/secret TOTP
  tidak pernah bocor — dan setiap halaman menulis
  `PLATFORM_ADMIN_DIRECTORY_VIEWED`; detail menambahkan permission efektif
  hasil gabungan role aktif serta menulis `PLATFORM_ADMIN_DETAIL_VIEWED` untuk
  pembacaan sukses maupun gagal (bukan UUID → 400, tak dikenal → 404, keduanya
  `outcome: FAILED`). OpenAPI: 2 path + 4 skema baru, allowlist aksi audit
  menjadi 16, respons `422` pada assign/revoke; README menambah 2 baris
  endpoint + paragraf anti-lockout. Diuji 8 test tambahan — 3 anti-lockout
  (self-assign 422, SUPER_ADMIN terakhir 422 + assignment tetap aktif, kontrol
  positif dua SUPER_ADMIN → revoke 200) dan 5 direktori (role aktif tanpa
  riwayat tercabut + `no-store` + audit, 403 tanpa permission + 401 cookie
  tenant, detail permission efektif, 400/404 diaudit FAILED, filter audit
  viewer untuk aksi baru).
- **Profil pendaftaran untuk prefill onboarding (lanjutan 29 Okt 2026).**
  `RegisterDto` memvalidasi tiga field dokumen 04 — `ownerName` (1–120),
  `tenantName` (1–100), dan `tenantSlug` (3–63 dengan regex yang sama persis
  `CreateTenantDto`) — dan controller kini meneruskan ketiganya ke service;
  nilai dinormalisasi (nama di-trim, slug lowercase) sebelum disimpan ke
  `users`, string kosong diperlakukan sebagai “tidak diisi”. `POST /auth/sessions`
  dan `GET /auth/sessions/current` mengembalikan ketiganya pada objek `user`
  (null bila tidak diisi), sehingga form registrasi bisa mengirim data profil
  (slug opsional + usulan otomatis dari nama toko) dan halaman onboarding
  memprefill nama toko + link katalog dari profil sesi — keunikan slug tetap
  ditegakkan `POST /tenants` (409 saat onboarding, bukan saat mendaftar).
  Kontrak: `RegisterRequest` + `SessionResponse` diperbarui di
  `docs/openapi.yaml` dan `pnpm --filter @rentalio/web openapi:types` dijalankan
  ulang. Diuji 5 test integrasi baru (penyimpanan profil, validasi format → 400
  tanpa baris user, profil di login + sesi, null tanpa profil, pembaruan saat
  daftar ulang) + unit test  `ownerNameSchema`.
- **Perpanjangan dari portal (29 Okt 2026).** `POST /portal/orders/{token}/extensions`
  ditambahkan ke kontrak dan backend. Token portal hanya membuka satu pesanan;
  inti aturan `ExtensionsService` dipakai bersama jalur internal — flag
  `rentalExtensionEnabled`, order `ACTIVE` dengan reservasi sumber, periode baru
  harus lebih lama, dan hanya satu permintaan `PENDING_APPROVAL` — sehingga
  tidak ada jalur kedua yang bisa melewati validasi. `requestedByUserId` dan
  aktor audit bernilai `null` (`metadata.source = "PORTAL"`); biaya tetap
  dihitung server dari Rate/snapshot item. Respons `Cache-Control: no-store`,
  rate limit IP portal, 422 saat fitur nonaktif, 409 saat pesanan belum dibuat
  atau masih ada permintaan pending, 404 untuk token tidak valid. Diuji 4 test
  integrasi (pengajuan + audit + persetujuan staff yang memperbarui total order,
  permintaan ganda 409, fitur nonaktif/order belum ada/token salah, tanggal
  tidak memperpanjang 400).
- **Akun & direktori pelanggan (29 Okt 2026).** `GET /me` mengembalikan profil
  akun aktif (status, waktu verifikasi, profil pendaftaran) + ringkasan
  membership aktif tanpa hash/secret, dan hanya membaca akun milik sesi.
  `GET/POST /tenants/{tenantId}/customers` menambah direktori pelanggan dengan
  permission baru `customer.read`/`customer.write` (default MANAGER & STAFF
  keduanya, CASHIER baca saja), pencarian `q` case-insensitive, paginasi
  `limit`/`offset`, normalisasi email lowercase, dan penolakan 422 untuk
  email/nomor yang sudah dipakai di tenant yang sama (dengan `details.customerId`).
  Diuji 6 test integrasi (401 tanpa sesi, profil + membership, CRUD + pencarian
  + paginasi, duplikat 422, isolasi lintas tenant, CASHIER baca saja + CSRF).

## Pembaruan 16 November 2026 — inspeksi kerusakan & denda kondisi (dokumen 15)

Butir “pemeriksaan kerusakan & denda” pada daftar *Belum ada sama sekali*
sudah tidak berlaku. Inspeksi pasca-return kini punya saklar sendiri dan denda
kondisi yang bisa diatur owner, mengikuti pola denda keterlambatan
(commit `2875108`). Ruang lingkupnya: pengaturan + usulan otomatis, **bukan**
penagihan otomatis.

- **Pengaturan tenant** (`GET`/`PATCH /tenants/{tenantId}`).
  `damageInspectionEnabled` (default `true`, supaya alur serah-terima yang
  sudah berjalan tidak berubah), `damageFeeEnabled` (default `false`), dan
  nominal per tingkat kondisi `damageFeeMinorAmount` (ringan),
  `damageFeeModerateAmount` (sedang), `damageFeeSevereAmount` (parah) — IDR
  rupiah utuh dengan CHECK non-negatif. Migrasi
  `20261116090000_tenant_damage_fee` menambah enum `DamageSeverity`
  (`MINOR`/`MODERATE`/`SEVERE`), lima kolom tenant, dan tiga kolom inspeksi.
- **Validasi server.** Menyalakan denda kondisi ditolak `400
  VALIDATION_ERROR` bila inspeksi belum aktif atau ketiga nominal masih nol;
  nominal negatif ditolak validasi DTO. Mematikan saklar tidak menghapus
  nominal tersimpan.
- **Saklar inspeksi.** `POST /orders/{orderId}/inspections` menjawab `422
  BUSINESS_RULE_VIOLATION` saat `damageInspectionEnabled` mati; pencatatan
  pengembalian tetap berjalan.
- **Snapshot.** Konfigurasi denda disalin ke `inspections.damagePolicySnapshot`
  (JSONB) saat inspeksi dibuat. Mengubah nominal setelahnya tidak menulis
  ulang inspeksi yang berjalan: `submit` menghitung usulan dari snapshot, bukan
  dari konfigurasi tenant terkini. Snapshot lama/rusak dibaca sebagai kebijakan
  nonaktif, bukan error.
- **Usulan denda otomatis.** `POST .../inspections` dan `PATCH
  .../inspections/{id}/submit` menerima `severity`; server mengisi
  `suggestedPenaltyAmount` dan objek `damageFee` (`enabled`, `severity`,
  `label`, `amount`, `amounts`). Usulan tetap terpisah dari `penaltyAmount`:
  keputusan `APPROVE` masih wajib menyebut nominal final, tidak menagih
  otomatis, dan tidak memotong deposit. Audit `INSPECTION_CREATED` dan
  `INSPECTION_SUBMITTED` mencatat `severity` + `suggestedPenaltyAmount`.
- **Kontrak & UI.** `docs/openapi.yaml` menambah field tenant, request
  `severity`, `suggestedPenaltyAmount`, dan skema `DamageFeeResponse`;
  `types.generated.ts` diregenerasi. Pengaturan usaha mendapat panel “Inspeksi &
  denda kerusakan” (dua saklar + tiga nominal), dan panel pengembalian
  menampilkan tingkat kondisi, usulan, serta prefill dialog pengajuan.

### Bukti eksekusi fitur ini

| Perintah / bukti | Hasil |
| --- | --- |
| `pnpm --filter @rentalio/api exec vitest run test/unit/damage-fee.test.ts test/unit/late-fee.test.ts test/integration/returns.integration.test.ts` | **45 lulus** (3 file): 8 unit `damage-fee` (baru), 6 unit `late-fee`, 31 integrasi `returns` (26 lama + 5 baru) |
| `pnpm --filter @rentalio/api typecheck` / `@rentalio/web` / `@rentalio/admin` / `@rentalio/database` | lulus |
| `pnpm openapi:validate` | lulus — OpenAPI 3.1.1, **113 path / 140 operasi**, skema 3.1 valid |
| `pnpm --filter @rentalio/web openapi:types` | `types.generated.ts` diperbarui dari kontrak |
| CI GitHub Actions run `43899349779` (push `main`, commit `2875108`) | **success** — actionlint, validasi OpenAPI, typecheck, lint, build, unit+integration (`apps/api` **42 file / 517 test**), e2e Playwright desktop, `apps/web` **20 file / 137 test** |
| migrasi dari database kosong (global setup test) | **34 migrasi** terpasang berurutan, termasuk `20261116090000_tenant_damage_fee` |

Lima test integrasi baru: konfigurasi invalid (tanpa inspeksi / semua nol /
negatif → 400, simpan sukses, nominal tetap ada saat dimatikan), inspeksi
ditolak saat saklar mati lalu diterima setelah diaktifkan, usulan dari
`severity` + snapshot beku saat nominal diubah, usulan kosong saat denda
nonaktif, dan `severity` tak dikenal → 400 sementara inspeksi tanpa `severity`
tetap berjalan tanpa usulan.

**Belum termasuk (kondisi saat commit `2875108`):** lampiran foto masih
`future` dan belum ada test web baru. Keduanya sudah ditutup pada pembaruan
berikutnya.

## Pembaruan 16 November 2026 — kelanjutan denda kerusakan (12 butir)

Dua belas butir follow-up di atas dikerjakan berurutan. Prinsip yang tidak
berubah: server menghitung semua nominal (IDR integer utuh), denda hanya
**usulan/tagihan tercatat** — tidak menagih otomatis dan tidak memotong deposit
tanpa persetujuan kedua. Migrasi struktural:
`20261116150000_damage_fee_followup` (tabel `order_penalties`,
`inspection_items`, `damage_fee_revisions`, `damage_fee_category_amounts`,
kolom `tenants.damageFeeMaxAmount`, `deposit_deduction_requests.inspectionId`
unik; semuanya dengan GRANT + RLS per tenant).

1. **Tagihan denda order** — `POST /tenants/{tenantId}/orders/{orderId}/penalties`.
   Nominal diambil dari `inspection.penaltyAmount` (bukan body), hanya untuk
   inspeksi `APPROVED`, dan idempoten per inspeksi (unik + `findFirst`),
   sehingga klik ganda tidak menagih dua kali. `OrderResponse` menambah
   `penalties[]`, `penaltyTotalAmount`, dan `amountDue`; `totalAmount` sewa
   tidak diubah. Audit `ORDER_PENALTY_CREATED` hanya sekali.
2. **Keputusan inspeksi → potongan deposit** — `DepositDeductionRequest`
   menerima `inspectionId` opsional. Server menolak `400` bila nominal tidak
   sama dengan denda inspeksi dan `422` bila inspeksi itu sudah pernah
   dipakai. Alur dua langkah lama tetap: `PENDING` → approve aktor lain.
3. **Lampiran foto inspeksi** — `POST .../inspections/{inspectionId}/attachments`
   kini `implemented`. `objectKey` wajib berprefix
   `tenants/{tenantId}/inspections/`, MIME JPEG/PNG/WebP/PDF, maks 10 MB,
   maksimal 10 lampiran, inspeksi `REJECTED` ditolak.
4. **Tingkat kondisi per item** — `items[]` pada create/submit berisi
   `productId`, `assetId`, `quantity`, `severity`, `note`. Validasi memastikan
   item benar milik order. Total usulan = jumlah usulan baris (dengan
   kuantitas); tingkat inspeksi mengikuti baris terberat.
5. **Plafon denda** — `damageFeeMaxAmount` per tenant. Usulan di atas plafon
   dipotong dan ditandai `damageFee.capped` + `rawAmount` (angka sebelum
   plafon) agar UI bisa memperingatkan.
6. **Usulan gabungan dihitung server** — `suggestedTotal { damageFee, lateFee,
   total }` pada setiap respons inspeksi; UI tidak menjumlahkan sendiri.
7. **Test** — unit `damage-fee` diperluas (plafon, agregasi baris, override
   kategori, snapshot) dan file integrasi baru
   `damage-fee-followup.integration.test.ts` (9 test) menutup tagihan,
   deposit, lampiran, per-item/plafon, satu inspeksi aktif, riwayat, kategori,
   laporan, dan pesan WhatsApp. Test web baru mengunci perilaku plafon di
   pengaturan (nilai terkirim integer; kosong → `null`).
8. **Riwayat kebijakan** — `damage_fee_revisions` ditulis setiap pengaturan
   denda berubah; `GET /tenants/{tenantId}/damage-fee-revisions` (terbaru
   dulu). Inspeksi lama tetap memakai snapshot-nya, bukan revisi terbaru.
9. **Satu inspeksi aktif per order** — inspeksi `DRAFT`/`SUBMITTED` kedua
   ditolak `422 BUSINESS_RULE_VIOLATION`, sehingga usulan ganda tidak mungkin.
10. **Pesan WhatsApp hasil inspeksi** — `GET
    .../inspections/{inspectionId}/whatsapp-message` menyusun teks siap-salin
    (rincian item + nominal, catatan, total, status keputusan) dari data
    terkini. Inspeksi `DRAFT` ditolak `409` karena hasil belum diajukan.
    Kesengajaan: **tidak** memakai `PaymentContext`, karena enum itu khusus
    instruksi/konfirmasi pembayaran; pesan ini murni komposisi data.
11. **Laporan denda kerusakan** — `GET
    /tenants/{tenantId}/reports/damage-fees` (permission `report.read`,
    filter `from`/`to`): denda tertagih (`count`, `totalAmount`), jumlah
    inspeksi per status, agregat per tingkat kerusakan, dan produk teratas.
12. **Tarif per kategori produk** — `GET`/`PUT
    /tenants/{tenantId}/damage-fee-categories`. Override kategori menang atas
    nominal tenant saat inspeksi dibuat; kategori tenant lain ditolak.

**UI.** Panel pengembalian menampilkan usulan gabungan server, catatan
“dipotong plafon”, rincian kerusakan per item saat membuat inspeksi, tombol
“Catat denda”, “Potong deposit”, dan “Salin WhatsApp”; pengaturan usaha
mendapat input plafon.

**Belum termasuk:** layar pengaturan untuk nominal per kategori (API sudah
ada, UI belum) dan e2e Playwright khusus alur inspeksi — alur baru terbukti
lewat integrasi API dan test komponen web, bukan e2e baru.

### Bukti eksekusi kelanjutan

| Perintah / bukti | Hasil |
| --- | --- |
| `pnpm --filter @rentalio/api exec vitest run test/integration/damage-fee-followup.integration.test.ts` | **9 lulus** (tagihan, deposit, lampiran, per-item+plafon, guardrail, riwayat+kategori, laporan, pesan WhatsApp) |
| `pnpm --filter @rentalio/api test` | **43 file / 532 test lulus** (termasuk 14 unit `damage-fee`) |
| `pnpm --filter @rentalio/web test` | **20 file / 139 test lulus** (2 test plafon baru) |
| `pnpm --filter @rentalio/api typecheck` + `lint`, `@rentalio/web typecheck` + `lint` | lulus |
| `pnpm openapi:validate` | lulus — OpenAPI 3.1.1, **118 path / 146 operasi**, skema 3.1 valid, 0 endpoint future |
| migrasi dari database kosong (global setup test) | **35 migrasi** terpasang berurutan, termasuk `20261116150000_damage_fee_followup` |

**Catatan rilis:** dua migrasi denda (`20261116090000_tenant_damage_fee`,
`20261116150000_damage_fee_followup`) harus diterapkan lewat jalur rilis
sebelum kode API yang memakai kolom/tabel baru tayang.

## Yang dinyatakan sudah dikerjakan (dan dicentang di Notion)

- **Dokumen 04** — acceptance checklist OpenAPI final (dokumen, enum/transisi
  tanpa PATCH status bebas, tenant isolation + restricted mode, perhitungan
  server-side, penandaan endpoint future, validasi kontrak) dan Definition of
  Ready auth (kecuali retensi audit).
- **Dokumen 13** — A27 (UI/UX desktop & mobile), B6 (batas MVP), dan dua gate
  kriteria mulai coding (environment/lint/typecheck/test/build/CI; kontrak
  transaksi/idempotency/ledger sudah menjadi test yang dapat dijalankan).
- **Dokumen 06** — allowlist cache PWA dan konfigurasi R2 server-side.
- **Dokumen 08** — 51 checkbox QA: state machine terpisah, booking otomatis
  atomik, penolakan transisi ilegal, refund terpisah dari deposit, trial 72 jam
  + grace 3 hari, seluruh skenario override konflik Opsi B, permission matrix
  (termasuk STAFF/CASHIER), OTP 5 percobaan + konsumsi paralel, CSRF negatif,
  larangan token di browser storage, migration dari database kosong, tenant
  isolation, double booking/kuantitas, backup-restore, dan no-hardcode harga.
- **Dokumen 08 (baru, 27 Okt 2026)** — dua request reset password paralel
  dengan token sama menghasilkan paling banyak satu sukses.
- **Dokumen 08 (baru, 28 Okt 2026)** — kotak "Template WhatsApp mendukung CRUD,
  duplicate, activate/deactivate, restore-default, preview, version history,
  placeholder allowlist, permission, audit, dan tenant isolation" dicentang
  setelah endpoint `duplicate` diimplementasikan dan diuji.

## Yang belum dikerjakan

### Belum ada sama sekali

1. **Billing/langganan SaaS** — `GET /plans`, `POST /subscriptions`,
   `GET /subscriptions/current`. Tagihan tenant → Rentalio (QRIS dinamis) dan
   settle manual oleh operator platform sudah ada; model
   `Plan`/`Subscription`/`SubscriptionEvent` masih dipakai internal, belum
   diekspos sebagai endpoint.
2. **Admin Platform (dokumen 17, PLAT-01…08)** — fondasi identitas/sesi/MFA/
   RBAC/CLI/bootstrap dan **direktori tenant read-only** sudah ada (lihat
   pembaruan 29 Okt 2026). Yang belum: aplikasi `admin.rentalio.my.id`, direktori
   akun, announcement center, promo, dan dashboard.
   Per 3 Nov 2026 sudah ada juga: halaman admin & role, suspend/reactivate tenant,
   audit viewer, dan settle tagihan QRIS. Rincian gap dan urutan task ada di
   [`docs/admin-platform-backlog.md`](./admin-platform-backlog.md).
3. **Manajemen domain kustom** — `GET/POST /tenants/:id/domains`,
   `POST /domains/:id/verify`, status domain, instruksi DNS, TLS.
4. **Laporan/invoice/ekspor/impor** — `/reports/finance`, `/reports/operations`,
   `/invoices`, `/reports/exports`, `/inventory/imports`.
5. **Kontrak & akun** — sisa kelompok ini: `POST /contracts/:id/accept`,
   aksi akun lanjutan (ubah profil/kata sandi), `GET /calendar`, dan
   `POST /orders/:id/penalties`. `GET /me`, `GET/POST /customers`, dan
   `POST /portal/orders/{token}/extensions` sudah ada (pembaruan 29 Okt 2026);
   `POST /orders/:id/penalties` sudah ada (pembaruan 16 Nov 2026, kelanjutan).
6. **Media produk & branding** — metadata gambar, publikasi eksplisit,
   penyambungan ke storefront, dan presigned **download**.
7. **Katalog editor/template (WEB-07)** — fondasi konfigurasi sudah ada
   (migrasi 22: tema/branding/blok, `DRAFT`/`PUBLISHED`/`ARCHIVED`,
   draft/publish/rollback teruji), tetapi galeri template, preview
   desktop/mobile, validasi sebelum publish, dan publikasi eksplisit ke
   storefront belum selesai.

   > Catatan 28 Okt 2026: **`duplicate` template WhatsApp tidak lagi termasuk
   > daftar ini** — endpoint + test-nya sudah ada (lihat §Pembaruan 28 Oktober
   > 2026).
   >
   > Catatan 16 Nov 2026: **pemeriksaan kerusakan & denda kondisi tidak lagi
   > termasuk daftar ini** — saklar inspeksi/denda, nominal ringan/sedang/parah,
   > snapshot konfigurasi, dan usulan denda otomatis sudah ada beserta test-nya
   > (lihat §Pembaruan 16 November 2026). **Lampiran inspeksi juga sudah ada**
   > (`POST /inspections/{id}/attachments` beserta test-nya, pembaruan 16 Nov
   > 2026 kelanjutan), jadi tidak ada lagi endpoint `future`.

### Sebagian, belum boleh ditandai selesai

- **R2-BASE** — upload + hapus + namespacing tenant sudah ada; presigned
  download, pemeriksaan metadata objek, retry provider, batas MIME/ukuran,
  dan aturan retention belum.
- **Resend** — adapter + validasi startup ada; verifikasi domain pengirim,
  SPF/DKIM/DMARC, retry/outbox, dan pengiriman nyata belum.
- **QRIS dinamis** — konversi QRIS statis → dinamis (nominal + CRC16),
  pembuatan tagihan idempoten, aktivasi langganan setelah settle operator, dan
  audit platform ada; rekonsiliasi otomatis tidak mungkin tanpa callback,
  pengingat jatuh tempo dan tagihan berulang belum ada.
- **Dokumen 04 acceptance item 3** — kontrak permission per operasi kini ada
  (`x-required-permission` di 135/135 operasi; operasi `membership` memiliki
  `x-required-roles`) dan validator menolak anotasi yang hilang atau invalid.
- **Retry deadlock/serialization** — helper transaksi mencoba ulang seluruh
  transaksi untuk SQLSTATE PostgreSQL `40P01`/`40001` (maksimal 3 retry dengan
  backoff 10/25/50 ms); integration test memicu kedua SQLSTATE di PostgreSQL
  nyata, membuktikan retry sukses dan memastikan `23505` tidak dicoba ulang.
- **Backup/restore** — runbook + latihan restore ada; jadwal, retensi, RPO/RTO
  belum diputuskan.
- **Logging/audit** — log terstruktur + redaksi + audit trail ada; alerting,
  retensi log (baseline 180 hari), dan runbook insiden belum.

### Operasional & kesiapan rilis

Deployment/DNS wildcard/TLS, monitoring + alert, repository Git + CI GitHub
Actions + branch protection, uji terpisah Windows/Ubuntu/Debian, migrasi upgrade
dari rilis sebelumnya, E2E alur transaksi (booking → pembayaran → serah-terima →
pengembalian), audit aksesibilitas, visual regression, dan Core Web Vitals.

### Menunggu keputusan pemilik produk

Harga/kuota/pajak paket, retensi data & review legal, kebijakan pembatalan/
no-show, dan kebijakan default A/B + nominal denda per tenant.
