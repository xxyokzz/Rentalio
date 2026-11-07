import { describe, expect, it, vi } from 'vitest';
import { PlatformCronService } from '../../src/platform-admin/platform-cron.service.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';

interface CronRow {
  id: string;
  startedAt: Date;
  finishedAt: Date;
  status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED';
  durationMs: number;
  failedJobs: string[];
  results: unknown;
  alertedAt: Date | null;
}

const baseRow: CronRow = {
  id: '00000000-0000-4000-8000-000000000001',
  startedAt: new Date('2026-11-05T10:00:00.000Z'),
  finishedAt: new Date('2026-11-05T10:00:01.000Z'),
  status: 'SUCCEEDED',
  durationMs: 1_000,
  failedJobs: [],
  results: {
    outbox: { claimed: 1 },
    subscriptions: { scanned: 2 },
    billingReminders: { scanned: 3 },
  },
  alertedAt: null,
};

function setup(rows: CronRow[] = [baseRow], total = rows.length) {
  const findMany = vi.fn().mockResolvedValue(rows);
  const count = vi.fn().mockResolvedValue(total);
  const prisma = { client: { cronRun: { findMany, count } } };
  const service = new PlatformCronService(prisma as unknown as PrismaService);
  return { service, findMany, count };
}

describe('PlatformCronService', () => {
  it('memetakan job sukses dan menggunakan paginasi terbaru lebih dulu', async () => {
    const { service, findMany } = setup();

    const [first] = (await service.listRuns({ page: 1, pageSize: 20 })).data;

    expect(first).toMatchObject({
      id: baseRow.id,
      status: 'SUCCEEDED',
      durationMs: 1_000,
      jobs: {
        outbox: 'SUCCEEDED',
        subscriptions: 'SUCCEEDED',
        billingReminders: 'SUCCEEDED',
      },
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {},
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        skip: 0,
        take: 20,
      }),
    );
  });

  it('menandai job gagal dan job lain yang tetap sukses', async () => {
    const { service } = setup([
      {
        ...baseRow,
        status: 'PARTIAL',
        failedJobs: ['outbox'],
        results: {
          subscriptions: { scanned: 2 },
          billingReminders: { scanned: 3 },
        },
      },
    ]);

    const [first] = (await service.listRuns({ page: 1, pageSize: 20 })).data;

    expect(first?.jobs).toEqual({
      outbox: 'FAILED',
      subscriptions: 'SUCCEEDED',
      billingReminders: 'SUCCEEDED',
    });
  });

  it('menandai semua job UNKNOWN bila worker context gagal', async () => {
    const { service } = setup([
      {
        ...baseRow,
        status: 'FAILED',
        failedJobs: ['workerContext'],
        results: null,
      },
    ]);

    const [first] = (await service.listRuns({ page: 1, pageSize: 20 })).data;

    expect(first?.jobs).toEqual({
      outbox: 'UNKNOWN',
      subscriptions: 'UNKNOWN',
      billingReminders: 'UNKNOWN',
    });
  });

  it('tidak menganggap hasil non-objek sebagai job sukses', async () => {
    const { service } = setup([
      {
        ...baseRow,
        failedJobs: [],
        results: [],
      },
    ]);

    const [first] = (await service.listRuns({ page: 1, pageSize: 20 })).data;

    expect(first?.jobs).toEqual({
      outbox: 'UNKNOWN',
      subscriptions: 'UNKNOWN',
      billingReminders: 'UNKNOWN',
    });
  });

  it('meneruskan filter status dan halaman ke query database', async () => {
    const { service, findMany, count } = setup([], 42);

    const result = await service.listRuns({
      status: 'FAILED',
      page: 3,
      pageSize: 10,
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'FAILED' },
        skip: 20,
        take: 10,
      }),
    );
    expect(count).toHaveBeenCalledWith({ where: { status: 'FAILED' } });
    expect(result).toMatchObject({ page: 3, pageSize: 10, total: 42, data: [] });
  });
});
