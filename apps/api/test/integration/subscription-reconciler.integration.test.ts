/**
 * Integration test: reconciler status subscription.
 *
 * Kontrak:
 * - TRIALING yang trial-nya berakhir (termasuk tepat di batas) → RESTRICTED.
 * - ACTIVE/PAST_DUE yang grace-nya berakhir → RESTRICTED; yang masih grace tetap.
 * - CANCELLED/EXPIRED tidak ditimpa.
 * - Transisi menulis audit SUBSCRIPTION_RESTRICTED di tenant yang sama.
 * - Idempoten dan tidak membocorkan konteks baca lintas tenant.
 *
 * Berjalan terhadap PostgreSQL sewain_test dengan role runtime (RLS aktif).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';

import { WorkerModule } from '../../src/worker.module.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { SubscriptionReconcilerService } from '../../src/subscriptions/subscription-reconciler.service.js';

const NOW = new Date('2026-10-20T12:00:00.000Z');
const DAY = 24 * 3600 * 1000;
/** Agar kandidat test diproses lebih dulu dalam batch global. */
const OLD = new Date('2000-01-01T00:00:00.000Z');

let app: INestApplication;
let prisma: PrismaService;
let reconciler: SubscriptionReconcilerService;

type SubscriptionDbStatus =
  | 'TRIALING'
  | 'ACTIVE'
  | 'PAST_DUE'
  | 'RESTRICTED'
  | 'CANCELLED'
  | 'EXPIRED';

interface SubscriptionSeed {
  status: SubscriptionDbStatus;
  trialEndsAt?: Date | null;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  graceStartedAt?: Date | null;
  graceEndsAt?: Date | null;
  /** Urutan createdAt; subscription terbaru dipakai policy guard. */
  createdAt?: Date;
}

interface TenantSeed {
  activatedAt: Date | null;
  trialEndsAt: Date | null;
  subscriptions: SubscriptionSeed[];
}

interface SeededTenant {
  tenantId: string;
  subscriptionIds: string[];
}

