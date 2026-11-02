import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@rentalio/database';
import type { AppConfig } from '../config/env.validation.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { SubscriptionPolicyService } from './subscription-policy.service.js';

interface CandidateRow {
  tenantId: string;
  subscriptionId: string;
}

export interface SubscriptionReconcileResult {
  /** Baris subscription yang masuk kriteria due dan dicoba. */
  scanned: number;
  /** Baris yang berhasil diubah menjadi RESTRICTED. */
  restricted: number;
  /** Baris yang ternyata belum due, sudah RESTRICTED, atau sudah bukan versi terbaru. */
  skipped: number;
  /** Baris yang gagal diproses; run berikutnya akan mencoba lagi. */
  failed: number;
}

/**
 * Reconciler status subscription.
 *
 * Guard mengevaluasi entitlement saat request, sehingga akses sudah tertutup
 * tepat waktu. Job ini menjaga agar kolom `subscriptions.status` juga
 * mencerminkan transisi tersebut (bukan hanya status efektif di memori):
 *
 * - TRIALING yang trial-nya berakhir → RESTRICTED
 * - ACTIVE/PAST_DUE yang grace-nya berakhir → RESTRICTED
 *
 * Scan lintas tenant memakai konteks baca `app.subscription_reconciler`
 * (migration 015, SELECT saja). Setiap transisi dijalankan ulang di transaksi
 * `app.tenant_id`, mengunci baris subscription, lalu dievaluasi dengan policy
 * yang sama seperti guard agar tidak ada aturan kedua yang menyimpang.
 *
 * Job idempoten: hanya status yang belum RESTRICTED yang diubah, dan audit
 * ditulis di transaksi yang sama. `CANCELLED`/`EXPIRED` tidak ditimpa karena
 * status efektifnya memang bukan RESTRICTED.
 */
