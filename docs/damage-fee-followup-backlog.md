# Follow-up inspeksi kerusakan & denda — backlog berurutan

Dibuat 17 November 2026 dari tinjauan status fitur. Urutan = prioritas nilai.
Status awal seluruh butir: **belum dikerjakan**. Butir ditandai selesai hanya
setelah kode, test, dan pemeriksaan (typecheck/lint/test) lulus.

| # | Butir | Nilai | Usaha | Status |
| --- | --- | --- | --- | --- |
| 1 | Pembatalan/koreksi denda (`VOIDED` + alasan + audit) | tinggi | sedang | **selesai** |
| 2 | Tampilkan tagihan denda (`penalties`, `penaltyTotalAmount`, `amountDue`) di halaman order | tinggi | kecil | **selesai** |
| 3 | Batas denda per order (tidak melebihi jaminan/nilai wajar) | tinggi | sedang | **selesai** (batas nominal per tenant) |
| 4 | UI lampiran foto inspeksi + presigned download | tinggi | besar | **selesai** |
| 5 | Alur sengketa penyewa (`DISPUTED`) | tinggi | besar | **selesai** |
| 6 | Halaman laporan denda (`reports/damage-fees`) + ekspor CSV | tinggi | sedang | **selesai** |
| 7 | UI riwayat kebijakan denda + bandingkan/kembalikan revisi | menengah-tinggi | sedang | **selesai** |
| 8 | Notifikasi/badge denda menggantung dan tagihan menua | menengah | kecil-sedang | **selesai** |
| 9 | Simulator nominal denda di layar pengaturan | menengah | kecil | **selesai** |
| 10 | Simpan nama kategori di snapshot (bukan hanya id) | menengah | kecil | belum |
| 11 | Plafon per item dan lampiran per item | menengah | sedang | belum |
| 12 | Deductible/risiko sendiri tenant | menengah-tinggi | kecil | belum |
| 13 | Tarif kerusakan menurun sesuai usia produk | menengah | sedang | belum |
| 14 | Catat biaya perbaikan aktual dan bandingkan dengan denda | menengah | besar | belum |
| 15 | Skor risiko penyewa/produk dari riwayat inspeksi | menengah | sedang-besar | belum |
| 16 | Template pesan inspeksi yang bisa diedit + kirim langsung | menengah | besar | belum |
| 17 | E2E alur inspeksi penuh | menengah | sedang | belum |
| 18 | Test kontrak bentuk respons endpoint baru | menengah | kecil | belum |
| 19 | Kebijakan retensi + hash bukti lampiran | rendah-menengah | sedang | belum |

## Catatan penyelesaian

- **#1** — migrasi `20261117090000_order_penalty_void` (status RECORDED/VOIDED,
  `voidedAt`/`voidedByUserId`/`voidedReason` + CHECK), `POST
  .../orders/{orderId}/penalties/{penaltyId}/void` (OWNER/MANAGER, idempoten,
  audit `ORDER_PENALTY_VOIDED`), `amountDue`/`penaltyTotalAmount` hanya
  menjumlahkan RECORDED, UI daftar denda + dialog pembatalan beralasan.
  Test: integrasi (batal, idempoten, order lain 404) + komponen.
- **#2** — `PenaltiesPanel` di tab Pembayaran: total denda aktif, status,
  alasan pembatalan, aksi Batalkan; kartu "Sisa tagihan" kini memakai
  `amountDue` (termasuk denda) dengan catatan eksplisit.
- **#4** — endpoint storage yang belum ada: `POST /tenants/{t}/storage/upload-url`
  (kini terdokumentasi, kategori `inspections` hanya JPEG/PNG/WebP/PDF) dan
  `GET /tenants/{t}/storage/download-url` (presigned GET 300 detik, `objectKey`
  wajib berprefix tenant). UI: dialog "Lampiran" per inspeksi — upload browser →
  R2 lewat presigned PUT, metadata didaftarkan ke inspeksi, daftar lampiran
  dengan tombol Unduh; upload disembunyikan untuk inspeksi REJECTED dan
  dibatasi 10 file/10 MB. Test: 2 integrasi storage + 4 unit validasi + 3
  komponen. Catatan produksi: bucket R2 perlu CORS untuk PUT dari origin web.
- **#3** — migrasi `20261117093000_tenant_penalty_order_cap`
  (`tenants.damagePenaltyOrderMaxAmount`, CHECK >= 0), validasi `422` di
  `createPenalty` bila akumulasi denda aktif melebihi batas, input di layar
  pengaturan, field kontrak + tipe. Test integrasi: ditolak 150.000, diterima
  setelah batas dinaikkan.

- **#5** — migrasi `20261117120000_inspection_dispute` (status `DISPUTED`,
  `disputeReason`/`disputedAt`/`disputeResolution`/`disputeResolvedAt` + CHECK).
  Penyewa membuka sengketa lewat token portal (`POST
  /portal/orders/{token}/inspections/{inspectionId}/dispute`, hanya APPROVED,
  idempoten, audit `INSPECTION_DISPUTED` tanpa aktor staf); owner/manager
  memutuskan lewat `POST .../inspections/{inspectionId}/dispute/resolve`
  (`UPHELD`/`REVISED`, audit `INSPECTION_DISPUTE_RESOLVED`). `REVISED` ditolak
  422 bila sudah ada tagihan RECORDED dengan nominal berbeda — tagihan harus
  dibatalkan dulu. Portal menampilkan inspeksi terakhir + `canDispute`, UI
  internal menampilkan badge "Sengketa" dan dialog keputusan ulang. Test: 2
  integrasi portal + 2 komponen web.

