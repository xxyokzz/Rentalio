# Rentalio — Admin Platform (`apps/admin`)

Konsol operator Rentalio. Aplikasi Next.js **terpisah** dari `apps/web` dengan
origin sendiri (default `http://localhost:3002`), sesuai `PLATFORM_ADMIN_BASE_URL`
di backend dan catatan di `apps/web/docs/notion-alignment.md`.

## Menjalankan

```bash
# dari root repo
pnpm install
pnpm --filter @rentalio/api dev      # backend :3000
pnpm --filter @rentalio/admin dev    # konsol  :3002
```

Buka <http://localhost:3002>. Untuk development, akun default bisa dibuat
dengan satu perintah (idempoten, menolak berjalan di production):

```bash
pnpm --filter @rentalio/api admin:seed
```

- Email: `admin@rentalio.my.id`
- Password: `admlogin123`

Untuk akun sungguhan, gunakan jalur interaktif `pnpm --filter @rentalio/api
admin:bootstrap` (sekali seumur instalasi).

Login selalu dua langkah: password → TOTP. Login pertama memaksa enrollment
TOTP (secret ditampilkan sekali beserta 10 kode pemulihan yang juga hanya
ditampilkan sekali).

## Halaman

| Rute                | Permission minimum             | Isi                                                        |
| ------------------- | ------------------------------ | ---------------------------------------------------------- |
| `/login`            | —                              | Password, enrollment/TOTP, kode pemulihan                  |
| `/tenants`          | `platform.tenants.list`        | Direktori tenant: cari, filter status, paginasi            |
| `/tenants/[id]`     | `platform.tenants.read_summary`| Ringkasan tenant, suspend/reactivate, settle tagihan QRIS  |
| `/cron`             | `platform.dashboard.read`      | Riwayat cron: status per job, durasi, hasil, alert         |
| `/admins`           | `platform.roles.read`          | Direktori Admin Platform + role aktif                      |
| `/admins/[id]`      | `platform.roles.read`          | Role aktif, permission efektif, assign/revoke role         |
| `/audit`            | `platform.audit.read`          | Audit viewer: aksi, aktor, rentang waktu                   |

Menu di sidebar otomatis menyembunyikan halaman yang tidak diizinkan, dan tombol
mutasi tetap dinonaktifkan dengan penjelasan bila role tidak punya izin. Server
tetap sumber kebenaran: setiap mutasi divalidasi ulang oleh guard API.

## Model keamanan

- **Proxy same-origin.** `next.config.ts` menulis ulang `/api/v1/*` ke
  `API_INTERNAL_URL`, sehingga cookie `rentalio_platform_admin` (HttpOnly,
  host-only, SameSite=Lax) tetap berada pada origin admin dan tidak pernah
  terkirim ke origin tenant.
- **Origin asli diteruskan.** Karena rewrite memakai header browser apa adanya,
  guard CSRF API yang membandingkan `Origin` dengan `PLATFORM_ADMIN_BASE_URL`
  tetap bekerja tanpa pelemahan di server.
- **CSRF di memori.** Token dari `POST /platform-admin/auth/mfa` atau
  `GET /platform-admin/csrf` disimpan di variabel modul, tidak di
  localStorage/sessionStorage. Setiap `GET /csrf` merotasi token, jadi klien
  menyegarkan token sekali dan mengulang permintaan bila menerima
  `CSRF_VALIDATION_FAILED`.
- **Sesi diverifikasi di server.** Layout konsol memanggil
  `GET /platform-admin/session` dengan cookie yang diteruskan eksplisit; tanpa
  sesi sah semua halaman langsung mengalihkan ke `/login`.
- **Tanpa secret.** Tidak ada kunci API, pepper, atau kunci enkripsi di aplikasi
  ini. Semua rahasia tinggal di backend.

## Konfigurasi

Salin `.env.example` ke `.env.local` bila backend tidak berjalan di port 3000:

```dotenv
API_INTERNAL_URL=http://localhost:3000
NEXT_PUBLIC_ADMIN_APP_URL=http://localhost:3002
```

Di production, `NEXT_PUBLIC_ADMIN_APP_URL` harus HTTPS dan **persis sama** dengan
`PLATFORM_ADMIN_BASE_URL` di backend, karena perbandingan Origin bersifat exact
match.

## Catatan operasional

- Penyelesaian tagihan QRIS membutuhkan id tagihan; API belum menyediakan
  endpoint daftar tagihan, jadi operator menempelkan id dari laporan/DB.
- Aksi status tenant dan perubahan role selalu meminta alasan ≥ 10 karakter
  karena API menyimpannya pada audit append-only.
- API menolak penugasan role ke diri sendiri dan pencabutan `PLATFORM_SUPER_ADMIN`
  terakhir; pesan penolakan ditampilkan apa adanya.
