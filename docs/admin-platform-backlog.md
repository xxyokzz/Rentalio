# Backlog Admin Platform — gap kode vs Notion 17

Sumber spec: halaman Notion **“Sewain — 17. Admin Platform & Komunikasi”**
(§3, §5, §9, §10, §11–12) dan `docs/openapi.yaml`.
Bukti kode: `apps/admin`, `apps/api/src/platform-admin`, `database/prisma/schema.prisma`
(pemeriksaan 3 November 2026).

Dokumen ini hanya daftar pekerjaan. Tidak ada butir di sini yang boleh ditandai
selesai tanpa implementasi + test yang benar-benar dijalankan, sesuai aturan
“semua checklist belum lulus sampai hasil uji aktual dilampirkan” di Notion 17.

## 1. Kondisi saat ini

| Area | Status | Bukti |
| --- | --- | --- |
| Identitas platform, sesi host-only, MFA TOTP, recovery code | Ada | `platform-admin.auth.ts`, `platform-admin.crypto.ts`, `login-form.tsx` |
| RBAC deny-by-default + audit append-only | Ada | `@RequirePlatformPermission`, `platform_audit_events` (trigger) |
| Direktori tenant (list/detail) + suspend/reactivate | Ada | `GET /platform-admin/tenants`, `POST .../suspend`, `.../reactivate` |
| Direktori admin + assign/revoke role | Ada | `GET /platform-admin/admins`, `POST .../roles/assign`, `.../roles/revoke` |
| Audit viewer | Ada | `GET /platform-admin/audit-events`, halaman `/audit` |
| Billing langganan (settle tagihan QRIS) | Ada (sempit) | `POST .../subscription-invoices/{invoiceId}/settle` |
| Dashboard platform | **Tidak ada** | `/` redirect ke `/tenants`; tidak ada endpoint |
| Direktori pengguna platform | **Tidak ada** | tidak ada `/platform-admin/users` |
| Detail tenant (owner/karyawan/paket/langganan/riwayat) | **Sebagian** | detail hanya timezone, currency, tanggal |
| Langganan read (`platform.subscriptions.read`) | **Tidak ada** | hanya aksi `settle` |
| Promo langganan Sewain | **Tidak ada** | model & endpoint tidak ada di schema |
| Pengumuman/announcement center | **Tidak ada** | model, endpoint, UI tidak ada |
| Halaman role & permission matrix | **Tidak ada** | `platform.roles.read` hanya dipakai untuk daftar admin |
| Re-authentication tindakan berisiko | **Tidak ada** | `reauthenticatedAt` disimpan tapi tidak pernah di-set/diwajibkan |

## 2. Inkonsistensi kontrak yang harus diputuskan lebih dulu

1. **Prefix route.** Notion §5 menulis `/api/v1/platform/admin/...`; kode dan
   `docs/openapi.yaml` memakai `/platform-admin/...`. Pilih satu, lalu samakan
   dokumen + OpenAPI + kode. Rekomendasi: pertahankan `/platform-admin` karena
   sudah terimplementasi dan teruji, perbarui Notion.
2. **Jumlah operasi.** Notion §11–12 mencatat 24 path / 27 operasi dari draf di
   percakapan; `docs/openapi.yaml` saat ini memuat 14 path platform-admin.
   Setelah butir backlog di bawah selesai, jumlah ini harus diperbarui dengan
   angka hasil `pnpm openapi:validate`.
3. **Matriks permission §10.1 belum lengkap** untuk permission yang sudah dipakai
   kode: `platform.subscriptions.settle`. Tambahkan ke matriks (Super Admin dan
   Billing), atau hapus dari kode.
4. **`platform.dashboard.read` ada di matriks tanpa endpoint/layar.** Entah
   diimplementasikan (PLAT-09) atau dihapus dari matriks.

## 3. Task implementasi

Format tiap task: tujuan → kontrak → data → UI → test.
Semua endpoint wajib memakai `@RequirePlatformPermission` dan menulis audit event
dengan actor, action, target, reason (bila berisiko), hasil, correlation ID.

### PLAT-09 — Dashboard platform
- Kontrak: `GET /platform-admin/dashboard` → ringkasan jumlah tenant per status,
  tenant trial berakhir ≤ 14 hari, tagihan langganan belum lunas, pengumuman
  aktif, 10 audit event terakhir.
