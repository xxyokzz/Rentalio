/**
 * Integration test: pengingat tagihan langganan QRIS ke operator.
 *
 * Membuktikan perilaku yang tidak bisa diuji unit test (butuh database + RLS):
 *   - pengingat pertama hanya untuk tagihan yang sudah cukup umur,
 *   - pengingat kedua saat mendekati kedaluwarsa,
 *   - idempoten: satu email per tahap walau job dijalankan berulang,
 *   - tagihan PAID tidak pernah diingatkan,
 *   - kegagalan kirim mengembalikan klaim agar dicoba lagi.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { WorkerModule } from '../../src/worker.module.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { EmailService, InMemoryEmailAdapter } from '../../src/email/email.service.js';
import { BillingReminderService } from '../../src/billing/billing-reminder.service.js';

const OPERATOR = 'operator@rentalio.test';
const AMOUNT = 149_000n;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let app: INestApplicationContext;
let prisma: PrismaService;
let reminders: BillingReminderService;
let emails: InMemoryEmailAdapter;

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function seedInvoice(options: {
  createdAgoMs: number;
  expiresInMs: number;
  status?: 'PENDING' | 'PAID' | 'EXPIRED';
  now: Date;
}): Promise<{ tenantId: string; invoiceId: string }> {
  const tenantId = randomUUID();
  const invoiceId = randomUUID();
  const suffix = uniqueSuffix();

  await prisma.withTenant(tenantId, async (tx) => {
    await tx.tenant.create({
      data: { id: tenantId, slug: `reminder-${suffix}`, name: 'Rental Kamera Bandung' },
    });
    await tx.subscriptionInvoice.create({
      data: {
        id: invoiceId,
        tenantId,
        provider: 'qris',
        externalId: `ext-${suffix}`,
        amount: AMOUNT,
        currency: 'IDR',
        qrPayload: '000201-test',
        status: options.status ?? 'PENDING',
        createdAt: new Date(options.now.getTime() - options.createdAgoMs),
        expiresAt: new Date(options.now.getTime() + options.expiresInMs),
      },
    });
  });

  return { tenantId, invoiceId };
}

function emailsFor(invoiceId: string): Array<{ subject: string; body: string }> {
  return emails.sent.filter((email) => email.body.includes(invoiceId));
}

async function invoiceRow(invoiceId: string, tenantId: string) {
  return prisma.withTenant(tenantId, (tx) =>
    tx.subscriptionInvoice.findUnique({ where: { id: invoiceId } }),
  );
}

beforeAll(async () => {
  process.env.PLATFORM_OPERATOR_EMAIL = OPERATOR;
  process.env.BILLING_REMINDER_ENABLED = 'false';
  process.env.BILLING_REMINDER_MIN_AGE_SECONDS = '600';
  process.env.BILLING_REMINDER_EXPIRY_WINDOW_SECONDS = '3600';
  process.env.BILLING_REMINDER_BATCH_SIZE = '50';

  app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: false,
    abortOnError: false,
  });
  prisma = app.get(PrismaService);
  reminders = app.get(BillingReminderService);
  emails = app.get(EmailService).testAdapter!;
  expect(emails).not.toBeNull();
}, 120_000);

afterAll(async () => {
  await app?.close();
  delete process.env.PLATFORM_OPERATOR_EMAIL;
  delete process.env.BILLING_REMINDER_ENABLED;
  delete process.env.BILLING_REMINDER_MIN_AGE_SECONDS;
  delete process.env.BILLING_REMINDER_EXPIRY_WINDOW_SECONDS;
  delete process.env.BILLING_REMINDER_BATCH_SIZE;
});

describe('Pengingat tagihan langganan untuk operator', () => {
  it('mengirim pengingat pertama tepat sekali untuk tagihan yang cukup umur', async () => {
    const now = new Date();
    const { tenantId, invoiceId } = await seedInvoice({
      createdAgoMs: HOUR,
      expiresInMs: 2 * HOUR,
      now,
    });

    await reminders.runOnce(now);
    expect(emailsFor(invoiceId)).toHaveLength(1);
    expect(emailsFor(invoiceId)[0]!.subject).toContain('Menunggu verifikasi');
    expect(emailsFor(invoiceId)[0]!.body).toContain('Rental Kamera Bandung');

    const row = await invoiceRow(invoiceId, tenantId);
    expect(row?.operatorNotifiedAt).not.toBeNull();
    expect(row?.expiryNotifiedAt).toBeNull();

    // Putaran berikutnya tidak mengirim ulang.
    await reminders.runOnce(new Date(now.getTime() + MINUTE));
    expect(emailsFor(invoiceId)).toHaveLength(1);
  });

  it('tidak mengingatkan tagihan yang baru saja dibuat', async () => {
    const now = new Date();
    const { invoiceId } = await seedInvoice({
      createdAgoMs: 0,
      expiresInMs: 2 * HOUR,
      now,
    });

    await reminders.runOnce(now);
    expect(emailsFor(invoiceId)).toHaveLength(0);
  });

  it('mengirim pengingat kedua saat mendekati kedaluwarsa, juga idempoten', async () => {
    const now = new Date();
    const { tenantId, invoiceId } = await seedInvoice({
      createdAgoMs: HOUR,
      expiresInMs: 2 * HOUR,
      now,
    });

    await reminders.runOnce(now);
    expect(emailsFor(invoiceId)).toHaveLength(1);

    await prisma.withTenant(tenantId, (tx) =>
      tx.subscriptionInvoice.update({
        where: { id: invoiceId },
        data: { expiresAt: new Date(now.getTime() + 10 * MINUTE) },
      }),
    );

    const later = new Date(now.getTime() + 2 * MINUTE);
    await reminders.runOnce(later);
    expect(emailsFor(invoiceId)).toHaveLength(2);
    expect(emailsFor(invoiceId)[1]!.subject).toContain('segera kedaluwarsa');

    const row = await invoiceRow(invoiceId, tenantId);
    expect(row?.expiryNotifiedAt).not.toBeNull();

    await reminders.runOnce(new Date(later.getTime() + MINUTE));
    expect(emailsFor(invoiceId)).toHaveLength(2);
  });

  it('tidak pernah mengingatkan tagihan yang sudah PAID', async () => {
    const now = new Date();
    const { invoiceId } = await seedInvoice({
      createdAgoMs: HOUR,
      expiresInMs: 2 * HOUR,
      status: 'PAID',
      now,
    });

    await reminders.runOnce(now);
    expect(emailsFor(invoiceId)).toHaveLength(0);
  });

  it('kegagalan pengiriman mengembalikan klaim agar pengingat dicoba lagi', async () => {
    const now = new Date();
    const { tenantId, invoiceId } = await seedInvoice({
      createdAgoMs: HOUR,
      expiresInMs: 2 * HOUR,
      now,
    });

    const originalSend = emails.send.bind(emails);
    (emails as unknown as { send: () => Promise<void> }).send = async () => {
      throw new Error('provider email sedang gangguan');
    };

    try {
      await reminders.runOnce(now);
    } finally {
      (emails as unknown as { send: typeof originalSend }).send = originalSend;
    }

    // Klaim dikembalikan: belum tercatat terkirim dan belum ada email.
    expect(emailsFor(invoiceId)).toHaveLength(0);
    const afterFailure = await invoiceRow(invoiceId, tenantId);
    expect(afterFailure?.operatorNotifiedAt).toBeNull();

    await reminders.runOnce(new Date(now.getTime() + MINUTE));
    expect(emailsFor(invoiceId)).toHaveLength(1);
    const afterRetry = await invoiceRow(invoiceId, tenantId);
    expect(afterRetry?.operatorNotifiedAt).not.toBeNull();
  });
});
