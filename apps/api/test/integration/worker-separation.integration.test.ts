/**
 * Integration test: proses API stateless.
 *
 * Job periodik (outbox + reconciler subscription) hanya boleh tersedia di
 * `WorkerModule`; `AppModule` tidak boleh menyediakan/menjalankannya.
 *
 * Billing langganan punya satu job: pengingat tagihan PENDING ke operator.
 * QRIS dinamis tidak menyediakan status yang bisa ditarik, jadi penyelesaian
 * pembayaran tetap manual lewat Admin Platform.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';

import { AppModule } from '../../src/app.module.js';
import { WorkerModule } from '../../src/worker.module.js';
import { OutboxWorkerService } from '../../src/outbox/outbox.worker.js';
import { SubscriptionReconcilerService } from '../../src/subscriptions/subscription-reconciler.service.js';
import { BillingReminderService } from '../../src/billing/billing-reminder.service.js';

let api: INestApplicationContext;
let worker: INestApplicationContext;

beforeAll(async () => {
  api = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
    abortOnError: false,
  });
  worker = await NestFactory.createApplicationContext(WorkerModule, {
    logger: false,
    abortOnError: false,
  });
}, 120_000);

afterAll(async () => {
  await worker?.close();
  await api?.close();
});

describe('Pemisahan proses worker', () => {
  it('AppModule tidak menyediakan worker outbox/reconciler', () => {
    expect(() => api.get(OutboxWorkerService, { strict: false })).toThrow();
    expect(() => api.get(SubscriptionReconcilerService, { strict: false })).toThrow();
    expect(() => api.get(BillingReminderService, { strict: false })).toThrow();
  });

  it('WorkerModule menyediakan seluruh job periodik', () => {
    expect(worker.get(OutboxWorkerService)).toBeInstanceOf(OutboxWorkerService);
    expect(worker.get(SubscriptionReconcilerService)).toBeInstanceOf(
      SubscriptionReconcilerService,
    );
    expect(worker.get(BillingReminderService)).toBeInstanceOf(BillingReminderService);
  });
});
