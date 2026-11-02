# Runbook — Backup & Pemulihan Database Rentalio

Dokumen ini menutup butir **C3 (backup dan recovery)** pada checklist kesiapan:
jadwal, retensi, enkripsi, akses, RPO/RTO, prosedur restore, dan bukti uji
restore yang dapat diulang.

> **Status:** prosedur dan bukti uji restore **DONE untuk PostgreSQL lokal**.
> Jadwal, retensi, dan RPO/RTO di bawah masih **usulan** dan menunggu keputusan
> pemilik produk sebelum dipakai di staging/production. Bucket/offsite storage
> belum dikonfigurasi.

## 1. Cakupan

- Database aplikasi (`sewain_dev`, `sewain_test`, dan nanti `rentalio_staging`/
  `rentalio_production`) beserta schema `public` milik Prisma.
- Yang **tidak** tercakup: WAL archiving / point-in-time recovery, object storage
  (R2 belum ada), konfigurasi environment/secret, dan data di luar PostgreSQL.

## 2. Prasyarat: role backup wajib melewati RLS

Tabel Rentalio memakai `FORCE ROW LEVEL SECURITY` sehingga **bahkan pemilik tabel**
tetap tunduk pada policy. `pg_dump` akan gagal pada tabel seperti
`asset_maintenance` bila dijalankan dengan role aplikasi/migrator:

```
pg_dump: error: query failed: ERROR:  query would be affected by row-level
security policy for table "asset_maintenance"
```

Karena itu backup memakai role khusus:

```sql
-- Sekali saja, dijalankan superuser.
CREATE ROLE rentalio_backup LOGIN BYPASSRLS;
GRANT CONNECT ON DATABASE sewain_dev TO rentalio_backup;
GRANT USAGE ON SCHEMA public TO rentalio_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO rentalio_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE sewain_migrator IN SCHEMA public
  GRANT SELECT ON TABLES TO rentalio_backup;
```

- Role ini **hanya** boleh `SELECT` + `CONNECT`; tidak boleh DDL maupun menulis.
- Alternatif yang setara: jalankan dump sebagai superuser (dipakai pada uji
  lokal 20 Oktober 2026).
- Jangan memakai role runtime `sewain_dev` maupun `sewain_migrator` untuk backup:
  hasilnya akan error (bukan dump parsial yang diam-diam kehilangan baris).

## 3. Kebijakan yang diusulkan (belum disetujui)

| Aspek | Usulan | Catatan |
| --- | --- | --- |
| Frekuensi | dump harian 02.00 WIB + dump manual sebelum migrasi rilis | butuh scheduler (cron/Task Scheduler/pm2) di host |
| Retensi | 7 harian, 4 mingguan, 12 bulanan | rotasi di sisi penyimpanan |
| RPO | ≤ 24 jam | konsekuensi dump harian; PITR menurunkan ke menit |
| RTO | ≤ 60 menit untuk database < 5 GB | diukur pada latihan restore |
| Enkripsi | dump dienkripsi sebelum keluar host (age/gpg, kunci terpisah dari DB) | dump memuat data tenant |
| Akses | hanya operator yang ditunjuk; kunci enkripsi di secret manager | audit setiap pengambilan |
| Lokasi | 1 salinan lokal + 1 salinan offsite (object storage) | offsite belum tersedia |

Angka di atas **usulan**, bukan keputusan. Jangan dikutip sebagai komitmen SLA
sebelum pemilik produk menyetujui.

## 4. Prosedur backup

```bash
# 1. Dump custom format (kompresi + selektif restore).
pg_dump --format=custom --no-password \
  --file ".backups/$(date +%Y%m%dT%H%M%S).dump" \
  "$BACKUP_DATABASE_URL"

# 2. Pastikan dump dapat dibaca (bukan file terpotong).
pg_restore --list .backups/<file>.dump | wc -l

# 3. Catat checksum untuk verifikasi integritas saat restore.
sha256sum .backups/<file>.dump > .backups/<file>.dump.sha256

# 4. Enkripsi sebelum disalin keluar host.
age -r <penerima> -o .backups/<file>.dump.age .backups/<file>.dump
```

