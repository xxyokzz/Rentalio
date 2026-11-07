-- ============================================================
-- Bootstrap Supabase untuk Rentalio.
--
-- Jalankan SEKALI sebagai role `postgres` di Supabase SQL Editor
-- (Dashboard -> SQL Editor), SEBELUM `prisma migrate deploy`.
--
-- GANTI kedua password placeholder di bawah dengan password acak yang kuat.
-- Jangan commit nilai asli ke repository ini.
--
-- Kenapa dua role:
--   sewain_migrator — menjalankan DDL (`prisma migrate deploy`).
--   sewain_dev      — runtime API; non-superuser dan non-BYPASSRLS agar
--                     FORCE ROW LEVEL SECURITY tetap berlaku.
--
-- JANGAN memakai role `postgres` sebagai runtime: di Supabase role itu
-- memiliki BYPASSRLS sehingga isolasi tenant di database hilang.
-- ============================================================

-- Migration 002 memakai btree_gist untuk exclusion constraint anti
-- double-booking. Extension dipasang di schema `extensions` (konvensi
-- Supabase), lalu search_path role diarahkan ke sana.
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sewain_migrator') THEN
    CREATE ROLE sewain_migrator LOGIN PASSWORD 'GANTI_PASSWORD_MIGRATOR';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sewain_dev') THEN
    CREATE ROLE sewain_dev LOGIN PASSWORD 'GANTI_PASSWORD_RUNTIME';
  END IF;
END $$;

-- Pastikan tidak ada privilege berlebih, bahkan bila role sudah dibuat manual.
-- Di Supabase role `postgres` bukan superuser, sedangkan atribut SUPERUSER dan
-- BYPASSRLS hanya bisa diubah superuser; karena itu ALTER di bawah dijalankan
-- sebagai upaya terbaik. Role yang baru dibuat lewat CREATE ROLE sudah
-- NOSUPERUSER/NOBYPASSRLS secara default, dan blok ini gagal keras bila
-- atributnya ternyata belum aman supaya isolasi tenant tidak diam-diam hilang.
DO $$
DECLARE
  tidak_aman text;
BEGIN
  BEGIN
    ALTER ROLE sewain_migrator NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    ALTER ROLE sewain_dev NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  EXCEPTION WHEN insufficient_privilege THEN
    NULL; -- biarkan pemeriksaan di bawah memutuskan aman atau tidak
  END;

  SELECT string_agg(rolname, ', ') INTO tidak_aman
  FROM pg_roles
  WHERE rolname IN ('sewain_migrator', 'sewain_dev')
    AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole);

  IF tidak_aman IS NOT NULL THEN
    RAISE EXCEPTION
      'Atribut role belum aman (%): jalankan ALTER ROLE ... NOSUPERUSER NOBYPASSRLS sebagai superuser sebelum migrasi.',
      tidak_aman;
  END IF;
END $$;

ALTER ROLE sewain_migrator SET search_path = public, extensions;
ALTER ROLE sewain_dev SET search_path = public, extensions;

GRANT CONNECT ON DATABASE postgres TO sewain_migrator, sewain_dev;

-- Migrator butuh CREATE untuk tabel/enum/index/trigger. Runtime hanya DML
-- (grant tabel diberikan oleh migration 002 dan default privileges-nya).
GRANT USAGE, CREATE ON SCHEMA public TO sewain_migrator;
GRANT USAGE ON SCHEMA public TO sewain_dev;
GRANT USAGE ON SCHEMA extensions TO sewain_migrator, sewain_dev;

-- Rentalio tidak memakai Supabase Data API/PostgREST. Cabut akses role
-- anon/authenticated supaya tabel di schema public tidak dapat dijangkau
-- lewat anon key, meski RLS sudah fail-closed.
REVOKE ALL ON SCHEMA public FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

-- Verifikasi cepat: kedua role harus rolsuper=false dan rolbypassrls=false.
SELECT rolname, rolsuper, rolbypassrls
FROM pg_roles
WHERE rolname IN ('sewain_migrator', 'sewain_dev')
ORDER BY rolname;
