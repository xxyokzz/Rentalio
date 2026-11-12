#!/usr/bin/env node
/**
 * Seed fixture E2E untuk Playwright (`apps/web/e2e`).
 *
 * Masalah yang diselesaikan: spec e2e mengandalkan data lokal yang tidak pernah
 * dibuat skrip mana pun — akun `demo@rentalio.test`, tenant `demo-sewa`
 * ("Rental Kamera Bandung"), dua kategori, dan tiga produk (Canon EOS R50,
 * DJI Mic 2, Sony A7 III). Tanpa data itu project `setup` gagal login (401) dan
 * seluruh spec yang bergantung pada `storageState` tidak berjalan. Seed resmi
 * (`database/prisma/seed.mjs`) sengaja tidak membuat user/password.
 *
 * Sifat idempoten: setiap bagian diperiksa dulu dan hanya yang belum ada yang
 * dibuat. Menjalankan ulang tidak menambah baris baru. Bila password fixture
 * tidak cocok lagi, hash-nya disetel ulang agar login E2E selalu bekerja.
 *
 * Langganan dibuat ACTIVE (bukan TRIALING) dengan periode 365 hari supaya
 * `catalog_editor.spec.ts` tidak gagal `403 TENANT_RESTRICTED` setelah trial
 * 72 jam habis — pengganti `activate_demo_subscription.mjs` untuk fixture ini.
 *
 * RLS: tabel tenant-scoped memakai FORCE ROW LEVEL SECURITY dengan
 * `WITH CHECK` berbasis `app.tenant_id` (lihat migration
 * `20261015011000_rls_constraints_triggers`). Karena itu:
 *   - user ditulis tanpa konteks (tabel `users` tidak ber-RLS),
 *   - tenant dicari lewat konteks publik `app.public_tenant_slug` sebelum id-nya
 *     diketahui (policy `tenants_public_slug_read`),
 *   - tenant, membership, subscription, kategori, produk, dan aset ditulis dalam
 *     transaksi dengan `set_config('app.tenant_id', ..., true)`.
 *
 * Pemakaian (root repo, setelah `pnpm --filter @rentalio/database build`):
 *   pnpm qa:seed:e2e
 *   node database/prisma/seed-e2e.mjs --dry-run
 *
 * Override opsional: E2E_EMAIL, E2E_PASSWORD, E2E_TENANT_SLUG, E2E_TENANT_NAME.
 * Kredensial fixture tidak pernah dicetak.
 */
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import dotenv from 'dotenv';
import { PrismaClient } from '../dist/index.js';
import { PrismaPg } from '@prisma/adapter-pg';

