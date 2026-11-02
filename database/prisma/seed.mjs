/**
 * Seed data sintetis untuk development.
 * Aturan (dokumen 03): hanya data sintetis/non-rahasia; aman diulang;
 * tidak menyimpan data pribadi nyata; jangan hard-code harga komersial —
 * karena itu plan di bawah memakai harga 0 dan ditandai sebagai contoh.
 *
 * Seed ini TIDAK membuat user/password nyata.
 */
// Prisma 7 men-generate client ke `src/generated/client` (berkas .ts, lihat
// schema.prisma), sehingga skrip Node ini memakai entry hasil build package:
// `dist/index.js`. Jalankan `pnpm --filter @rentalio/database build` lebih dulu
// bila dist belum ada. Path lama `../prisma/generated/client/index.js`
// menunjuk direktori yang tidak pernah dibuat → ERR_MODULE_NOT_FOUND.
import { PrismaClient } from '../dist/index.js';
import { PrismaPg } from '@prisma/adapter-pg';
import 'dotenv/config';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  // Plan platform default (bukan keputusan komersial).
  //
  // Code `free` WAJIB sama dengan yang dicari `TenantService.createTenant`
  // ketika membuat subscription TRIALING; kalau berbeda, tenant baru tidak
  // mendapat baris subscription sama sekali. Migration
  // `20261027130000_default_platform_plan` memasang baris yang sama untuk
  // database bersih (CI/production), sehingga seed ini idempoten dengannya.
  // `upsert` tidak dapat dipakai untuk baris platform-wide: where unik gabungan
  // (tenantId, code) menolak `tenantId: null` ("Argument `tenantId` must not be
  // null"). Karena itu keberadaannya dijaga dengan findFirst + create.
  const existingPlan = await prisma.plan.findFirst({
    where: { tenantId: null, code: 'free' },
  });
  if (!existingPlan) {
    await prisma.plan.create({
      data: {
        tenantId: null,
        code: 'free',
        name: 'Free',
        priceAmount: 0n,
        currency: 'IDR',
        isActive: true,
      },
    });
  }

  // Tenant contoh + membership OWNER sintetis butuh user; dilewati di seed.
  // Sprint berikutnya menambahkan seed tenant/katalog sintetis.
  console.log('Seed selesai: 1 plan platform default (free).');
}

main()
  .catch((e) => {
    console.error('Seed gagal:', e.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