- Permission: `platform.dashboard.read`.
- UI: halaman `/` (bukan redirect) dengan kartu ringkasan + tautan cepat.
- Test: guard 403 untuk sesi tanpa permission; isolasi data lintas tenant pada
  agregat; angka cocok dengan query langsung di integration test.

### PLAT-10 — Direktori pengguna platform
- Kontrak: `GET /platform-admin/users?query&status&page`, `GET /platform-admin/users/{userId}`.
- Permission: `platform.users.list`, `platform.users.read_summary`.
- Data: hanya identitas minimum + tenant membership terkait. **Tanpa** data
  pelanggan rental, dokumen identitas, atau kredensial (§10.2).
- UI: `/users` + `/users/[userId]`; Support melihat subset field.
- Test: Communications ditolak, Support tidak melihat payload bisnis, pencarian
  tidak membocorkan user tenant lain.

### PLAT-11 — Lengkapi detail tenant
- Tambah ke `GET /platform-admin/tenants/{tenantId}`: owner (email + status),
  jumlah/daftar karyawan, paket, status langganan, tanggal trial/akhir langganan,
  status pembayaran terakhir, dan riwayat tindakan admin atas tenant tersebut.
- Permission: tetap `platform.tenants.read_summary` + `platform.subscriptions.read`
  untuk bagian langganan.
- UI: section “Identitas”, “Langganan”, “Riwayat tindakan” di halaman detail.
- Test: field bertambah sesuai tipe `TenantDetail`; tidak ada field bisnis tenant.

### PLAT-12 — Langganan read
- Kontrak: `GET /platform-admin/subscriptions`, `GET /platform-admin/subscriptions/{subscriptionId}`.
- Permission: `platform.subscriptions.read` (Support hanya status ringkas).
- UI: `/subscriptions` (list + filter status/paket) dan detail riwayat event.
- Test: support melihat status tanpa detail billing; Billing melihat penuh.

### PLAT-13 — Announcement center: inti
- Data: `platform_announcements` (judul, isi terstruktur, kategori/severity,
  `publish_at`, `expires_at`, status, author, versi, `resolved_at`),
  `platform_announcement_revisions`.
- Kontrak: `GET/POST/PATCH /platform-admin/announcements`,
  `POST .../{id}/publish`, `.../withdraw`, `.../resolve`, `GET .../{id}`.
- Permission: `platform.announcements.read|create|update_draft|publish|withdraw|resolve`.
- UI: `/announcements` (list + filter status), editor draft + preview,
  aksi publish/withdraw/resolve dengan konfirmasi.
- Test: draft tidak pernah tampil publik; transisi status ilegal → 409; setiap
  transisi menulis audit; konten HTML/JS ditolak (sanitasi).

### PLAT-14 — Audience & kanal in-app
- Data: `platform_announcement_audiences` (ALL, SEGMENT status/paket, TENANT_LIST),
  snapshot target saat publish.
- Kontrak: `GET /announcements/{id}/audience-preview` (server-side evaluation),
  endpoint baca untuk tenant: `GET /announcements/active` (banner/pusat notifikasi).
- UI: pemilih audience di editor (super admin/communications), banner in-app di
  `apps/web` + pusat notifikasi.
- Test: filter audience dievaluasi backend (bukan dari client); tenant tidak
  menerima pengumuman tenant lain; banner hilang setelah `expires_at`/withdraw.

### PLAT-15 — Email pengumuman & outbox
- Data: `platform_notification_deliveries` + outbox/worker persisten, idempotency
  key, retry berjenjang, status provider message ID.
- Kontrak: internal job; `GET /announcements/{id}/deliveries`.
- Aturan: kegagalan email tidak menghapus pengumuman in-app; status `delivered`
  hanya jika provider memberi bukti; `read` hanya jika aplikasi merekam.
- Test: retry tidak menggandakan kiriman; provider timeout → status failed +
  retry; worker restart melanjutkan job (tanpa timer in-memory).

### PLAT-16 — Promo langganan: model & CRUD
- Data: `platform_promotions` (kode, jenis diskon, nilai, periode, kuota global
  & per akun, eligibility paket/periode/audiens, status, stackability, prioritas),
  `platform_promotion_redemptions` dengan unique constraint anti double-redeem.
- Kontrak: `GET/POST/PATCH /platform-admin/promotions`,
  `GET /platform-admin/promotions/{promotionId}`.