- **#6** — halaman `/app/reports/damage-fees` (menu Laporan → "Laporan denda") di
  atas `GET /tenants/{t}/reports/damage-fees`: filter rentang tanggal, kartu
  denda tercatat/dibatalkan/keputusan inspeksi/disanggah, tabel status inspeksi,
  tingkat kerusakan, dan lima produk dengan usulan terbesar. Endpoint laporan
  kini hanya menjumlahkan denda `RECORDED` (+ `voidedCount` terpisah),
  menyertakan `DISPUTED` pada hitungan inspeksi, dan mengembalikan
  `productName` (fallback id bila produk sudah dihapus). Ekspor CSV dibuat dari
  data laporan (bukan baris tabel) dengan BOM agar aman di Excel. Filter tanggal
  memakai batas hari zona waktu tenant (`zonedDateStartIso`/`zonedDateEndIso`),
  bukan tengah malam UTC. Test: 2 integrasi laporan + 3 komponen web.

- **#7** — panel "Riwayat kebijakan denda" di Pengaturan: 50 revisi terakhir,
  penanda jumlah field yang berbeda, perbandingan berdampingan (pengaturan saat
  ini vs revisi) dengan baris berubah ditandai, dan dialog pemulihan. Endpoint
  baru `POST /tenants/{t}/damage-fee-revisions/{revisionId}/restore` (OWNER,
  CSRF) menulis ulang snapshot sebagai revisi baru (riwayat append-only),
  memvalidasi ulang aturan denda, dan mencatat audit
  `DAMAGE_FEE_POLICY_RESTORED`. Batas total denda per order sengaja tidak
  termasuk snapshot sehingga tidak berubah; UI menyatakannya. Form pengaturan
  memuat ulang tenant dan membuang draft lama setelah pemulihan. Test: 2
  integrasi (pemulihan + isolasi tenant) + 3 komponen web.

- **#8** — `GET /tenants/{t}/reports/receivable-aging` (report.read) menghitung
  sisa tagihan per pesanan (sewa + denda RECORDED − pembayaran RECORDED),
  mengabaikan pesanan lunas/CANCELLED, lalu mengelompokkan umur ke `0-7`, `8-14`,
  `15-30`, `31+`. Ambang: tagihan menua > 14 hari, denda menggantung > 7 hari.
  `alertCount` memakai himpunan pesanan sehingga pesanan yang tagihan dan
  dendanya sama-sama menua hanya dihitung sekali. Badge menu "Laporan denda"
  (desktop/mobile) dan Ringkasan memakai cache singkat 30 detik dengan
  penggabungan request bersamaan (`receivable-aging-cache`), jadi navigasi
  tidak memicu pemindaian berulang. Ringkasan menampilkan item "tagihan menua"
  dan "denda menggantung" beserta nominal; halaman laporan denda menampilkan
  panel "Umur piutang". Test: 1 integrasi (bucket, pengecualian lunas/CANCELLED,
  ambang, dedupe alertCount) + 1 komponen + 3 unit cache.

- **#9** — simulator "Simulator nominal denda" di panel Inspeksi & denda
  kerusakan, dihitung dari nilai formulir yang belum tentu tersimpan. Pilih
  kategori (umum atau override tersimpan), tingkat kondisi, dan jumlah item;
  tampil nominal per tingkat, usulan sebelum/setelah plafon, penanda
  dipotong plafon, serta penjelasan saat denda nonaktif atau nominal Rp0.
  Aturannya menyalin `damage-fee.ts` server (override kategori menggantikan
  nominal umum sepenuhnya, plafon memotong total); server tetap menghitung
  ulang saat inspeksi dibuat. Keterangan Rp0 disamakan dengan perilaku server:
  baris kategori tersimpan (walau Rp0) tetap berlaku penuh, bukan kembali ke
  nominal umum — hint pengaturan yang lama menyatakan sebaliknya dan diperbaiki.
  Test: 5 unit aturan hitung + 3 komponen.

## Catatan ketergantungan

- **#4** dan **#19** bergantung pada penyelesaian celah R2-BASE (presigned
  download, metadata objek, retensi).
- **#5** (selesai) memakai tautan pesanan tanpa akun; sengketa dibuka penyewa,
  diputuskan OWNER/MANAGER.
- **#16** memerlukan keputusan provider pengiriman WhatsApp dan biayanya.
- **#14** dan **#15** menyentuh data biaya operasional/pelanggan; perlu
  persetujuan kebijakan privasi sebelum ditampilkan ke pengguna.
- **#3** butuh keputusan aturan bisnis: plafon nominal tetap per order atau
  persentase dari nilai sewa/deposit.

## Aturan kerja

- Uang selalu integer IDR utuh; server menghitung nominal, bukan klien.
- Denda tetap usulan/tagihan tercatat: tidak menagih otomatis dan tidak memotong
  deposit tanpa persetujuan aktor kedua.
- Setiap tabel baru wajib GRANT + RLS per tenant dan migrasi baru (tanpa
  mengubah migrasi yang sudah tayang).
- Setiap endpoint baru wajib `x-required-permission` di `docs/openapi.yaml`,
  lalu `openapi:types` diregenerasi.
