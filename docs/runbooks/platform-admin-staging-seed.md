# Runbook — Akun Admin Platform Staging (TOTP ter-enroll)

Dokumen ini menjelaskan cara membuat akun Admin Platform di database
staging/preview yang **sudah ter-enroll TOTP**, supaya login konsol admin bisa
diuji lewat UI tanpa melewati alur enrollment (scan QR) di setiap percobaan.

> **Status:** dipakai untuk staging `rentalio-staging` (Supabase, terpisah dari
> production) dan preview Vercel. Akun yang dihasilkan **hanya untuk staging**;
> production tetap memakai `admin:bootstrap` yang interaktif.

## 1. Kapan dipakai

- Butuh akun admin untuk uji manual UI staging (direktori tenant, audit, cron,
  role assignment) tanpa menyiapkan authenticator baru tiap kali.
- Butuh merotasi password/secret TOTP akun admin staging.
- **Bukan** untuk production, dan bukan pengganti `admin:bootstrap`
  (`pnpm --filter @rentalio/api admin:bootstrap`) yang sekali seumur instalasi.

## 2. Perbedaan dengan jalur lain

| Jalur | Password | TOTP | Target |
| --- | --- | --- | --- |
| `admin:bootstrap` | diketik interaktif (TTY) | enrollment saat login pertama | production |
| `admin:seed` (dev) | `PLATFORM_ADMIN_DEFAULT_PASSWORD` (bawaan publik) | enrollment saat login pertama | lokal |
| `database/prisma/seed-platform-admin.mjs` | env, acak | **sudah ter-enroll** | staging/preview |

## 3. Prasyarat

- `DATABASE_URL` menunjuk database staging (bukan production). Skrip menolak
  berjalan bila `NODE_ENV=production`.
- Migrasi platform admin sudah diterapkan (role `PLATFORM_SUPER_ADMIN` ada).
- `PLATFORM_ADMIN_ENCRYPTION_KEY` **sama persis** dengan yang dipakai API staging
  (base64 dari tepat 32 byte). Bila berbeda, API gagal mendekripsi secret TOTP
  dan login MFA berakhir `500`.
- `database/dist` sudah dibangun: `pnpm --filter @rentalio/database build`.

Env yang dibaca skrip (jangan commit nilainya):

```
DATABASE_URL
PLATFORM_ADMIN_SEED_EMAIL
PLATFORM_ADMIN_SEED_PASSWORD          # >= 12 karakter
PLATFORM_ADMIN_SEED_TOTP_SECRET       # base32, >= 32 karakter
PLATFORM_ADMIN_ENCRYPTION_KEY         # base64 32 byte
```

## 4. Menjalankan

Dari root repo:

```bash
pnpm --filter @rentalio/database build
node database/prisma/seed-platform-admin.mjs
```

Skrip idempoten dan mencetak email, role, serta status MFA — tidak pernah
mencetak password atau secret TOTP.

Efek yang ditulis:

1. `platform_admin_users` — password (scrypt), `totp_secret_encrypted`
   (AES-256-GCM `v1.<iv>.<tag>.<ct>`), `mfa_enrolled_at`, `last_totp_step = NULL`,
   `status = ACTIVE`.
2. `platform_admin_roles` — assignment `PLATFORM_SUPER_ADMIN` (diaktifkan kembali
   bila `revoked_at` terisi).
3. `platform_audit_events` — `PLATFORM_ADMIN_MFA_ENROLLED` dengan
   `metadata.source = seed-staging`.

`last_totp_step` sengaja di-reset agar kode berikutnya diterima; kode yang sudah
dipakai pada langkah waktu yang sama ditolak (anti-replay).

## 5. Menyiapkan authenticator

Impor secret base32 dari env ke aplikasi authenticator, atau buat URI:

```
otpauth://totp/Rentalio%20Admin%20Platform:admin@rentalio.test?secret=<SECRET>&issuer=Rentalio%20Admin%20Platform&algorithm=SHA1&digits=6&period=30
```

## 6. Verifikasi

Login di `https://rentalio-admin-staging.vercel.app/login` (email + password,
lalu kode 6 digit). Lewat API/proxy, urutannya:

1. `POST /api/v1/platform-admin/auth/login` → `200`, `status: "MFA_REQUIRED"`
   (bukan `MFA_ENROLLMENT_REQUIRED`).
2. `POST /api/v1/platform-admin/auth/mfa` → `200`, cookie
   `rentalio_platform_admin` host-only + HttpOnly.
3. `GET /api/v1/platform-admin/session` → `200`, `roles` memuat
   `PLATFORM_SUPER_ADMIN` dan `permissions` terisi.

Bila `mfa` mengembalikan `500`, periksa kecocokan
`PLATFORM_ADMIN_ENCRYPTION_KEY` antara API staging dan env seed.

## 7. Batasan dan pembersihan

- Batas percobaan: login 10/15 menit per IP dan 5/15 menit per akun, MFA
  20/15 menit per IP. Kena limit → tunggu jendela habis.
- Akun ini Super Admin penuh; jangan dipakai di lingkungan bersama atau
  production.
- Untuk menghapus akun, hapus barisnya lewat alur admin/audit yang tercatat —
  atau, khusus staging yang bisa dibuang, reset database staging.
- Rotasi: jalankan ulang skrip dengan env baru (password dan/atau secret TOTP
  baru). `last_totp_step` ikut di-reset.