Aturan operasional:

- Backup **tidak** boleh ditulis ke dalam direktori yang di-serve web atau ke
  repository Git (`.backups/` sudah di-gitignore).
- Jangan menaruh `BACKUP_DATABASE_URL` di kode, log, atau argumen baris perintah
  yang terlihat proses lain. Gunakan environment/secret manager.
- Dump yang gagal (exit ≠ 0) harus diperlakukan sebagai tidak ada backup; jangan
  menimpa salinan sukses terakhir sebelum dump baru lolos verifikasi.

## 5. Prosedur restore

Latihan (tidak menyentuh database aktif) — inilah yang diotomasi:

```bash
pnpm db:backup:verify
# atau eksplisit:
BACKUP_DATABASE_URL="postgresql://rentalio_backup@localhost:5432/sewain_dev" \
PG_BIN="C:/path/ke/postgresql/bin" \
node scripts/ops/backup-restore.mjs
```

Skrip akan: dump → buat database `rentalio_restore_verify` → `pg_restore
--exit-on-error` → bandingkan jumlah baris tiap tabel, jumlah tabel ber-RLS, dan
jumlah policy → hapus database sementara. Exit code 1 bila ada selisih.

Restore ke database sebenarnya (insiden):

1. **Hentikan** API dan worker agar tidak ada penulisan baru.
2. Catat titik gagal: waktu insiden, dump terakhir yang lolos verifikasi.
3. Buat database baru (`sewain_dev_restore`) alih-alih menimpa database rusak,
   lalu restore ke sana:

   ```bash
   createdb -O sewain_migrator sewain_dev_restore
   pg_restore --dbname sewain_dev_restore --no-password --exit-on-error <dump>
   ```

4. Jalankan migrasi yang belum ada di dump: `pnpm db:migrate`.
5. Verifikasi: jumlah baris tabel inti, `SELECT count(*) FROM _prisma_migrations`,
   dan login uji pada satu tenant.
6. Ganti koneksi aplikasi ke database hasil restore, lalu nyalakan API/worker.
7. Simpan database rusak untuk analisis sampai insiden ditutup.

## 6. Bukti uji restore

Dijalankan 20 Oktober 2026 pada PostgreSQL 18.4 lokal (Windows), klien
`pg_dump`/`pg_restore`/`psql` 18.4:

| Item | Hasil |
| --- | --- |
| Sumber | `sewain_test` (hasil suite integrasi penuh, 17 migrasi) |
| Role dump | superuser `postgres` (setara `BYPASSRLS`) |
| Entri dump | 468 |
| Restore | selesai tanpa error (`--exit-on-error`) |
| Tabel | 43 tabel, 7.093 baris — identik di sumber dan hasil restore |
| RLS | 37 tabel ber-RLS + 45 policy — identik |
| Cleanup | database sementara dihapus otomatis |
| Exit code | 0 (`PASS`) |

Perintah: `BACKUP_DATABASE_URL="postgresql://postgres@localhost:5432/sewain_test"
node scripts/ops/backup-restore.mjs`.

## 7. Batas bukti yang jujur

- Belum ada backup terjadwal, retensi otomatis, enkripsi, maupun salinan offsite;
  yang terbukti baru **prosedur restore dan kesetaraan isi**.
- Belum diuji: restore lintas versi PostgreSQL, database > 1 GB, kegagalan di
  tengah restore, dan PITR.
- Database `sewain_dev` pada mesin ini dibuat ulang 20 Oktober 2026 dan seluruh
  17 migrasi diterapkan; isinya masih kosong sehingga uji restore memakai
  `sewain_test`.
- Latihan restore wajib diulang setiap kali schema berubah dan minimal sebelum
  rilis staging pertama.
