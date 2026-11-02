import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma, SubscriptionInvoiceStatus } from '@rentalio/database';
import type { AppConfig } from '../config/env.validation.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { EmailService } from '../email/email.service.js';
import { composeOperatorReminder, type ReminderKind } from './billing-reminder.message.js';

interface ReminderCandidate {
  id: string;
  tenantId: string;
  amount: string;
  expiresAt: Date;
  createdAt: Date;
  operatorNotifiedAt: Date | null;
  expiryNotifiedAt: Date | null;
}

export interface BillingReminderResult {
  /** Tagihan yang masuk kriteria dan dicoba. */
  scanned: number;
  /** Email pengingat tahap pertama terkirim. */
  firstReminders: number;
  /** Email "mendekati kedaluwarsa" terkirim. */
  expiryReminders: number;
  /** Dilewati: sudah diklaim worker lain, tenant hilang, atau tagihan berubah status. */
  skipped: number;
  /** Gagal terkirim; klaim dikembalikan agar putaran berikutnya mencoba lagi. */
  failed: number;
}

/** Jeda antar-peringatan saat konfigurasi belum lengkap, agar log tidak spam. */
const UNCONFIGURED_WARN_INTERVAL_MS = 3_600_000;

/**
 * Pengingat tagihan langganan PENDING untuk operator platform.
 *
 * QRIS dinamis tidak mengirim callback, sehingga pembayaran hanya bisa
 * diverifikasi manusia. Tanpa pengingat, tagihan bisa menggantung tanpa ada
 * yang tahu. Job ini menutup celah tersebut dengan dua email:
 *
 *   1. **Tahap pertama** — tagihan sudah PENDING melewati
 *      `BILLING_REMINDER_MIN_AGE_SECONDS` (memberi waktu penyewa membayar dulu).
 *   2. **Mendekati kedaluwarsa** — sisa waktu <=
 *      `BILLING_REMINDER_EXPIRY_WINDOW_SECONDS`.
 *
 * Setiap email hanya dikirim sekali per tagihan: klaim memakai `updateMany`
 * bersyarat kolom penanda masih `NULL`, sehingga beberapa replika worker aman
 * berjalan paralel. Bila pengiriman gagal, klaim dikembalikan (`NULL`) agar
 * putaran berikutnya mencoba lagi — kegagalan sesaat tidak menghilangkan
 * pengingat secara permanen.
 *
 * Scan lintas tenant memakai konteks baca `app.billing_reminder` (migration 030,
 * SELECT saja). Klaim dan pembacaan identitas tenant dijalankan pada
 * `app.tenant_id`, sehingga RLS tenant tetap menjadi batas tulis.
 */
