/**
 * Integration test: worker outbox (migration 009).
 *
 * Membuktikan perilaku yang dibutuhkan dokumen 10/11:
 * - klaim dengan lease + SKIP LOCKED → dua worker tidak memproses event sama;
 * - sukses menandai `publishedAt`;
 * - gagal menyimpan `retryCount`/`lastError` dan menjadwalkan backoff;
 * - batas percobaan memindahkan event ke dead-letter;
 * - state retry persisten, sehingga worker baru dapat melanjutkan (recovery);
 * - konteks sistem melihat event semua tenant, konteks tenant tetap terisolasi.
 *
 * Berjalan terhadap PostgreSQL sewain_test dengan role runtime `sewain_dev`.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@rentalio/database';

import { WorkerModule } from '../../src/worker.module.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import type { AppConfig } from '../../src/config/env.validation.js';
import {
  OutboxWorkerService,
  type OutboxEventRecord,
} from '../../src/outbox/outbox.worker.js';

let app: INestApplication;
let prisma: PrismaService;
let baseConfig: AppConfig;

beforeAll(async () => {
  app = await NestFactory.create(WorkerModule, { logger: false, abortOnError: false });
  await app.init();
  prisma = app.get(PrismaService);
  baseConfig = app.get<AppConfig>('APP_CONFIG');
}, 120_000);

afterAll(() => app?.close());

function makeWorker(overrides: Partial<AppConfig> = {}): OutboxWorkerService {
  return new OutboxWorkerService(prisma, {
    ...baseConfig,
    OUTBOX_WORKER_ENABLED: false,
    ...overrides,
  });
}

async function enqueue(tenantId: string, eventType: string, payload: unknown = {}) {
  return prisma.withTenant(tenantId, (tx) =>
    tx.outboxEvent.create({
      data: {
        tenantId,
        aggregateType: 'TestAggregate',
        aggregateId: randomUUID(),
        eventType,
        payload: payload as Prisma.InputJsonValue,
      },
    }),
  );
}

async function readEvent(id: string) {
  return prisma.withOutboxSystem((tx) =>
    tx.outboxEvent.findUnique({ where: { id } }),
  );
}

describe('Outbox worker', () => {
  it('mengklaim event semua tenant lewat konteks sistem lalu menandai published', async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const handled: string[] = [];

    const worker = makeWorker();
    worker.registerHandler({
      eventType: 'test.publish',
      handle: async (event: OutboxEventRecord) => {
        handled.push(event.id);
      },
    });

    const eventA = await enqueue(tenantA, 'test.publish');
    const eventB = await enqueue(tenantB, 'test.publish');

    const result = await worker.runOnce();

    expect(result.published).toBeGreaterThanOrEqual(2);
    expect(handled).toEqual(expect.arrayContaining([eventA.id, eventB.id]));

    const rows = await prisma.withOutboxSystem((tx) =>
      tx.outboxEvent.findMany({ where: { id: { in: [eventA.id, eventB.id] } } }),
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.publishedAt != null)).toBe(true);
  });

  it('gagal → retryCount + backoff, lalu sukses pada percobaan berikutnya', async () => {
    const tenantId = randomUUID();
    const event = await enqueue(tenantId, 'test.retry');
    const calls: string[] = [];
    let shouldFail = true;

    const worker = makeWorker({
      OUTBOX_BACKOFF_BASE_MS: 100,
      OUTBOX_BACKOFF_MAX_MS: 1_000,
      OUTBOX_MAX_ATTEMPTS: 5,
    });
    worker.registerHandler({
      eventType: 'test.retry',
      handle: async (record) => {
        calls.push(record.id);
        if (shouldFail) throw new Error('boom');
      },
    });

    const t0 = new Date();
    const first = await worker.runOnce(t0);
    expect(first.retried).toBeGreaterThanOrEqual(1);

    const afterFailure = await readEvent(event.id);
    expect(afterFailure!.publishedAt).toBeNull();
    expect(afterFailure!.retryCount).toBe(1);
    expect(afterFailure!.lastError).toContain('boom');
    expect(afterFailure!.nextAttemptAt!.getTime()).toBeGreaterThan(t0.getTime());
    expect(calls.filter((id) => id === event.id)).toHaveLength(1);

    // Sebelum backoff berakhir, event belum boleh diklaim lagi.
    await worker.runOnce(new Date(t0.getTime() + 1));
    expect(calls.filter((id) => id === event.id)).toHaveLength(1);

    shouldFail = false;
    await worker.runOnce(new Date(afterFailure!.nextAttemptAt!.getTime() + 1));

    const published = await readEvent(event.id);
    expect(published!.publishedAt).not.toBeNull();
    expect(published!.lastError).toBeNull();
    expect(calls.filter((id) => id === event.id)).toHaveLength(2);
  });

  it('setelah batas percobaan, event masuk dead-letter dan tidak diklaim lagi', async () => {
    const tenantId = randomUUID();
    const event = await enqueue(tenantId, 'test.dead');
    let calls = 0;

    const worker = makeWorker({
      OUTBOX_MAX_ATTEMPTS: 2,
      OUTBOX_BACKOFF_BASE_MS: 100,
      OUTBOX_BACKOFF_MAX_MS: 1_000,
    });
    worker.registerHandler({
      eventType: 'test.dead',
      handle: async () => {
        calls += 1;
        throw new Error('selalu gagal');
      },
    });

    const t0 = new Date();
    await worker.runOnce(t0);
    const firstRetry = await readEvent(event.id);
    expect(firstRetry!.deadLetteredAt).toBeNull();
    expect(firstRetry!.retryCount).toBe(1);

    await worker.runOnce(new Date(firstRetry!.nextAttemptAt!.getTime() + 1));
    const dead = await readEvent(event.id);
    expect(dead!.retryCount).toBe(2);
    expect(dead!.deadLetteredAt).not.toBeNull();
    expect(dead!.nextAttemptAt).toBeNull();
    expect(calls).toBe(2);

    await worker.runOnce(new Date(Date.now() + 60_000));
    expect(calls).toBe(2);
    expect((await readEvent(event.id))!.publishedAt).toBeNull();
  });

  it('state retry persisten: worker baru melanjutkan event yang tertinggal', async () => {
    const tenantId = randomUUID();
    const event = await enqueue(tenantId, 'test.recover');
    let calls = 0;

    const failing = makeWorker({
      OUTBOX_BACKOFF_BASE_MS: 100,
      OUTBOX_BACKOFF_MAX_MS: 1_000,
    });
    failing.registerHandler({
      eventType: 'test.recover',
      handle: async () => {
        calls += 1;
        throw new Error('crash');
      },
    });

    const t0 = new Date();
    await failing.runOnce(t0);
    const failed = await readEvent(event.id);
    expect(failed!.publishedAt).toBeNull();

    // Proses "restart": instance baru, tanpa state in-memory apa pun.
    const restarted = makeWorker();
    restarted.registerHandler({
      eventType: 'test.recover',
      handle: async () => {
        calls += 1;
      },
    });
    await restarted.runOnce(new Date(failed!.nextAttemptAt!.getTime() + 1));

    const recovered = await readEvent(event.id);
    expect(recovered!.publishedAt).not.toBeNull();
    expect(calls).toBe(2);
  });

  it('dua worker paralel tidak memproses event yang sama', async () => {
    const tenantId = randomUUID();
    const event = await enqueue(tenantId, 'test.concurrent');
    let calls = 0;

    const handler = {
      eventType: 'test.concurrent',
      handle: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
    };
    const workerA = makeWorker();
    const workerB = makeWorker();
    workerA.registerHandler(handler);
    workerB.registerHandler(handler);

    const now = new Date();
    const [resultA, resultB] = await Promise.all([
      workerA.runOnce(now),
      workerB.runOnce(now),
    ]);

    expect(calls).toBe(1);
    expect(resultA.published + resultB.published).toBe(1);

    const row = await readEvent(event.id);
    expect(row!.publishedAt).not.toBeNull();
  });
});
