/**
 * Global setup vitest untuk integration test.
 *
 * 1. Reset schema database TEST (bukan development) ke kondisi kosong.
 * 2. Jalankan seluruh migration Prisma dari database kosong —
 *    ini sekaligus membuktikan "database dapat dibangun dari nol"
 *    (acceptance criteria Sprint 0/MVP, dokumen 03).
 *
 * Kredensial memakai role migrator (sewain_migrator), terpisah dari
 * role runtime (sewain_dev) yang dipakai aplikasi saat test berjalan.
 */
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Client } from 'pg';

// vitest dijalankan dengan cwd = apps/api, jadi database package ada di ../../database
const databaseDir = resolve(process.cwd(), '../../database');

const MIGRATOR_TEST_URL =
  process.env.MIGRATOR_TEST_URL ??
  'postgresql://sewain_migrator@localhost:5432/sewain_test';

/** Tolak bila target bukan database test (perlindungan destruktif). */
function assertIsTestDatabase(url: string): void {
  if (!url.includes('/sewain_test')) {
    throw new Error(
      `Global setup menolak menjalankan reset pada database non-test: ` +
        `host database harus berakhiran /sewain_test. URL=${url.replace(/:[^:@/]*@/, ':***@')}`,
    );
  }
}

export default async function globalSetup(): Promise<void> {
  assertIsTestDatabase(MIGRATOR_TEST_URL);

  const client = new Client({ connectionString: MIGRATOR_TEST_URL });
  await client.connect();
  try {
    // Buang seluruh schema lalu buat ulang — migration dijalankan dari nol.
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
  } finally {
    await client.end();
  }

  // prisma migrate deploy menerapkan migration berurutan ke database kosong.
  execSync('npx prisma migrate deploy', {
    cwd: databaseDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      DATABASE_URL: MIGRATOR_TEST_URL,
      // migrate deploy tidak memerlukan shadow database.
      SHADOW_DATABASE_URL: '',
    },
  });
}