@Injectable()
export class BillingReminderService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BillingReminderService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastUnconfiguredWarnAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    @Inject('APP_CONFIG') private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (!this.config.BILLING_REMINDER_ENABLED) return;
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
    }, this.config.BILLING_REMINDER_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Satu putaran pengingat. `now` dapat diinjeksi untuk test batas waktu.
   * Kegagalan satu tagihan tidak membatalkan tagihan lain.
   */
  async runOnce(now: Date = new Date()): Promise<BillingReminderResult> {
    const result: BillingReminderResult = {
      scanned: 0,
      firstReminders: 0,
      expiryReminders: 0,
      skipped: 0,
      failed: 0,
    };

    const recipient = this.config.PLATFORM_OPERATOR_EMAIL;
    if (!recipient) {
      this.warnUnconfigured(now, 'PLATFORM_OPERATOR_EMAIL belum diisi');
      return result;
    }

    const candidates = await this.findCandidates(now);
    result.scanned = candidates.length;

    for (const candidate of candidates) {
      const kind: ReminderKind = candidate.operatorNotifiedAt ? 'EXPIRING' : 'FIRST';
      try {
        const claimed = await this.claim(candidate, kind, now);
        if (!claimed) {
          result.skipped += 1;
          continue;
        }

        const message = composeOperatorReminder({
          kind,
          tenantName: claimed.name,
          tenantSlug: claimed.slug,
          invoiceId: candidate.id,
          amount: Number(candidate.amount),
          expiresAt: candidate.expiresAt,
        });

        try {
          await this.email.send({ to: recipient, ...message });
        } catch (error) {
          await this.release(candidate.id, candidate.tenantId, kind, now);
          result.failed += 1;
          this.logger.warn(
            `gagal mengirim pengingat tagihan invoice=${candidate.id}: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }

        if (kind === 'FIRST') result.firstReminders += 1;
        else result.expiryReminders += 1;
      } catch (error) {
        result.failed += 1;
        this.logger.warn(
          `pengingat tagihan gagal invoice=${candidate.id}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (result.firstReminders > 0 || result.expiryReminders > 0 || result.failed > 0) {
      this.logger.log(
        `billing reminder: scanned=${result.scanned} first=${result.firstReminders} ` +
          `expiring=${result.expiryReminders} skipped=${result.skipped} failed=${result.failed}`,
      );
    }
    return result;
  }

  /**
   * Tagihan PENDING yang memenuhi salah satu tahap pengingat. Membaca lintas
   * tenant lewat konteks `app.billing_reminder` (SELECT saja).
   */
  private async findCandidates(now: Date): Promise<ReminderCandidate[]> {
    const firstCutoff = new Date(
      now.getTime() - this.config.BILLING_REMINDER_MIN_AGE_SECONDS * 1000,
    );
    const expiryCutoff = new Date(
      now.getTime() + this.config.BILLING_REMINDER_EXPIRY_WINDOW_SECONDS * 1000,
    );

    return this.prisma.withBillingReminder((tx) =>
      tx.$queryRaw<ReminderCandidate[]>(Prisma.sql`
        SELECT
          i."id"                 AS "id",
          i."tenantId"           AS "tenantId",
          i."amount"::text       AS "amount",
          i."expiresAt"          AS "expiresAt",
          i."createdAt"          AS "createdAt",
          i."operatorNotifiedAt" AS "operatorNotifiedAt",
          i."expiryNotifiedAt"   AS "expiryNotifiedAt"
        FROM "subscription_invoices" i
        WHERE i."status" = 'PENDING'
          AND i."expiresAt" > ${now}
          AND (
            (i."operatorNotifiedAt" IS NULL AND i."createdAt" <= ${firstCutoff})
            OR (
              i."operatorNotifiedAt" IS NOT NULL
              AND i."expiryNotifiedAt" IS NULL
              AND i."expiresAt" <= ${expiryCutoff}
            )
          )
        ORDER BY i."createdAt" ASC, i."id" ASC
        LIMIT ${this.config.BILLING_REMINDER_BATCH_SIZE}
      `),
    );
  }

  /**
   * Klaim satu tahap pengingat + baca identitas tenant dalam konteks tenant.
   * Mengembalikan identitas tenant bila klaim berhasil, `null` bila sudah
   * diklaim worker lain / tagihan tidak lagi PENDING / tenant hilang.
   */
  private async claim(
    candidate: ReminderCandidate,
    kind: ReminderKind,
    now: Date,
  ): Promise<{ name: string; slug: string } | null> {
    return this.prisma.withTenant(candidate.tenantId, async (tx) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: candidate.tenantId },
        select: { name: true, slug: true },
      });
      if (!tenant) return null;

      const claimed = await tx.subscriptionInvoice.updateMany({
        where:
          kind === 'FIRST'
            ? {
                id: candidate.id,
                status: SubscriptionInvoiceStatus.PENDING,
                operatorNotifiedAt: null,
              }
            : {
                id: candidate.id,
                status: SubscriptionInvoiceStatus.PENDING,
                operatorNotifiedAt: { not: null },
                expiryNotifiedAt: null,
              },
        data:
          kind === 'FIRST'
            ? { operatorNotifiedAt: now }
            : { expiryNotifiedAt: now },
      });
      return claimed.count === 1 ? tenant : null;
    });
  }

  /** Kembalikan klaim agar pengingat dicoba lagi pada putaran berikutnya. */
  private async release(
    invoiceId: string,
    tenantId: string,
    kind: ReminderKind,
    claimedAt: Date,
  ): Promise<void> {
    try {
      await this.prisma.withTenant(tenantId, (tx) =>
        tx.subscriptionInvoice.updateMany({
          where:
            kind === 'FIRST'
              ? { id: invoiceId, operatorNotifiedAt: claimedAt }
              : { id: invoiceId, expiryNotifiedAt: claimedAt },
          data:
            kind === 'FIRST'
              ? { operatorNotifiedAt: null }
              : { expiryNotifiedAt: null },
        }),
      );
    } catch (error) {
      this.logger.warn(
        `gagal mengembalikan klaim pengingat invoice=${invoiceId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private warnUnconfigured(now: Date, reason: string): void {
    const nowMs = now.getTime();
    if (nowMs - this.lastUnconfiguredWarnAt >= UNCONFIGURED_WARN_INTERVAL_MS) {
      this.lastUnconfiguredWarnAt = nowMs;
      this.logger.warn(`pengingat tagihan dilewati: ${reason}`);
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.error(
        `billing reminder run gagal: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }
}
