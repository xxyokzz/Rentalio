-- ============================================================
-- Bootstrap PostgreSQL untuk CI (idempoten).
--
-- Dijalankan sebagai superuser (postgres) di dalam container service CI:
--   docker exec <container-id> psql -U postgres -v ON_ERROR_STOP=1 \
--     < scripts/ci/bootstrap-postgres.sql
--
-- Bisa juga dipakai untuk menyiapkan database lokal dari nol, asalkan
-- dieksekusi sebagai superuser. Aman dijalankan berulang: role/database
-- yang sudah ada tidak disentuh.
--
-- Dua role terpisah (dokumen 03 & 10):
--   sewain_migrator — menjalankan `prisma migrate deploy` (DDL)
--   sewain_dev      — role runtime aplikasi; non-superuser, non-BYPASSRLS
--
-- Tanpa kedua role ini migrasi 002 sengaja GAGAL dengan pesan jelas.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sewain_migrator') THEN
    CREATE ROLE sewain_migrator LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sewain_dev') THEN
    CREATE ROLE sewain_dev LOGIN;
  END IF;
END $$;

-- Database test dimiliki role migrator karena menjalankan DDL migrasi.
-- `SELECT ... \gexec` mengeksekusi perintah hasil query, jadi statement ini
-- tidak diakhiri titik koma; bila database sudah ada tidak ada baris → no-op.
SELECT format('CREATE DATABASE %I OWNER sewain_migrator', d.name)
FROM (VALUES ('sewain_test')) AS d(name)
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = d.name)
\gexec