@Injectable()
export class SubscriptionReconcilerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SubscriptionReconcilerService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: SubscriptionPolicyService,
    private readonly audit: AuditService,
    @Inject('APP_CONFIG') private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (!this.config.SUBSCRIPTION_RECONCILER_ENABLED) return;
    this.start();
  }

  onModuleDestroy(): void {
    this.stop();
  }

  /** Mulai polling periodik. Interval di-unref agar tidak menahan proses. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.SUBSCRIPTION_RECONCILE_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Satu putaran rekonsiliasi. `now` dapat diinjeksi untuk test batas waktu.
   * Kesalahan pada satu tenant tidak membatalkan tenant lain.
   */
  async runOnce(now: Date = new Date()): Promise<SubscriptionReconcileResult> {
    const runId = randomUUID();
    const candidates = await this.findDueCandidates(now);

    const result: SubscriptionReconcileResult = {
      scanned: candidates.length,
      restricted: 0,
      skipped: 0,
      failed: 0,
    };

    for (const candidate of candidates) {
      try {
        const outcome = await this.reconcileTenant(candidate, now, runId);
        result[outcome] += 1;
      } catch (err) {
        result.failed += 1;
        this.logger.error(
          `reconcile subscription gagal tenant=${candidate.tenantId}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (result.restricted > 0 || result.failed > 0) {
      this.logger.log(
        `subscription reconcile: scanned=${result.scanned} ` +
          `restricted=${result.restricted} skipped=${result.skipped} ` +
          `failed=${result.failed}`,
      );
    }
    return result;
  }

  /**
   * Ambil subscription TERBARU per tenant yang sudah melewati trial/grace.
   * Memakai `DISTINCT ON` agar baris lama tidak terus dipindai ketika tenant
   * sudah punya subscription yang lebih baru.
   */
  private async findDueCandidates(now: Date): Promise<CandidateRow[]> {
    return this.prisma.withSubscriptionReconciler((tx) =>
      tx.$queryRaw<CandidateRow[]>(Prisma.sql`
        WITH latest AS (
          SELECT DISTINCT ON (s."tenantId") s.*
          FROM "subscriptions" s
          ORDER BY s."tenantId", s."createdAt" DESC, s."id" DESC
        )
        SELECT
          s."tenantId" AS "tenantId",
          s."id" AS "subscriptionId"
        FROM latest s
        JOIN "tenants" t ON t."id" = s."tenantId"
        WHERE
          (
            s.status = 'TRIALING'
            AND (
              COALESCE(
                s."trialEndsAt",
                t."trialEndsAt",
                t."activatedAt" + INTERVAL '72 hours'
              ) IS NULL
              OR COALESCE(
                s."trialEndsAt",
                t."trialEndsAt",
                t."activatedAt" + INTERVAL '72 hours'
              ) <= ${now}
            )
          )
          OR (
            s.status = 'ACTIVE'
            AND s."periodEnd" IS NOT NULL
            AND s."periodEnd" <= ${now}
            AND COALESCE(
              s."graceEndsAt",
              s."periodEnd" + INTERVAL '3 days'
            ) <= ${now}
          )
          OR (
            s.status = 'PAST_DUE'
            AND (
              COALESCE(
                s."graceEndsAt",
                s."periodEnd" + INTERVAL '3 days',
                s."graceStartedAt" + INTERVAL '3 days'
              ) IS NULL
              OR COALESCE(
                s."graceEndsAt",
                s."periodEnd" + INTERVAL '3 days',
                s."graceStartedAt" + INTERVAL '3 days'
              ) <= ${now}
            )
          )
        ORDER BY s."updatedAt" ASC, s."id" ASC
        LIMIT ${this.config.SUBSCRIPTION_RECONCILE_BATCH_SIZE}
      `),
    );
  }

  /** Evaluasi ulang + transisi dalam konteks tenant yang sama dengan guard. */
  private async reconcileTenant(
    candidate: CandidateRow,
    now: Date,
    runId: string,
  ): Promise<'restricted' | 'skipped'> {
    return this.prisma.withTenant(candidate.tenantId, async (tx) => {
      // Serialisasi dengan billing/webhook yang mungkin mengaktifkan subscription
      // bersamaan. Setelah lock didapat, status yang dibaca adalah status final.
      await tx.$queryRaw`
        SELECT id FROM subscriptions
        WHERE "tenantId" = ${candidate.tenantId}
          AND id = ${candidate.subscriptionId}
        FOR UPDATE
      `;

      const subscription = await tx.subscription.findFirst({
        where: { tenantId: candidate.tenantId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      // Bukan lagi subscription terbaru → policy guard juga memakai yang lain.
      if (!subscription || subscription.id !== candidate.subscriptionId) {
        return 'skipped';
      }
      if (subscription.status === 'RESTRICTED') return 'skipped';

      const tenant = await tx.tenant.findUnique({
        where: { id: candidate.tenantId },
        select: { id: true, activatedAt: true, trialEndsAt: true },
      });
      if (!tenant) return 'skipped';

      const entitlement = this.policy.compute(tenant, subscription, now);
      if (entitlement.status !== 'RESTRICTED') return 'skipped';

      const updated = await tx.subscription.updateMany({
        where: { id: subscription.id, status: subscription.status },
        data: { status: 'RESTRICTED' },
      });
      if (updated.count === 0) return 'skipped';

      await this.audit.record(
        {
          tenantId: candidate.tenantId,
          action: 'SUBSCRIPTION_RESTRICTED',
          domain: 'billing',
          entityType: 'subscription',
          entityId: subscription.id,
          fromState: subscription.status,
          toState: 'RESTRICTED',
          reason: entitlement.reason,
          correlationId: runId,
          metadata: {
            source: 'subscription_reconciler',
            runId,
            trialEndsAt: entitlement.trialEndsAt?.toISOString() ?? null,
            graceEndsAt: entitlement.graceEndsAt?.toISOString() ?? null,
            periodEnd: entitlement.periodEnd?.toISOString() ?? null,
          },
        },
        tx,
      );

      return 'restricted';
    });
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runOnce();
    } catch (err) {
      this.logger.error(
        `subscription reconcile run gagal: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.running = false;
    }
  }
}
