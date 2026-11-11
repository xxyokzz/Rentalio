/**
 * Uji beban singkat: antrean transaksi pada pool koneksi kecil.
 *
 * Regresi yang dijaga: produksi pernah memakai `DATABASE_POOL_MAX=1`, sehingga
 * beberapa request paralel dari satu halaman (`products`, `orders`,
 * `reservations`, `extension-conflicts`) mengantre pada satu koneksi. Dengan
 * `maxWait` default Prisma (2 detik), request yang mengantre lebih lama gagal
 * `P2028` dan berubah menjadi HTTP 500 intermiten.
 *
 * Test ini memaksa pool = 1, menjalankan `CONCURRENT` transaksi tenant-scoped
 * secara serentak, dan menahan tiap transaksi selama `HOLD_MS` sehingga total
 * antrean jauh melewati 2 detik. Jadi test gagal bila anggaran tunggu transaksi
 * kembali ke default, atau bila helper RLS berhenti memakai jalur transaksi
 * bersama. Butuh PostgreSQL (Gate 5 CI); biayanya hanya beberapa detik.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { WorkerModule } from '../../src/worker.module.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';

/** Tenant sembarang: `withTenant` hanya menyetel GUC, tidak memvalidasi baris. */
const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const CONCURRENT = 24;
/** 24 × 200 ms = 4,8 detik antrean total pada satu koneksi (> 2 detik default). */
const HOLD_MS = 200;

let app: INestApplication;
let prisma: PrismaService;
let previousPoolMax: string | undefined;

beforeAll(async () => {
  previousPoolMax = process.env.DATABASE_POOL_MAX;
  process.env.DATABASE_POOL_MAX = '1';
  app = await NestFactory.create(WorkerModule, { logger: false, abortOnError: false });
  await app.init();
  prisma = app.get(PrismaService);
}, 120_000);

afterAll(async () => {
  await app?.close();
  if (previousPoolMax === undefined) delete process.env.DATABASE_POOL_MAX;
  else process.env.DATABASE_POOL_MAX = previousPoolMax;
});

describe('antrean transaksi pada pool koneksi kecil', () => {
  it(`${CONCURRENT} transaksi paralel selesai tanpa P2028 saat pool = 1`, async () => {
    const startedAt = Date.now();
    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENT }, () =>
        prisma.withTenant(TENANT_ID, async (tx) => {
          // `pg_sleep` bertipe void; cast agar Prisma tidak gagal deserialisasi.
          await tx.$queryRaw`SELECT pg_sleep(0.2)::text AS slept`;
          return true;
        }),
      ),
    );
    const elapsedMs = Date.now() - startedAt;

    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => String((result.reason as Error | undefined)?.message ?? result.reason));
    expect(failures).toEqual([]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(CONCURRENT);

    // Antrean benar-benar lebih panjang dari anggaran default 2 detik: bila
    // pool tidak lagi dibatasi 1, test tetap lulus tetapi tidak lagi menjaga
    // regresi yang dimaksud.
    expect(elapsedMs).toBeGreaterThan(2_000);
  }, 60_000);
});
