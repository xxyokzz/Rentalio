/**
 * Integration test: PostgreSQL transaction retry wrapper.
 *
 * Uses PostgreSQL RAISE EXCEPTION to inject actual server SQLSTATEs into a real
 * transaction; the first attempt is rolled back, then the callback runs again.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { WorkerModule } from '../../src/worker.module.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';

let app: INestApplication;
let prisma: PrismaService;

beforeAll(async () => {
  app = await NestFactory.create(WorkerModule, { logger: false, abortOnError: false });
  await app.init();
  prisma = app.get(PrismaService);
}, 120_000);

afterAll(() => app?.close());

type SqlState = '40P01' | '40001' | '23505';

async function raiseSqlState(
  tx: import('@rentalio/database').Prisma.TransactionClient,
  code: SqlState,
): Promise<void> {
  if (code === '40P01') {
    await tx.$executeRaw`DO $$ BEGIN RAISE EXCEPTION 'simulated deadlock' USING ERRCODE = '40P01'; END $$;`;
  } else if (code === '40001') {
    await tx.$executeRaw`DO $$ BEGIN RAISE EXCEPTION 'simulated serialization failure' USING ERRCODE = '40001'; END $$;`;
  } else {
    await tx.$executeRaw`DO $$ BEGIN RAISE EXCEPTION 'simulated constraint violation' USING ERRCODE = '23505'; END $$;`;
  }
}

describe('PrismaService transaction retries', () => {
  it.each([
    ['deadlock', '40P01'],
    ['serialization failure', '40001'],
  ] as const)('retries the whole transaction after %s (%s)', async (_label, code) => {
    let callbacks = 0;
    const result = await prisma.withRetryableTransaction(async (tx) => {
      callbacks += 1;
      if (callbacks === 1) await raiseSqlState(tx, code);
      const rows = await tx.$queryRaw<Array<{ value: number }>>`SELECT 1 AS value`;
      return rows[0].value;
    });

    expect(result).toBe(1);
    expect(callbacks).toBe(2);
  });

  it('does not retry non-retryable SQLSTATE errors', async () => {
    let callbacks = 0;
    await expect(
      prisma.withRetryableTransaction(async (tx) => {
        callbacks += 1;
        await raiseSqlState(tx, '23505');
        return 'unreachable';
      }),
    ).rejects.toThrow();
    expect(callbacks).toBe(1);
  });
});
