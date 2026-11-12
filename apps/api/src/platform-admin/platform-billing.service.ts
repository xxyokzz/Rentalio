import { Injectable } from '@nestjs/common';
import { SubscriptionInvoiceStatus } from '@rentalio/database';
import { PrismaService } from '../prisma/prisma.service.js';
import { ApiError, ErrorCode } from '../common/errors.js';
import { BillingSettlementService } from '../billing/billing-settlement.service.js';
import { recordPlatformAudit } from './platform-admin.audit.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SettleContext = { adminId: string; correlationId: string };
type ListContext = { adminId: string; correlationId: string };

export interface SettleInvoiceInput {
  paidAmount?: number;
  channel?: string;
  reason: string;
}

/**
 * Penyelesaian tagihan langganan dari sisi Admin Platform.
 *
 * QRIS dinamis hanya membawa data pembayaran — tidak ada provider yang
 * mengabarkan status. Karena itu satu-satunya jalan agar langganan aktif
 * adalah tindakan operator yang teraudit di sini:
 *
 *   1. Baca tagihan pada konteks tenant (`withTenant`) — RLS tenant tetap
 *      menjadi batas, sehingga invoice milik tenant lain tidak ditemukan.
 *   2. Klaim PENDING → PAID + perpanjangan langganan lewat
 *      `BillingSettlementService.settle` (satu transaksi, tepat sekali).
 *   3. Catat `PLATFORM_SUBSCRIPTION_INVOICE_SETTLED` pada audit platform,
 *      termasuk percobaan gagal (id tidak valid, tidak ditemukan, sudah lunas).
 */
@Injectable()
export class PlatformBillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settlement: BillingSettlementService,
  ) {}

  async settleInvoice(
    tenantId: string,
    invoiceId: string,
    input: SettleInvoiceInput,
    context: SettleContext,
  ) {
    const validIds = UUID_PATTERN.test(tenantId) && UUID_PATTERN.test(invoiceId);
    if (!validIds) {
      await this.auditFailure(tenantId, invoiceId, context, input, 'INVALID_ID');
      throw new ApiError(ErrorCode.VALIDATION_ERROR, 'ID tenant dan tagihan harus UUID.');
    }

    const invoice = await this.prisma.withTenant(tenantId, (tx) =>
      tx.subscriptionInvoice.findFirst({ where: { id: invoiceId, tenantId } }),
    );
    if (!invoice) {
      await this.auditFailure(tenantId, invoiceId, context, input, 'NOT_FOUND');
      throw new ApiError(ErrorCode.NOT_FOUND, 'Tagihan tidak ditemukan.');
    }
    if (invoice.status !== SubscriptionInvoiceStatus.PENDING) {
      await this.auditFailure(tenantId, invoiceId, context, input, 'INVALID_STATE', invoice.status);
      throw new ApiError(
        ErrorCode.INVALID_STATE_TRANSITION,
        `Tagihan tidak dapat diselesaikan dari status ${invoice.status}.`,
      );
    }

    const paidAmount = input.paidAmount ?? Number(invoice.amount);
    const settled = await this.settlement.settle(invoice, {
      paidAmount,
      channel: input.channel ?? 'QRIS',
      correlationId: context.correlationId,
    });

    if (!settled) {
      // Balapan dengan operator lain: klaim PENDING gagal di transaksi.
      await this.auditFailure(tenantId, invoiceId, context, input, 'CONCURRENT_SETTLE', 'PAID');
      throw new ApiError(
        ErrorCode.INVALID_STATE_TRANSITION,
        'Tagihan sudah diselesaikan permintaan lain.',
      );
    }

    await this.prisma.withTenant(tenantId, (tx) =>
      recordPlatformAudit(tx, {
        actorAdminId: context.adminId,
        action: 'PLATFORM_SUBSCRIPTION_INVOICE_SETTLED',
        targetType: 'subscription_invoice',
        targetId: invoiceId,
        reason: input.reason,
        outcome: 'SUCCESS',
        correlationId: context.correlationId,
        metadata: {
          tenantId,
          amount: Number(invoice.amount),
          paidAmount: Math.trunc(paidAmount),
          channel: input.channel ?? 'QRIS',
        },
      }),
    );

    return {
      data: {
        id: invoiceId,
        tenantId,
        status: SubscriptionInvoiceStatus.PAID,
        amount: invoice.amount.toString(),
        paidAmount: String(Math.trunc(paidAmount)),
        channel: input.channel ?? 'QRIS',
      },
    };
  }

  /**
   * Daftar tagihan PENDING satu tenant untuk panel settle.
   *
   * Dibaca pada konteks tenant (`withTenant`) sehingga RLS tetap menjadi batas,
   * dan setiap pembacaan dicatat `PLATFORM_SUBSCRIPTION_INVOICES_VIEWED`.
   * Respons sengaja minimal (id, nominal, kedaluwarsa) — tanpa payload QRIS.
   */
  async listPendingInvoices(tenantId: string, context: ListContext) {
    if (!UUID_PATTERN.test(tenantId)) {
      throw new ApiError(ErrorCode.VALIDATION_ERROR, 'ID tenant harus UUID.');
    }

    const invoices = await this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.subscriptionInvoice.findMany({
        where: { tenantId, status: SubscriptionInvoiceStatus.PENDING },
        orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
        take: 20,
        select: { id: true, amount: true, currency: true, expiresAt: true, createdAt: true },
      });
      await recordPlatformAudit(tx, {
        actorAdminId: context.adminId,
        action: 'PLATFORM_SUBSCRIPTION_INVOICES_VIEWED',
        targetType: 'tenant',
        targetId: tenantId,
        correlationId: context.correlationId,
        metadata: { tenantId, count: rows.length },
      });
      return rows;
    });

    return {
      data: invoices.map((invoice) => ({
        id: invoice.id,
        tenantId,
        amount: invoice.amount.toString(),
        currency: invoice.currency,
        expiresAt: invoice.expiresAt.toISOString(),
        createdAt: invoice.createdAt.toISOString(),
      })),
    };
  }

  private async auditFailure(
    tenantId: string,
    invoiceId: string,
    context: SettleContext,
    input: SettleInvoiceInput,
    denial: string,
    currentStatus?: string,
  ): Promise<void> {
    if (!UUID_PATTERN.test(tenantId)) return;
    await this.prisma
      .withTenant(tenantId, (tx) =>
        recordPlatformAudit(tx, {
          actorAdminId: context.adminId,
          action: 'PLATFORM_SUBSCRIPTION_INVOICE_SETTLED',
          targetType: 'subscription_invoice',
          targetId: invoiceId,
          reason: input.reason,
          outcome: 'FAILED',
          correlationId: context.correlationId,
          metadata: {
            denial,
            ...(currentStatus ? { status: currentStatus } : {}),
          },
        }),
      )
      .catch(() => {
        // Kegagalan audit tidak boleh menutupi error utama ke pemanggil.
      });
  }
}
