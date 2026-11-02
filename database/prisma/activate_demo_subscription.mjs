/**
 * Aktivasi langganan tenant demo (fixture development).
 *
 * Tenant demo (`demo-sewa` = "Rental Kamera Bandung") tidak punya baris
 * `subscriptions`, sehingga entitlement-nya hanya trial 72 jam. Setelah trial
 * habis, `SubscriptionPolicyService` menandai tenant RESTRICTED dan menolak
 * command katalog/transaksi dengan 403 TENANT_RESTRICTED — yang membuat
 * `e2e/catalog_editor.spec.ts` tes 9 (simpan draf) gagal.
 *
 * Skrip ini menulis satu subscription ACTIVE dengan periode berjalan, memakai
 * plan platform `free` (harga 0) yang dipasang migration
 * `20261027130000_default_platform_plan`. Idempoten: bila subscription terbaru
 * sudah ACTIVE dengan `periodEnd` di masa depan, tidak ada yang diubah.
 *
 * Jalankan dari root repo:
 *   node database/prisma/activate_demo_subscription.mjs
 *
 * Override opsional: `DEMO_EMAIL`, `DEMO_TENANT_SLUG`, `SUBSCRIPTION_DAYS`.
 *
 * Catatan: RLS fail-closed tanpa konteks, jadi tenants dibaca dengan konteks
 * aktor (`app.user_id`) dan subscription ditulis dalam konteks tenant
 * (`app.tenant_id`) — sama seperti `PrismaService.withActor/withTenant`.
 */
import dotenv from 'dotenv';
import { PrismaClient } from '../dist/index.js';
import { PrismaPg } from '@prisma/adapter-pg';

dotenv.config({
  path: new URL('../../.env', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
});

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const EMAIL = process.env.DEMO_EMAIL ?? 'demo@rentalio.test';
const SLUG = process.env.DEMO_TENANT_SLUG ?? 'demo-sewa';
const DAYS = Number(process.env.SUBSCRIPTION_DAYS ?? 365);

async function main() {
  const user = await prisma.user.findUnique({ where: { email: EMAIL }, select: { id: true } });
  if (!user) throw new Error(`User demo tidak ditemukan: ${EMAIL}`);

  const tenant = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.user_id', ${user.id}, true)`;
    return tx.tenant.findFirst({ where: { slug: SLUG }, select: { id: true, name: true } });
  });
  if (!tenant) throw new Error(`Tenant dengan slug ${SLUG} tidak terlihat untuk ${EMAIL}`);

  const plan = await prisma.plan.findFirst({
    where: { tenantId: null, code: 'free', isActive: true },
    select: { id: true, code: true },
  });
  if (!plan) throw new Error('Plan platform `free` tidak ada — jalankan seed atau migration dulu.');

  const now = new Date();
  const periodEnd = new Date(now.getTime() + DAYS * 24 * 3600 * 1000);

  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenant.id}, true)`;

    const latest = await tx.subscription.findFirst({
      where: { tenantId: tenant.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    if (latest && latest.status === 'ACTIVE' && latest.periodEnd && latest.periodEnd > now) {
      return { changed: false, subscription: latest };
    }

    if (latest) {
      const subscription = await tx.subscription.update({
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
      return { changed: true, subscription };
    }

    const subscription = await tx.subscription.create({
      data: {
        tenantId: tenant.id,
        planId: plan.id,
        status: 'ACTIVE',
        activatedAt: now,
        periodStart: now,
        periodEnd,
        providerRef: 'dev-fixture:activate_demo_subscription',
      },
    });
    return { changed: true, subscription };
  });

  console.log(
    `${tenant.name} (${SLUG}) — subscription ${result.subscription.id} ` +
      `${result.changed ? 'diaktifkan' : 'sudah aktif'}: ` +
      `status=${result.subscription.status} plan=${plan.code} ` +
      `periodEnd=${result.subscription.periodEnd?.toISOString() ?? '—'}`,
  );
}

main()
  .catch((error) => {
    console.error('Aktivasi gagal:', error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
