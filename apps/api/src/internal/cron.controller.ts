import {
  Controller,
  Get,
  Header,
  Headers,
  Inject,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import type { Response } from 'express';
import { Prisma } from '@rentalio/database';
import type { AppConfig } from '../config/env.validation.js';
import { StructuredLogger } from '../common/logger.service.js';
import { EmailService } from '../email/email.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { WorkerModule } from '../worker.module.js';
import { OutboxWorkerService } from '../outbox/outbox.worker.js';
import { SubscriptionReconcilerService } from '../subscriptions/subscription-reconciler.service.js';
import { BillingReminderService } from '../billing/billing-reminder.service.js';

type CronJobName = 'outbox' | 'subscriptions' | 'billingReminders';
type CronRunStatusValue = 'SUCCEEDED' | 'PARTIAL' | 'FAILED';
type CronHealth = 'ok' | 'degraded' | 'stale' | 'unknown';

/** Riwayat 14 hari cukup untuk investigasi dan menjaga tabel tetap kecil. */
const CRON_RUN_RETENTION_DAYS = 14;
const CRON_ALERT_TIMEOUT_MS = 5_000;

interface CronStatusResponse {
  status: CronHealth;
  checkedAt: string;
  staleAfterSeconds: number;
  ageSeconds: number | null;
  lastRun: {
    id: string;
    startedAt: string;
    finishedAt: string;
    status: string;
    durationMs: number;
    failedJobs: string[];
    results: unknown;
    alertedAt: string | null;
  } | null;
}

@Controller('internal/cron')
export class CronController {
  private workerContext?: Promise<INestApplicationContext>;
  /** Cooldown in-memory agar alert tidak membanjiri saat database sedang down. */
  private lastAlertAtMs = 0;

  constructor(
    @Inject('APP_CONFIG') private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly logger: StructuredLogger,
    private readonly email: EmailService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async run(
    @Headers('authorization') authorization?: string,
  ): Promise<{ status: 'ok'; jobs: Record<CronJobName, unknown> }> {
    this.assertAuthorized(authorization, this.config.CRON_SECRET, 'CRON_SECRET');

    const startedAt = new Date();
    const startedMs = Date.now();

    let context: INestApplicationContext;
    try {
      context = await this.getWorkerContext();
    } catch (error) {
      const durationMs = Date.now() - startedMs;
      this.logger.error('cron_context_failed', {
        durationMs,
        error: errorMessage(error),
      });
      const run = await this.recordRun({
        startedAt,
        status: 'FAILED',
        durationMs,
        failedJobs: ['workerContext'],
        results: null,
      });
      await this.sendFailureAlert({
        runId: run?.id,
        status: 'FAILED',
        startedAt,
        durationMs,
        failedJobs: ['workerContext'],
        results: null,
      });
      throw new ServiceUnavailableException('Worker cron tidak dapat disiapkan.');
    }

    const jobs: Array<[CronJobName, () => Promise<unknown>]> = [
      ['outbox', () => context.get(OutboxWorkerService).runOnce()],
      ['subscriptions', () => context.get(SubscriptionReconcilerService).runOnce()],
      ['billingReminders', () => context.get(BillingReminderService).runOnce()],
    ];

    const results: Partial<Record<CronJobName, unknown>> = {};
    const failedJobs: CronJobName[] = [];

    for (const [name, execute] of jobs) {
      try {
        results[name] = await execute();
      } catch (error) {
        failedJobs.push(name);
        this.logger.error('cron_job_failed', {
          job: name,
          error: errorMessage(error),
        });
      }
    }

    const durationMs = Date.now() - startedMs;
    const status: CronRunStatusValue =
      failedJobs.length === 0
        ? 'SUCCEEDED'
        : failedJobs.length === jobs.length
          ? 'FAILED'
          : 'PARTIAL';

    const run = await this.recordRun({
      startedAt,
      status,
      durationMs,
      failedJobs,
      results,
    });

    const logFields = {
      runId: run?.id,
      status,
      durationMs,
      failedJobs,
      results,
    };
    if (status === 'SUCCEEDED') {
      this.logger.info('cron_run_finished', logFields);
    } else {
      this.logger.error('cron_run_finished', logFields);
      await this.sendFailureAlert({
        runId: run?.id,
        status,
        startedAt,
        durationMs,
        failedJobs,
        results,
      });
    }

    if (failedJobs.length > 0) {
      throw new ServiceUnavailableException({
        message: 'Sebagian job cron gagal.',
        failed: failedJobs,
        result: results,
      });
    }

    return {
      status: 'ok',
      jobs: results as Record<CronJobName, unknown>,
    };
  }

  @Get('status')
  @Header('Cache-Control', 'no-store')
  async status(
    @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CronStatusResponse> {
    this.assertAuthorized(
      authorization,
      this.config.CRON_STATUS_TOKEN ?? this.config.CRON_SECRET,
      'CRON_STATUS_TOKEN/CRON_SECRET',
    );

    const checkedAt = new Date();
    try {
      const lastRun = await this.prisma.client.cronRun.findFirst({
        orderBy: { startedAt: 'desc' },
        select: {
          id: true,
          startedAt: true,
          finishedAt: true,
          status: true,
          durationMs: true,
          failedJobs: true,
          results: true,
          alertedAt: true,
        },
      });

      const ageSeconds = lastRun
        ? Math.max(
            0,
            Math.floor(
              (checkedAt.getTime() - lastRun.finishedAt.getTime()) / 1_000,
            ),
          )
        : null;
      const stale =
        ageSeconds === null ||
        ageSeconds > this.config.CRON_STALE_AFTER_SECONDS;
      const degraded = lastRun !== null && lastRun.status !== 'SUCCEEDED';
      const health: CronHealth = stale
        ? 'stale'
        : degraded
          ? 'degraded'
          : 'ok';

      if (health !== 'ok') response.status(503);

      return {
        status: health,
        checkedAt: checkedAt.toISOString(),
        staleAfterSeconds: this.config.CRON_STALE_AFTER_SECONDS,
        ageSeconds,
        lastRun: lastRun
          ? {
              id: lastRun.id,
              startedAt: lastRun.startedAt.toISOString(),
              finishedAt: lastRun.finishedAt.toISOString(),
              status: lastRun.status,
              durationMs: lastRun.durationMs,
              failedJobs: lastRun.failedJobs,
              results: lastRun.results,
              alertedAt: lastRun.alertedAt?.toISOString() ?? null,
            }
          : null,
      };
    } catch (error) {
      this.logger.error('cron_status_failed', { error: errorMessage(error) });
      response.status(503);
      return {
        status: 'unknown',
        checkedAt: checkedAt.toISOString(),
        staleAfterSeconds: this.config.CRON_STALE_AFTER_SECONDS,
        ageSeconds: null,
        lastRun: null,
      };
    }
  }

  private async getWorkerContext(): Promise<INestApplicationContext> {
    const pending =
      this.workerContext ??
      (this.workerContext = NestFactory.createApplicationContext(WorkerModule, {
        logger: false,
      }));

    try {
      return await pending;
    } catch (error) {
      // Jangan cache kegagalan: request cron berikutnya harus mencoba lagi.
      if (this.workerContext === pending) this.workerContext = undefined;
      throw error;
    }
  }

  private async recordRun(input: {
    startedAt: Date;
    status: CronRunStatusValue;
    durationMs: number;
    failedJobs: string[];
    results: Partial<Record<CronJobName, unknown>> | null;
  }): Promise<{ id: string } | null> {
    const finishedAt = new Date();
    try {
      const run = await this.prisma.client.cronRun.create({
        data: {
          startedAt: input.startedAt,
          finishedAt,
          status: input.status,
          durationMs: input.durationMs,
          failedJobs: input.failedJobs,
          ...(input.results
            ? { results: input.results as Prisma.InputJsonValue }
            : {}),
        },
        select: { id: true },
      });

      const cutoff = new Date(
        finishedAt.getTime() - CRON_RUN_RETENTION_DAYS * 86_400_000,
      );
      try {
        await this.prisma.client.cronRun.deleteMany({
          where: { startedAt: { lt: cutoff } },
        });
      } catch (error) {
        this.logger.warn('cron_run_prune_failed', {
          error: errorMessage(error),
        });
      }

      return run;
    } catch (error) {
      this.logger.error('cron_run_persist_failed', {
        error: errorMessage(error),
      });
      return null;
    }
  }

  private async sendFailureAlert(input: {
    runId?: string;
    status: CronRunStatusValue;
    startedAt: Date;
    durationMs: number;
    failedJobs: string[];
    results: Partial<Record<CronJobName, unknown>> | null;
  }): Promise<void> {
    const recipient =
      this.config.CRON_ALERT_EMAIL ?? this.config.PLATFORM_OPERATOR_EMAIL;
    if (!recipient) {
      this.logger.warn('cron_alert_skipped', {
        reason: 'CRON_ALERT_EMAIL/PLATFORM_OPERATOR_EMAIL kosong',
      });
      return;
    }

    const cooldownMs = this.config.CRON_ALERT_COOLDOWN_SECONDS * 1_000;
    let lastAlertedAtMs = this.lastAlertAtMs;
    try {
      const lastAlert = await this.prisma.client.cronRun.findFirst({
        where: { alertedAt: { not: null } },
        orderBy: { alertedAt: 'desc' },
        select: { alertedAt: true },
      });
      if (lastAlert?.alertedAt) {
        lastAlertedAtMs = lastAlert.alertedAt.getTime();
      }
    } catch (error) {
      this.logger.warn('cron_alert_state_failed', {
        error: errorMessage(error),
      });
    }

    if (lastAlertedAtMs > 0 && Date.now() - lastAlertedAtMs < cooldownMs) {
      this.logger.warn('cron_alert_skipped', {
        reason: 'cooldown',
        lastAlertedAt: new Date(lastAlertedAtMs).toISOString(),
      });
      return;
    }

    try {
      await withTimeout(
        this.email.send({
          to: recipient,
          subject: `[Rentalio] Cron ${input.status}: ${input.failedJobs.join(', ')}`,
          body: formatAlertBody(input),
        }),
        CRON_ALERT_TIMEOUT_MS,
      );

      this.lastAlertAtMs = Date.now();
      if (input.runId) {
        try {
          await this.prisma.client.cronRun.update({
            where: { id: input.runId },
            data: { alertedAt: new Date(this.lastAlertAtMs) },
          });
        } catch (error) {
          this.logger.warn('cron_alert_mark_failed', {
            error: errorMessage(error),
          });
        }
      }

      this.logger.info('cron_alert_sent', {
        runId: input.runId,
        failedJobs: input.failedJobs,
      });
    } catch (error) {
      this.logger.error('cron_alert_failed', {
        error: errorMessage(error),
      });
    }
  }

  private assertAuthorized(
    authorization: string | undefined,
    secret: string | undefined,
    secretName: string,
  ): void {
    if (!secret) {
      throw new ServiceUnavailableException(`${secretName} belum diatur.`);
    }

    const expected = Buffer.from(`Bearer ${secret}`);
    const actual = Buffer.from(authorization ?? '');
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      throw new UnauthorizedException('Kredensial cron tidak valid.');
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatAlertBody(input: {
  runId?: string;
  status: CronRunStatusValue;
  startedAt: Date;
  durationMs: number;
  failedJobs: string[];
  results: Partial<Record<CronJobName, unknown>> | null;
}): string {
  let results = 'tidak ada';
  if (input.results) {
    try {
      results =
        JSON.stringify(
          input.results,
          (_key, value: unknown) =>
            typeof value === 'bigint' ? value.toString() : value,
          2,
        ) ?? 'tidak ada';
    } catch {
      results = '(hasil tidak dapat diserialisasi)';
    }
  }

  return [
    'Cron Rentalio gagal.',
    '',
    `Status: ${input.status}`,
    `Waktu mulai: ${input.startedAt.toISOString()}`,
    `Durasi: ${input.durationMs} ms`,
    `Job gagal: ${input.failedJobs.join(', ')}`,
    `Run ID: ${input.runId ?? 'tidak tercatat'}`,
    '',
    'Hasil per job:',
    results,
    '',
    'Periksa endpoint /api/v1/internal/cron/status dan log API di Vercel.',
  ].join('\n');
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timeout setelah ${timeoutMs} ms`)),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