function uid(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

async function seedTenant(prefix: string, seed: TenantSeed): Promise<SeededTenant> {
  const tenantId = randomUUID();
  const subscriptionIds: string[] = [];

  await prisma.withTenant(tenantId, async (tx) => {
    await tx.tenant.create({
      data: {
        id: tenantId,
        slug: uid(prefix),
        name: `Tenant ${prefix}`,
        status: 'ACTIVE',
        activatedAt: seed.activatedAt,
        trialEndsAt: seed.trialEndsAt,
        createdAt: OLD,
        updatedAt: OLD,
      },
    });

    let plan = await tx.plan.findFirst({ where: { tenantId: null, code: 'free' } });
    if (!plan) {
      plan = await tx.plan.create({ data: { code: 'free', name: 'Free' } });
    }

    for (const [index, subscription] of seed.subscriptions.entries()) {
      const created = await tx.subscription.create({
        data: {
          tenantId,
          planId: plan.id,
          status: subscription.status,
          trialEndsAt: subscription.trialEndsAt ?? null,
          periodStart: subscription.periodStart ?? null,
          periodEnd: subscription.periodEnd ?? null,
          graceStartedAt: subscription.graceStartedAt ?? null,
          graceEndsAt: subscription.graceEndsAt ?? null,
          createdAt: subscription.createdAt ?? new Date(OLD.getTime() + index * 1000),
          updatedAt: OLD,
        },
      });
      subscriptionIds.push(created.id);
    }
  });

  return { tenantId, subscriptionIds };
}

async function getSubscription(tenantId: string, subscriptionId: string) {
  return prisma.withTenant(tenantId, (tx) =>
    tx.subscription.findUniqueOrThrow({ where: { id: subscriptionId } }),
  );
}

async function getAudits(tenantId: string, action = 'SUBSCRIPTION_RESTRICTED') {
  return prisma.withTenant(tenantId, (tx) =>
    tx.auditLog.findMany({ where: { tenantId, action }, orderBy: { createdAt: 'asc' } }),
  );
}

beforeAll(async () => {
  app = await NestFactory.create(WorkerModule, { logger: false, abortOnError: false });
  await app.init();
  prisma = app.get(PrismaService);
  reconciler = app.get(SubscriptionReconcilerService);
}, 120_000);

afterAll(() => app?.close());

describe('Subscription reconciler — transisi status', () => {
  it('trial tepat berakhir → RESTRICTED + audit sekali, lalu idempoten', async () => {
    const { tenantId, subscriptionIds } = await seedTenant('recon-trial', {
      activatedAt: new Date(NOW.getTime() - 3 * DAY),
      trialEndsAt: NOW,
      subscriptions: [{ status: 'TRIALING', trialEndsAt: NOW }],
    });

    const result = await reconciler.runOnce(NOW);
    expect(result.scanned).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBe(0);

    const subscription = await getSubscription(tenantId, subscriptionIds[0]);
    expect(subscription.status).toBe('RESTRICTED');

    const audits = await getAudits(tenantId);
    expect(audits).toHaveLength(1);
    expect(audits[0].domain).toBe('billing');
    expect(audits[0].entityType).toBe('subscription');
    expect(audits[0].entityId).toBe(subscriptionIds[0]);
    expect(audits[0].fromState).toBe('TRIALING');
    expect(audits[0].toState).toBe('RESTRICTED');
    expect(audits[0].reason).toBe('TRIAL_EXPIRED');
    expect(audits[0].correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    const metadata = audits[0].metadata as Record<string, unknown>;
    expect(metadata.source).toBe('subscription_reconciler');
    expect(metadata.trialEndsAt).toBe(NOW.toISOString());

    // Putaran kedua tidak mengubah apa pun dan tidak menulis audit ganda.
    await reconciler.runOnce(new Date(NOW.getTime() + 60_000));
    expect((await getSubscription(tenantId, subscriptionIds[0])).status).toBe('RESTRICTED');
    expect(await getAudits(tenantId)).toHaveLength(1);

    // Konteks baca sistem bersifat transaction-scoped: tidak bocor ke query biasa.
    const withoutContext = await prisma.client.subscription.findMany({
      where: { tenantId },
    });
    expect(withoutContext).toHaveLength(0);
  });

  it('ACTIVE/PAST_DUE hanya diubah setelah grace berakhir; trial berjalan tetap', async () => {
    const activePastGrace = await seedTenant('recon-active', {
      activatedAt: new Date(NOW.getTime() - 40 * DAY),
      trialEndsAt: new Date(NOW.getTime() - 30 * DAY),
      subscriptions: [
        {
          status: 'ACTIVE',
          periodStart: new Date(NOW.getTime() - 34 * DAY),
          periodEnd: new Date(NOW.getTime() - 4 * DAY),
        },
      ],
    });
    const pastDueInGrace = await seedTenant('recon-grace', {
      activatedAt: new Date(NOW.getTime() - 40 * DAY),
      trialEndsAt: new Date(NOW.getTime() - 30 * DAY),
      subscriptions: [
        {
          status: 'PAST_DUE',
          periodStart: new Date(NOW.getTime() - 31 * DAY),
          periodEnd: new Date(NOW.getTime() - DAY),
          graceStartedAt: new Date(NOW.getTime() - DAY),
          graceEndsAt: new Date(NOW.getTime() + DAY),
        },
      ],
    });
    const pastDueGraceEnded = await seedTenant('recon-grace-end', {
      activatedAt: new Date(NOW.getTime() - 40 * DAY),
      trialEndsAt: new Date(NOW.getTime() - 30 * DAY),
      subscriptions: [
        {
          status: 'PAST_DUE',
          periodStart: new Date(NOW.getTime() - 31 * DAY),
          periodEnd: new Date(NOW.getTime() - 4 * DAY),
          graceStartedAt: new Date(NOW.getTime() - 4 * DAY),
          graceEndsAt: NOW,
        },
      ],
    });
    const trialFuture = await seedTenant('recon-trial-future', {
      activatedAt: new Date(NOW.getTime() - DAY),
      trialEndsAt: new Date(NOW.getTime() + DAY),
      subscriptions: [
        { status: 'TRIALING', trialEndsAt: new Date(NOW.getTime() + DAY) },
      ],
    });

    await reconciler.runOnce(NOW);

    const active = await getSubscription(
      activePastGrace.tenantId,
      activePastGrace.subscriptionIds[0],
    );
    expect(active.status).toBe('RESTRICTED');
    const activeAudit = await getAudits(activePastGrace.tenantId);
    expect(activeAudit).toHaveLength(1);
    expect(activeAudit[0].reason).toBe('GRACE_EXPIRED');

    const inGrace = await getSubscription(
      pastDueInGrace.tenantId,
      pastDueInGrace.subscriptionIds[0],
    );
    expect(inGrace.status).toBe('PAST_DUE');
    expect(await getAudits(pastDueInGrace.tenantId)).toHaveLength(0);

    // Tepat di batas grace sudah restricted (policy memakai now < graceEndsAt).
    const ended = await getSubscription(
      pastDueGraceEnded.tenantId,
      pastDueGraceEnded.subscriptionIds[0],
    );
    expect(ended.status).toBe('RESTRICTED');
    expect(await getAudits(pastDueGraceEnded.tenantId)).toHaveLength(1);

    const trial = await getSubscription(trialFuture.tenantId, trialFuture.subscriptionIds[0]);
    expect(trial.status).toBe('TRIALING');
    expect(await getAudits(trialFuture.tenantId)).toHaveLength(0);
  });

  it('CANCELLED dan EXPIRED tidak ditimpa menjadi RESTRICTED', async () => {
    const cancelled = await seedTenant('recon-cancelled', {
      activatedAt: new Date(NOW.getTime() - 40 * DAY),
      trialEndsAt: new Date(NOW.getTime() - 30 * DAY),
      subscriptions: [
        {
          status: 'CANCELLED',
          periodEnd: new Date(NOW.getTime() - 30 * DAY),
        },
      ],
    });
    const expired = await seedTenant('recon-expired', {
      activatedAt: new Date(NOW.getTime() - 40 * DAY),
      trialEndsAt: new Date(NOW.getTime() - 30 * DAY),
      subscriptions: [
        {
          status: 'EXPIRED',
          periodEnd: new Date(NOW.getTime() - 30 * DAY),
        },
      ],
    });

    await reconciler.runOnce(NOW);

    expect(
      (await getSubscription(cancelled.tenantId, cancelled.subscriptionIds[0])).status,
    ).toBe('CANCELLED');
    expect(
      (await getSubscription(expired.tenantId, expired.subscriptionIds[0])).status,
    ).toBe('EXPIRED');
    expect(await getAudits(cancelled.tenantId)).toHaveLength(0);
    expect(await getAudits(expired.tenantId)).toHaveLength(0);
  });

  it('hanya subscription terbaru yang dievaluasi; baris lama tidak dipaksa restricted', async () => {
    const tenant = await seedTenant('recon-latest', {
      activatedAt: new Date(NOW.getTime() - 40 * DAY),
      trialEndsAt: new Date(NOW.getTime() - 30 * DAY),
      subscriptions: [
        {
          status: 'TRIALING',
          trialEndsAt: new Date(NOW.getTime() - 30 * DAY),
          createdAt: new Date(OLD.getTime() + 1000),
        },
        {
          status: 'CANCELLED',
          periodEnd: new Date(NOW.getTime() - 5 * DAY),
          createdAt: new Date(OLD.getTime() + 2000),
        },
      ],
    });

    await reconciler.runOnce(NOW);

    const [oldTrial, latest] = await Promise.all(
      tenant.subscriptionIds.map((id) => getSubscription(tenant.tenantId, id)),
    );
    expect(oldTrial.status).toBe('TRIALING');
    expect(latest.status).toBe('CANCELLED');
    expect(await getAudits(tenant.tenantId)).toHaveLength(0);
  });
});
