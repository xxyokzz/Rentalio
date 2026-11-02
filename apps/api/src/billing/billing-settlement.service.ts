import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, SubscriptionInvoiceStatus } from '@rentalio/database';
import type { AppConfig } from '../config/env.validation.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { nextSubscriptionPeriod } from './subscription-period.js';
import { ApiError, ErrorCode } from '../common/errors.js';

/**
 * Penyelesaian tagihan langganan QRIS: satu-satunya tempat status tagihan
 * berubah menjadi PAID/EXPIRED.
 *
 * QRIS dinamis tidak memiliki callback pembayaran, jadi **tidak ada** sumber
 * status otomatis. `settle()` dipanggil operator platform dari Admin Platform
 * setelah dana terverifikasi; `expire()` dipakai saat tagihan lama dibuka
 * kembali sebagai pengganti.
 *
 * Klaim selalu memakai `updateMany` dengan syarat status PENDING, sehingga
 * dua operator yang menekan "tandai lunas" bersamaan hanya memperpanjang
 * langganan satu kali. Efek samping (status langganan, subscription_events,
 * audit) berada dalam transaksi yang sama dengan klaim tersebut.
 */

const PROVIDER = 'qris';

export type SubscriptionInvoiceRow = Prisma.SubscriptionInvoiceGetPayload<Record<string, never>>;

export interface SettleInput {
  /** Nominal yang benar-benar diterima (IDR utuh). Wajib >= nilai tagihan. */
  paidAmount: number;
  /** Kanal pembayaran, mis. `QRIS`. */
  channel?: string | null;
  /** Metode spesifik dari mutasi bank/e-wallet, bila operator mencatatnya. */
  method?: string | null;
  correlationId: string;
}

@Injectable()
export class BillingSettlementService {
  private readonly logger = new Logger(BillingSettlementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject('APP_CONFIG') private readonly config: AppConfig,
  ) {}

  /**
   * Tandai tagihan lunas dan perpanjang langganan.
   *
   * @returns `true` bila transisi dilakukan oleh pemanggil ini; `false` bila
   *          tagihan sudah tidak PENDING (sudah diselesaikan permintaan lain).
   */
  async settle(invoice: SubscriptionInvoiceRow, input: SettleInput): Promise<boolean> {
    if (invoice.status !== SubscriptionInvoiceStatus.PENDING) return false;

    const invoiceAmount = Number(invoice.amount);
    const paidAmount = Math.trunc(input.paidAmount);
    if (!Number.isFinite(paidAmount) || paidAmount < invoiceAmount) {
      throw new ApiError(
        ErrorCode.VALIDATION_ERROR,
        `Nominal diterima lebih kecil dari nilai tagihan (${invoiceAmount}).`,
      );
    }

    const now = new Date();
    const providerRef = invoice.externalId;

    return this.prisma.withTenant(invoice.tenantId, async (tx) => {
      const claimed = await tx.subscriptionInvoice.updateMany({
        where: { id: invoice.id, status: SubscriptionInvoiceStatus.PENDING },
        data: {
          status: SubscriptionInvoiceStatus.PAID,
          paidAt: now,
          paidAmount: BigInt(paidAmount),
          paymentMethod: input.method ?? null,
          paymentChannel: input.channel ?? 'QRIS',
        },
      });
      // Sudah diselesaikan permintaan/operator lain.
      if (claimed.count === 0) return false;

      const latest = await tx.subscription.findFirst({
        where: { tenantId: invoice.tenantId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      const period = nextSubscriptionPeriod(
        now,
        latest?.periodEnd ?? null,
        this.config.SUBSCRIPTION_PERIOD_DAYS,
      );

      let subscriptionId: string | null = latest?.id ?? null;
      if (latest) {
        await tx.subscription.update({
          where: { id: latest.id },
          data: {
            status: 'ACTIVE',
            activatedAt: latest.activatedAt ?? now,
            periodStart: period.start,
            periodEnd: period.end,
            graceStartedAt: null,
            graceEndsAt: null,
            cancelledAt: null,
            expiredAt: null,
            providerRef,
          },
        });
      } else {
        // Tenant tanpa baris subscription (plan platform sempat tidak ada).
        const plan = await tx.plan.findFirst({
          where: { tenantId: null },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
        if (plan) {
          const created = await tx.subscription.create({
            data: {
              tenantId: invoice.tenantId,
              planId: plan.id,
              status: 'ACTIVE',
              activatedAt: now,
              periodStart: period.start,
              periodEnd: period.end,
              providerRef,
            },
          });
          subscriptionId = created.id;
        }
      }

      if (subscriptionId) {
        // `providerEventId` unik per provider; cek dulu agar unique violation
        // tidak membatalkan seluruh transaksi.
        const providerEventId = `${providerRef}:PAID`;
        const existingEvent = await tx.subscriptionEvent.findFirst({
          where: { provider: PROVIDER, providerEventId },
        });
        if (!existingEvent) {
          await tx.subscriptionEvent.create({
            data: {
              tenantId: invoice.tenantId,
              subscriptionId,
              provider: PROVIDER,
              providerEventId,
              eventType: 'SUBSCRIPTION_RENEWED',
              payloadMeta: {
                invoiceId: invoice.id,
                amount: invoiceAmount,
                paidAmount,
                paymentMethod: input.method ?? null,
                paymentChannel: input.channel ?? 'QRIS',
                periodStart: period.start.toISOString(),
                periodEnd: period.end.toISOString(),
              },
            },
          });
        }
      }

      await this.audit.record(
        {
          tenantId: invoice.tenantId,
          action: 'SUBSCRIPTION_PAYMENT_RECEIVED',
          domain: 'subscription',
          entityType: 'subscription_invoice',
          entityId: invoice.id,
          fromState: 'PENDING',
          toState: 'PAID',
          correlationId: input.correlationId,
          metadata: {
            amount: invoiceAmount,
            paidAmount,
            paymentChannel: input.channel ?? 'QRIS',
            periodEnd: period.end.toISOString(),
          },
        },
        tx,
      );

      return true;
    });
  }

  /** Klaim PENDING → EXPIRED (tanpa menyentuh langganan). */
  async expire(invoice: SubscriptionInvoiceRow, correlationId: string): Promise<boolean> {
    if (invoice.status !== SubscriptionInvoiceStatus.PENDING) return false;
    return this.prisma.withTenant(invoice.tenantId, async (tx) => {
      const expired = await tx.subscriptionInvoice.updateMany({
        where: { id: invoice.id, status: SubscriptionInvoiceStatus.PENDING },
        data: { status: SubscriptionInvoiceStatus.EXPIRED },
      });
      if (expired.count === 0) return false;
      await this.audit.record(
        {
          tenantId: invoice.tenantId,
          action: 'SUBSCRIPTION_INVOICE_EXPIRED',
          domain: 'subscription',
          entityType: 'subscription_invoice',
          entityId: invoice.id,
          fromState: 'PENDING',
          toState: 'EXPIRED',
          correlationId,
        },
        tx,
      );
      return true;
    });
  }
}