- Permission: `platform.promotions.read|create|update_draft`.
- UI: `/promotions` + form draft. **Jangan** mengisi default nilai diskon/
  stackability/refund — parameter bisnis belum disetujui (§9.3).
- Test: draft tidak dapat ditebus; validasi field; promo tidak menyentuh harga
  sewa/denda tenant.

### PLAT-17 — Promo: aktivasi & penebusan
- Kontrak: `POST .../activate`, `.../deactivate` (re-auth + audit), validasi promo
  saat pembuatan tagihan langganan.
- Aturan: validasi eligibility, kuota, harga di backend dalam satu transaksi;
  idempotent; invoice final tidak diubah retroaktif.
- UI: aksi aktivasi/nonaktif dengan konfirmasi + alasan.
- Test: race condition dua request bersamaan tidak melewati kuota; kode di luar
  periode/audiens ditolak; retry tidak menggandakan redemption; invoice historis
  tidak berubah.

### PLAT-18 — Halaman role & permission matrix
- Kontrak: `GET /platform-admin/roles`, `GET /platform-admin/permissions`.
- Permission: `platform.roles.read` (assign/revoke sudah ada di detail admin).
- UI: `/roles` menampilkan role × permission read-only, plus daftar pemegang role.
- Test: Support/Billing/Communications 403; matriks UI sama persis dengan seed
  database (parity test).

### PLAT-19 — Scoped audit read
- Ubah `GET /platform-admin/audit-events` agar memfilter berdasarkan permission:
  Support → event dukungan; Billing → event billing; Communications → 403 default.
- Tambah `action`/`targetType`/`actorId`/rentang tanggal sebagai filter.
- Test: Support tidak menemukan event promo/role; hasil filter tidak membocorkan
  metadata rahasia.

### PLAT-20 — Re-authentication tindakan berisiko
- Set `reauthenticatedAt` lewat endpoint re-auth (password + TOTP) dan wajibkan
  pada: suspend/reactivate tenant, assign/revoke role, activate/deactivate promo,
  publish/withdraw pengumuman, settle tagihan.
- UI: dialog konfirmasi + input kode saat `reauthenticatedAt` lebih tua dari
  batas (mis. 10 menit).
- Test: aksi sensitif tanpa re-auth → 403; setelah re-auth → sukses dan tercatat
  di audit; sesi tenant tidak dapat memicu re-auth admin.

### PLAT-21 — Sinkronisasi kontrak OpenAPI
- Tambahkan seluruh operasi di atas ke `docs/openapi.yaml` dengan
  `x-required-permission`, skema error/pagination/idempotency yang seragam.
- Jalankan `pnpm openapi:validate`; perbarui angka path/operasi di Notion §11–12
  dan hapus kalimat “file belum berada di repository”.
- Test: CI parity check — setiap route NestJS ada di OpenAPI dan sebaliknya;
  setiap operasi punya `x-required-permission` yang dikenal registry.

## 4. Di luar MVP (jangan diimplementasikan)

- **Impersonation** — dilarang untuk MVP (§3, §9.1). Jika kelak dibutuhkan,
  desain terpisah: persetujuan, durasi terbatas, indikator terlihat, audit penuh,
  larangan tindakan finansial.
- **Akses konten bisnis tenant oleh Support** — butuh keputusan produk dan
  kontrol terpisah, bukan sekadar penambahan permission.

## 5. Urutan pengerjaan yang disarankan

1. PLAT-21 keputusan prefix + PLAT-20 re-auth (fondasi keamanan, murah, menutup
   temuan audit yang sudah terbuka).
2. PLAT-11 + PLAT-12 + PLAT-19 (melengkapi area yang sudah ada, tanpa model baru).
3. PLAT-13 → PLAT-14 → PLAT-15 (announcement center bertahap: inti → audience →
   email/outbox).
4. PLAT-16 → PLAT-17 (promo hanya setelah aturan harga disetujui).
5. PLAT-09 + PLAT-10 + PLAT-18 (permukaan UI tambahan).

## 6. Definition of done per task

- Endpoint + guard permission + audit event + test integration lulus.
- Halaman UI memuat state loading/empty/error dan menghormati permission.
- Entri OpenAPI dengan `x-required-permission` dan validasi `pnpm openapi:validate` lulus.
- Baris checklist terkait di Notion 17 diperbarui **hanya** dengan bukti
  perintah + hasil, bukan status “diasumsikan selesai”.
