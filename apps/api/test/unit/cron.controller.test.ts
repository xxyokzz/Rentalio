import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../src/config/env.validation.js';
import { CronController } from '../../src/internal/cron.controller.js';
import type { StructuredLogger } from '../../src/common/logger.service.js';
import type { EmailService } from '../../src/email/email.service.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import { OutboxWorkerService } from '../../src/outbox/outbox.worker.js';
import { SubscriptionReconcilerService } from '../../src/subscriptions/subscription-reconciler.service.js';
import { BillingReminderService } from '../../src/billing/billing-reminder.service.js';

const SECRET = 'test-cron-secret-0123456789abcdef';
const STATUS_TOKEN = 'test-status-token-0123456789abcdef';

type RunStatus = 'SUCCEEDED' | 'PARTIAL' | 'FAILED';

interface CronRunRow {
  id: string;
  startedAt: Date;
  finishedAt: Date;
  status: RunStatus;
  durationMs: number;
  failedJobs: string[];
  results: unknown;
  alertedAt: Date | null;
}

function config(overrides: Record<string, unknown> = {}): AppConfig {
  return {
    CRON_SECRET: SECRET,
    CRON_STATUS_TOKEN: STATUS_TOKEN,
    CRON_ALERT_EMAIL: 'ops@example.com',
    CRON_ALERT_COOLDOWN_SECONDS: 3_600,
    CRON_STALE_AFTER_SECONDS: 300,
    PLATFORM_OPERATOR_EMAIL: 'billing@example.com',
    ...overrides,
  } as unknown as AppConfig;
}