// Muat .env root repo (bukan cwd database/), sama seperti skrip fixture lain.
dotenv.config({
  path: new URL('../../.env', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
});

const dryRun = process.argv.includes('--dry-run');

/**
 * Deskripsi produk fixture sengaja TIDAK memuat nama produk: halaman inventaris
 * merender nama sebagai tautan + deskripsi, sehingga `getByText("Canon EOS R50")`
 * di spec jadi ambigu (strict mode) bila deskripsi mengulang nama produk.
 */
const PRODUCT_DESCRIPTION = 'Unit sewa harian (fixture E2E).';

const FIXTURE = {
  email: (process.env.E2E_EMAIL ?? 'demo@rentalio.test').trim().toLowerCase(),
  password: process.env.E2E_PASSWORD ?? 'DemoRentalio2026!',
  ownerName: 'Demo Owner',
  tenantSlug: process.env.E2E_TENANT_SLUG ?? 'demo-sewa',
  tenantName: process.env.E2E_TENANT_NAME ?? 'Rental Kamera Bandung',
  subscriptionDays: 365,
  categories: ['Kamera', 'Audio & Aksesori'],
  products: [
    { name: 'Canon EOS R50', category: 'Kamera', perDay: 150_000n, assetCode: 'CANON-R50-01' },
    { name: 'Sony A7 III', category: 'Kamera', perDay: 250_000n, assetCode: 'SONY-A7III-01' },
    { name: 'DJI Mic 2', category: 'Audio & Aksesori', perDay: 75_000n, assetCode: 'DJI-MIC2-01' },
  ],
};

/** Hash password dengan format & parameter identik `apps/api/src/common/crypto.ts`. */
function hashPassword(password) {
  const params = { N: 16384, r: 8, p: 1, keylen: 64 };
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, params.keylen, { N: params.N, r: params.r, p: params.p });
  return ['scrypt', params.N, params.r, params.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

function passwordMatches(password, stored) {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(nStr),
    r: Number(rStr),
    p: Number(pStr),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

/** 1. User fixture: status ACTIVE + email terverifikasi + password yang benar. */
async function ensureUser() {
  const existing = await prisma.user.findUnique({ where: { email: FIXTURE.email } });

  if (dryRun) {
    return { id: existing?.id ?? null, changed: false, created: !existing, notes: existing ? [] : ['user'] };
  }

  if (!existing) {
    const user = await prisma.user.create({
      data: {
        email: FIXTURE.email,
        passwordHash: hashPassword(FIXTURE.password),
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
        ownerName: FIXTURE.ownerName,
        tenantName: FIXTURE.tenantName,
        tenantSlug: FIXTURE.tenantSlug,
      },
    });
    return { id: user.id, changed: true, created: true, notes: ['user'] };
  }

  const data = {};
  const notes = [];
  if (existing.status !== 'ACTIVE') {
    data.status = 'ACTIVE';
    notes.push('status user');
  }
  if (!existing.emailVerifiedAt) {
    data.emailVerifiedAt = new Date();
    notes.push('verifikasi email');
  }
  if (!passwordMatches(FIXTURE.password, existing.passwordHash)) {
    data.passwordHash = hashPassword(FIXTURE.password);
    notes.push('password');
  }
  if (Object.keys(data).length > 0) await prisma.user.update({ where: { id: existing.id }, data });
  return { id: existing.id, changed: notes.length > 0, created: false, notes };
}

/**
 * 2. Cari tenant berdasarkan slug. Sebelum id diketahui, RLS hanya membuka
 *    baris yang slug-nya cocok dengan `app.public_tenant_slug`.
 */
async function findTenantId(userId) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.public_tenant_slug', ${FIXTURE.tenantSlug}, true)`;
    const tenant = await tx.tenant.findFirst({
      where: { slug: FIXTURE.tenantSlug },
      select: { id: true },
    });
    if (tenant) return tenant.id;

    // Cadangan: baca lewat konteks aktor bila user sudah menjadi anggota.
    await tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`;
    const viaActor = await tx.tenant.findFirst({
      where: { slug: FIXTURE.tenantSlug },
      select: { id: true },
    });
    return viaActor?.id ?? null;
  });
}

/** 3. Tenant + membership OWNER + subscription ACTIVE, semua dalam satu konteks. */
async function ensureTenantAndSubscription(userId, existingTenantId) {
  // Plan platform `free` dipasang migration `20261027130000_default_platform_plan`.
  // Bila database test sudah direset tetapi baris itu hilang, buat ulang di sini
  // (idempoten, sama seperti `database/prisma/seed.mjs`) agar seed tidak gagal.
  let plan = await prisma.plan.findFirst({
    where: { tenantId: null, code: 'free', isActive: true },
    select: { id: true },
  });
  if (!plan && !dryRun) {
    plan = await prisma.plan.create({
      data: { tenantId: null, code: 'free', name: 'Free', priceAmount: 0n, currency: 'IDR', isActive: true },
      select: { id: true },
    });
  }
  if (!plan) {
    throw new Error('Plan platform `free` tidak ada — jalankan migrasi/seeding database lebih dulu.');
  }

  const now = new Date();
  const periodEnd = new Date(now.getTime() + FIXTURE.subscriptionDays * 24 * 3600 * 1000);
  const tenantId = existingTenantId ?? randomUUID();

  if (dryRun) {
    return { tenantId, changed: false, created: !existingTenantId, notes: existingTenantId ? [] : ['tenant'] };
  }

  const notes = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    const changes = [];

    const tenant = await tx.tenant.findFirst({ where: { id: tenantId } });
    if (!tenant) {
      await tx.tenant.create({
        data: {
          id: tenantId,
          slug: FIXTURE.tenantSlug,
          name: FIXTURE.tenantName,
          status: 'ACTIVE',
          timezone: 'Asia/Jakarta',
          currency: 'IDR',
          activatedAt: now,
          // Fixture ini mendapat entitlement dari subscription ACTIVE di bawah,
          // bukan dari masa coba. Tanggal trial 72 jam akan bertentangan dengan
          // status "Aktif" di direktori admin dan memicu banner trial di web.
          trialEndsAt: null,
        },
      });
      changes.push('tenant');
    }

    const membership = await tx.tenantMembership.findFirst({
      where: { tenantId, userId },
    });
    if (!membership) {
      await tx.tenantMembership.create({
        data: {
          tenantId,
          userId,
          role: 'OWNER',
          status: 'ACTIVE',
          permissions: [],
          activatedAt: now,
        },
      });
      changes.push('membership');
    } else if (membership.status !== 'ACTIVE' || membership.role !== 'OWNER') {
      await tx.tenantMembership.update({
        where: { id: membership.id },
        data: { status: 'ACTIVE', role: 'OWNER', revokedAt: null, activatedAt: membership.activatedAt ?? now },
      });
      changes.push('membership (diaktifkan)');
    }

    const latest = await tx.subscription.findFirst({
      where: { tenantId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (!latest) {
      await tx.subscription.create({
        data: {
          tenantId,
          planId: plan.id,
          status: 'ACTIVE',
          activatedAt: now,
          periodStart: now,
          periodEnd,
          providerRef: 'dev-fixture:seed-e2e',
        },
      });
      changes.push('subscription');
    } else if (latest.status !== 'ACTIVE' || !latest.periodEnd || latest.periodEnd <= now) {
      await tx.subscription.update({
        where: { id: latest.id },
        data: {
          status: 'ACTIVE',
          planId: plan.id,
          activatedAt: latest.activatedAt ?? now,
          periodStart: now,
          periodEnd,
          graceStartedAt: null,
          graceEndsAt: null,
          cancelledAt: null,
          expiredAt: null,
        },
      });
      changes.push('subscription (diperpanjang)');
    }

    // Rapikan data lama: tenant fixture yang masih membawa tanggal trial padahal
    // langganannya sudah ACTIVE membuat direktori admin menampilkan
    // "Trial berakhir <dekat>" untuk tenant berstatus Aktif.
    const activeSubscription = await tx.subscription.findFirst({
      where: { tenantId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (activeSubscription && tenant?.trialEndsAt) {
      await tx.tenant.update({ where: { id: tenantId }, data: { trialEndsAt: null } });
      changes.push('tenant (trialEndsAt dikosongkan, entitlement dari subscription ACTIVE)');
    }

    return changes;
  });

  return { tenantId, changed: notes.length > 0, created: !existingTenantId, notes };
}

/** 4. Katalog fixture: kategori, produk, rate, dan satu unit aset per produk. */
async function ensureCatalog(tenantId) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    const changes = [];

    const categoryIds = new Map();
    for (const name of FIXTURE.categories) {
      const existing = await tx.category.findFirst({ where: { tenantId, name } });
      if (existing) {
        categoryIds.set(name, existing.id);
        continue;
      }
      if (dryRun) {
        categoryIds.set(name, null);
        changes.push(`kategori ${name}`);
        continue;
      }
      const created = await tx.category.create({ data: { tenantId, name } });
      categoryIds.set(name, created.id);
      changes.push(`kategori ${name}`);
    }

    for (const product of FIXTURE.products) {
      let row = await tx.product.findFirst({ where: { tenantId, name: product.name } });
      if (!row && !dryRun) {
        row = await tx.product.create({
          data: {
            tenantId,
            categoryId: categoryIds.get(product.category) ?? null,
            name: product.name,
            description: PRODUCT_DESCRIPTION,
            stockMode: 'INDIVIDUAL_UNITS',
            capacity: 1,
            isActive: true,
          },
        });
        changes.push(`produk ${product.name}`);
      } else if (!row) {
        changes.push(`produk ${product.name}`);
        continue;
      } else if (row.description !== PRODUCT_DESCRIPTION) {
        // Perbaikan idempoten untuk baris lama (deskripsi dulu memuat nama produk).
        row = await tx.product.update({
          where: { id: row.id },
          data: { description: PRODUCT_DESCRIPTION },
        });
        changes.push(`deskripsi ${product.name}`);
      }

      const rate = await tx.rate.findFirst({ where: { tenantId, productId: row.id } });
      if (!rate && !dryRun) {
        await tx.rate.create({
          data: {
            tenantId,
            productId: row.id,
            perDayAmount: product.perDay,
            perWeekAmount: product.perDay * 6n,
            perMonthAmount: product.perDay * 20n,
          },
        });
        changes.push(`rate ${product.name}`);
      } else if (!rate) {
        changes.push(`rate ${product.name}`);
      }

      const asset = await tx.asset.findFirst({ where: { tenantId, productId: row.id } });
      if (!asset && !dryRun) {
        await tx.asset.create({
          data: { tenantId, productId: row.id, code: product.assetCode, status: 'AVAILABLE' },
        });
        changes.push(`aset ${product.assetCode}`);
      } else if (!asset) {
        changes.push(`aset ${product.assetCode}`);
      }
    }

    return changes;
  });
}

async function main() {
  if (dryRun) console.log('--dry-run: tidak ada yang ditulis ke database.\n');

  const user = await ensureUser();
  if (!user.id && dryRun) {
    console.log(`Akan dibuat: user ${FIXTURE.email}, tenant ${FIXTURE.tenantSlug}, ${FIXTURE.categories.length} kategori, ${FIXTURE.products.length} produk + aset, subscription ACTIVE.`);
    return;
  }
  if (!user.id) throw new Error('User fixture gagal dibuat.');

  const existingTenantId = await findTenantId(user.id);
  const tenant = await ensureTenantAndSubscription(user.id, existingTenantId);

  let catalogChanges = [];
  if (!dryRun) {
    catalogChanges = await ensureCatalog(tenant.tenantId);
  }

  const notes = [...user.notes, ...tenant.notes, ...catalogChanges];
  const emailMasked = FIXTURE.email.replace(/^(.).*(@.*)$/, '$1***$2');

  console.log(`Fixture E2E: ${emailMasked} → tenant ${FIXTURE.tenantSlug} (${FIXTURE.tenantName})`);
  if (notes.length === 0) {
    console.log('Tidak ada perubahan: fixture sudah lengkap dan idempoten.');
  } else {
    console.log(`Dibuat/diperbarui (${notes.length}): ${notes.join(', ')}`);
  }
  console.log('Selesai. Jalankan: pnpm --filter @rentalio/web test:e2e --project=desktop');
}

main()
  .catch((error) => {
    console.error('Seed fixture E2E gagal:', error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
