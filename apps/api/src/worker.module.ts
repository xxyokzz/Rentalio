import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { AuditModule } from './audit/audit.module.js';
import { EmailModule } from './email/email.module.js';
import { SubscriptionModule } from './subscriptions/subscription.module.js';
import { SubscriptionReconcilerService } from './subscriptions/subscription-reconciler.service.js';
import { OutboxWorkerService } from './outbox/outbox.worker.js';
import { BillingReminderService } from './billing/billing-reminder.service.js';

/**
 * Proses worker — job periodik dipisahkan dari API agar API tetap stateless.
 *
 * Modul ini sengaja TIDAK memuat controller HTTP. Reconciler subscription,
 * worker outbox, dan pengingat tagihan memakai polling berbasis database
 * (lease/syarat status), sehingga beberapa replika worker aman berjalan paralel.
 *
 * `BillingReminderService` sengaja didaftarkan langsung, bukan lewat
 * `BillingModule`: worker hanya butuh job-nya, bukan controller HTTP tenant.
 *
 * `AppModule` tidak mengimpor modul ini; lihat `worker.ts` sebagai entrypoint.
 */
@Module({
  imports: [ConfigModule, PrismaModule, AuditModule, EmailModule, SubscriptionModule],
  providers: [SubscriptionReconcilerService, OutboxWorkerService, BillingReminderService],
  exports: [SubscriptionReconcilerService, OutboxWorkerService, BillingReminderService],
})
export class WorkerModule {}
