/**
 * Integration test: RLS `outbox_events` (migration 008).
 *
 * `outbox_events` menyimpan payload event domain yang dapat memuat data
 * tenant. Sebelum migration 008 tabel ini tidak ber-RLS, sehingga query
 * tanpa konteks tenant dapat membacanya. Test ini membuktikan:
 * - tanpa `app.tenant_id` → baca kosong dan tulis ditolak (fail-closed);
 * - konteks tenant hanya melihat event miliknya;
 * - update/delete lintas tenant tidak mengenai baris apa pun;
 * - insert dengan `tenantId` lain atau `NULL` ditolak policy.
 *
 * Berjalan terhadap PostgreSQL sewain_test dengan role runtime `sewain_dev`.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { AppModule } from '../../src/app.module.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';

let app: INestApplication;
let prisma: PrismaService;

beforeAll(async () => {
  app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
  await app.init();
  prisma = app.get(PrismaService);
}, 120_000);

afterAll(() => app?.close());

function outboxEvent(tenantId: string | null) {
  return {
    tenantId,
    aggregateType: 'Reservation',
    aggregateId: randomUUID(),
    eventType: 'reservation.confirmed',
    payload: { source: 'outbox-rls-test' },
  };
}

describe('RLS outbox_events', () => {
  it('tanpa konteks tenant: baca kosong dan tulis ditolak (fail-closed)', async () => {
    await expect(prisma.client.outboxEvent.findMany()).resolves.toEqual([]);

    await expect(
      prisma.client.outboxEvent.create({ data: outboxEvent(randomUUID()) }),
    ).rejects.toThrow();
  });

  it('konteks tenant hanya melihat event milik tenant itu', async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();

    const eventA = await prisma.withTenant(tenantA, (tx) =>
      tx.outboxEvent.create({ data: outboxEvent(tenantA) }),
    );
    const eventB = await prisma.withTenant(tenantB, (tx) =>
      tx.outboxEvent.create({ data: outboxEvent(tenantB) }),
    );

    const rowsA = await prisma.withTenant(tenantA, (tx) => tx.outboxEvent.findMany());
    const rowsB = await prisma.withTenant(tenantB, (tx) => tx.outboxEvent.findMany());

    expect(rowsA.map((row) => row.id)).toEqual([eventA.id]);
    expect(rowsB.map((row) => row.id)).toEqual([eventB.id]);
  });

  it('update/delete lintas tenant tidak mengenai baris tenant lain', async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();

    const eventB = await prisma.withTenant(tenantB, (tx) =>
      tx.outboxEvent.create({ data: outboxEvent(tenantB) }),
    );

    const updated = await prisma.withTenant(tenantA, (tx) =>
      tx.outboxEvent.updateMany({
        where: { id: eventB.id },
        data: { retryCount: 99 },
      }),
    );
    const deleted = await prisma.withTenant(tenantA, (tx) =>
      tx.outboxEvent.deleteMany({ where: { id: eventB.id } }),
    );

    expect(updated.count).toBe(0);
    expect(deleted.count).toBe(0);

    const stillThere = await prisma.withTenant(tenantB, (tx) =>
      tx.outboxEvent.findUnique({ where: { id: eventB.id } }),
    );
    expect(stillThere).not.toBeNull();
    expect(stillThere!.retryCount).toBe(0);
  });

  it('insert dengan tenantId tenant lain atau NULL ditolak policy', async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();

    await expect(
      prisma.withTenant(tenantA, (tx) =>
        tx.outboxEvent.create({ data: outboxEvent(tenantB) }),
      ),
    ).rejects.toThrow();

    await expect(
      prisma.withTenant(tenantA, (tx) =>
        tx.outboxEvent.create({ data: outboxEvent(null) }),
      ),
    ).rejects.toThrow();

    const rowsA = await prisma.withTenant(tenantA, (tx) => tx.outboxEvent.findMany());
    expect(rowsA).toEqual([]);
  });
});