describe('CronController', () => {
  let runOutbox: ReturnType<typeof vi.fn>;
  let runReconciler: ReturnType<typeof vi.fn>;
  let runReminder: ReturnType<typeof vi.fn>;
  let createRun: ReturnType<typeof vi.fn>;
  let findFirstRun: ReturnType<typeof vi.fn>;
  let updateRun: ReturnType<typeof vi.fn>;
  let deleteRuns: ReturnType<typeof vi.fn>;
  let sendEmail: ReturnType<typeof vi.fn>;
  let logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  let prisma: {
    client: {
      cronRun: {
        create: ReturnType<typeof vi.fn>;
        findFirst: ReturnType<typeof vi.fn>;
        update: ReturnType<typeof vi.fn>;
        deleteMany: ReturnType<typeof vi.fn>;
      };
    };
  };

  const makeController = (overrides: Record<string, unknown> = {}): CronController =>
    new CronController(
      config(overrides),
      prisma as unknown as PrismaService,
      logger as unknown as StructuredLogger,
      { send: sendEmail } as unknown as EmailService,
    );

  beforeEach(() => {
    runOutbox = vi.fn().mockResolvedValue({ claimed: 1 });
    runReconciler = vi.fn().mockResolvedValue({ scanned: 2 });
    runReminder = vi.fn().mockResolvedValue({ scanned: 3 });

    createRun = vi.fn().mockResolvedValue({ id: 'run-1' });
    findFirstRun = vi.fn().mockResolvedValue(null);
    updateRun = vi.fn().mockResolvedValue({});
    deleteRuns = vi.fn().mockResolvedValue({ count: 0 });
    sendEmail = vi.fn().mockResolvedValue(undefined);
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    prisma = {
      client: {
        cronRun: {
          create: createRun,
          findFirst: findFirstRun,
          update: updateRun,
          deleteMany: deleteRuns,
        },
      },
    };

    const services = new Map<unknown, { runOnce: () => Promise<unknown> }>([
      [OutboxWorkerService, { runOnce: runOutbox }],
      [SubscriptionReconcilerService, { runOnce: runReconciler }],
      [BillingReminderService, { runOnce: runReminder }],
    ]);
    const context = {
      get: (token: unknown) =>
        services.get(token) ?? { runOnce: async () => undefined },
    };

    vi.spyOn(NestFactory, 'createApplicationContext').mockResolvedValue(
      context as never,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('menolak request tanpa header Authorization', async () => {
    const controller = makeController();

    await expect(controller.run()).rejects.toBeInstanceOf(UnauthorizedException);
    expect(vi.mocked(NestFactory.createApplicationContext)).not.toHaveBeenCalled();
  });

  it('menolak bearer yang salah', async () => {
    const controller = makeController();

    await expect(controller.run('Bearer salah')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(vi.mocked(NestFactory.createApplicationContext)).not.toHaveBeenCalled();
  });

  it('menolak header yang bukan Bearer', async () => {
    const controller = makeController();

    await expect(controller.run(SECRET)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(vi.mocked(NestFactory.createApplicationContext)).not.toHaveBeenCalled();
  });

  it('menolak semua request bila CRON_SECRET belum diatur', async () => {
    const controller = makeController({ CRON_SECRET: undefined });

    await expect(controller.run(`Bearer ${SECRET}`)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(vi.mocked(NestFactory.createApplicationContext)).not.toHaveBeenCalled();
  });

  it('menjalankan ketiga job dan mencatat run sukses', async () => {
    const controller = makeController();

    const result = await controller.run(`Bearer ${SECRET}`);

    expect(result).toEqual({
      status: 'ok',
      jobs: {
        outbox: { claimed: 1 },
        subscriptions: { scanned: 2 },
        billingReminders: { scanned: 3 },
      },
    });
    expect(runOutbox).toHaveBeenCalledTimes(1);
    expect(runReconciler).toHaveBeenCalledTimes(1);
    expect(runReminder).toHaveBeenCalledTimes(1);
    expect(createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'SUCCEEDED',
          failedJobs: [],
          results: {
            outbox: { claimed: 1 },
            subscriptions: { scanned: 2 },
            billingReminders: { scanned: 3 },
          },
        }),
        select: { id: true },
      }),
    );
    expect(sendEmail).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      'cron_run_finished',
      expect.objectContaining({ status: 'SUCCEEDED' }),
    );
  });

  it('memakai ulang worker context untuk request berikutnya', async () => {
    const controller = makeController();

    await controller.run(`Bearer ${SECRET}`);
    await controller.run(`Bearer ${SECRET}`);

    expect(vi.mocked(NestFactory.createApplicationContext)).toHaveBeenCalledTimes(1);
  });

  it('mencatat run parsial, mengirim alert, dan mengembalikan 503 bila satu job gagal', async () => {
    runOutbox.mockRejectedValue(new Error('database down'));
    const controller = makeController();

    await expect(controller.run(`Bearer ${SECRET}`)).rejects.toMatchObject({
      response: {
        message: 'Sebagian job cron gagal.',
        failed: ['outbox'],
      },
    });
    expect(runReconciler).toHaveBeenCalledTimes(1);
    expect(runReminder).toHaveBeenCalledTimes(1);
    expect(createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'PARTIAL',
          failedJobs: ['outbox'],
        }),
      }),
    );
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toMatchObject({
      to: 'ops@example.com',
      subject: expect.stringContaining('outbox'),
    });
    expect(updateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'run-1' },
        data: expect.objectContaining({ alertedAt: expect.any(Date) }),
      }),
    );
  });

  it('tidak mengirim alert berulang selama cooldown', async () => {
    findFirstRun.mockResolvedValue({ alertedAt: new Date() });
    runOutbox.mockRejectedValue(new Error('database down'));
    const controller = makeController();

    await expect(controller.run(`Bearer ${SECRET}`)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    expect(sendEmail).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'cron_alert_skipped',
      expect.objectContaining({ reason: 'cooldown' }),
    );
  });

  it('memakai PLATFORM_OPERATOR_EMAIL bila CRON_ALERT_EMAIL kosong', async () => {
    runOutbox.mockRejectedValue(new Error('database down'));
    const controller = makeController({ CRON_ALERT_EMAIL: undefined });

    await expect(controller.run(`Bearer ${SECRET}`)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    expect(sendEmail.mock.calls[0][0]).toMatchObject({
      to: 'billing@example.com',
    });
  });

  it('tetap mengembalikan 503 bila pengiriman alert gagal', async () => {
    sendEmail.mockRejectedValue(new Error('resend down'));
    runOutbox.mockRejectedValue(new Error('database down'));
    const controller = makeController();

    await expect(controller.run(`Bearer ${SECRET}`)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(logger.error).toHaveBeenCalledWith(
      'cron_alert_failed',
      expect.objectContaining({ error: 'resend down' }),
    );
  });

  it('tidak menggagalkan job sukses bila pencatatan run gagal', async () => {
    createRun.mockRejectedValue(new Error('write down'));
    const controller = makeController();

    await expect(controller.run(`Bearer ${SECRET}`)).resolves.toMatchObject({
      status: 'ok',
    });
    expect(logger.error).toHaveBeenCalledWith(
      'cron_run_persist_failed',
      expect.objectContaining({ error: 'write down' }),
    );
  });

  it('mencatat kegagalan context dan mengirim alert', async () => {
    vi.mocked(NestFactory.createApplicationContext).mockRejectedValueOnce(
      new Error('init gagal'),
    );
    const controller = makeController();

    await expect(controller.run(`Bearer ${SECRET}`)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    expect(createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'FAILED',
          failedJobs: ['workerContext'],
        }),
      }),
    );
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('mencoba membuat worker context lagi setelah kegagalan', async () => {
    vi.mocked(NestFactory.createApplicationContext)
      .mockRejectedValueOnce(new Error('init gagal'))
      .mockResolvedValueOnce({ get: () => ({ runOnce: runOutbox }) } as never);
    const controller = makeController();

    await expect(controller.run(`Bearer ${SECRET}`)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(controller.run(`Bearer ${SECRET}`)).resolves.toMatchObject({
      status: 'ok',
    });
    expect(vi.mocked(NestFactory.createApplicationContext)).toHaveBeenCalledTimes(2);
  });

  it('status mengembalikan 200 saat run terakhir sukses dan masih segar', async () => {
    const now = Date.now();
    findFirstRun.mockResolvedValue({
      id: 'run-1',
      startedAt: new Date(now - 30_000),
      finishedAt: new Date(now - 29_000),
      status: 'SUCCEEDED',
      durationMs: 1_000,
      failedJobs: [],
      results: { outbox: { claimed: 1 } },
      alertedAt: null,
    } satisfies CronRunRow);
    const response = { status: vi.fn() };

    const body = await makeController().status(
      `Bearer ${STATUS_TOKEN}`,
      response as unknown as Response,
    );

    expect(body).toMatchObject({
      status: 'ok',
      ageSeconds: expect.any(Number),
      lastRun: { id: 'run-1', status: 'SUCCEEDED' },
    });
    expect(response.status).not.toHaveBeenCalled();
  });

  it('status mengembalikan 503 saat run terakhir parsial', async () => {
    const now = Date.now();
    findFirstRun.mockResolvedValue({
      id: 'run-1',
      startedAt: new Date(now - 30_000),
      finishedAt: new Date(now - 29_000),
      status: 'PARTIAL',
      durationMs: 1_000,
      failedJobs: ['outbox'],
      results: { subscriptions: { scanned: 2 } },
      alertedAt: new Date(),
    } satisfies CronRunRow);
    const response = { status: vi.fn() };

    const body = await makeController().status(
      `Bearer ${STATUS_TOKEN}`,
      response as unknown as Response,
    );

    expect(body.status).toBe('degraded');
    expect(body.lastRun).toMatchObject({
      status: 'PARTIAL',
      failedJobs: ['outbox'],
    });
    expect(response.status).toHaveBeenCalledWith(503);
  });

  it('status mengembalikan 503 saat run terakhir sudah stale', async () => {
    findFirstRun.mockResolvedValue({
      id: 'run-1',
      startedAt: new Date(Date.now() - 600_000),
      finishedAt: new Date(Date.now() - 590_000),
      status: 'SUCCEEDED',
      durationMs: 1_000,
      failedJobs: [],
      results: {},
      alertedAt: null,
    } satisfies CronRunRow);
    const response = { status: vi.fn() };

    const body = await makeController().status(
      `Bearer ${STATUS_TOKEN}`,
      response as unknown as Response,
    );

    expect(body.status).toBe('stale');
    expect(response.status).toHaveBeenCalledWith(503);
  });

  it('status mengembalikan 503 saat belum ada run', async () => {
    findFirstRun.mockResolvedValue(null);
    const response = { status: vi.fn() };

    const body = await makeController().status(
      `Bearer ${STATUS_TOKEN}`,
      response as unknown as Response,
    );

    expect(body).toMatchObject({
      status: 'stale',
      ageSeconds: null,
      lastRun: null,
    });
    expect(response.status).toHaveBeenCalledWith(503);
  });

  it('status menolak bearer yang salah tanpa membaca database', async () => {
    const response = { status: vi.fn() };

    await expect(
      makeController().status(
        'Bearer salah',
        response as unknown as Response,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(findFirstRun).not.toHaveBeenCalled();
  });

  it('status memakai CRON_SECRET bila CRON_STATUS_TOKEN kosong', async () => {
    findFirstRun.mockResolvedValue(null);
    const response = { status: vi.fn() };

    const body = await makeController({ CRON_STATUS_TOKEN: undefined }).status(
      `Bearer ${SECRET}`,
      response as unknown as Response,
    );

    expect(body.status).toBe('stale');
  });

  it('status menolak semua request bila kedua secret kosong', async () => {
    const response = { status: vi.fn() };

    await expect(
      makeController({
        CRON_STATUS_TOKEN: undefined,
        CRON_SECRET: undefined,
      }).status(`Bearer ${SECRET}`, response as unknown as Response),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(findFirstRun).not.toHaveBeenCalled();
  });

  it('status mengembalikan 503 unknown bila database tidak dapat dibaca', async () => {
    findFirstRun.mockRejectedValue(new Error('database down'));
    const response = { status: vi.fn() };

    const body = await makeController().status(
      `Bearer ${STATUS_TOKEN}`,
      response as unknown as Response,
    );

    expect(body).toMatchObject({ status: 'unknown', lastRun: null });
    expect(response.status).toHaveBeenCalledWith(503);
    expect(logger.error).toHaveBeenCalledWith(
      'cron_status_failed',
      expect.objectContaining({ error: 'database down' }),
    );
  });
});
