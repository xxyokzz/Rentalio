import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Prisma } from '@rentalio/database';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { TenantService } from '../tenant/tenant.service.js';
import { PaymentSettingsService } from '../payment-settings/payment-settings.service.js';
import { WhatsAppMessagesService } from '../whatsapp-templates/whatsapp-messages.service.js';
import { ApiError, ErrorCode } from '../common/errors.js';
import { hashToken } from '../common/crypto.js';
import type {
  CompleteOrderDto,
  CreateCollateralDto,
  CreateOrderDto,
  CreateOrderPenaltyDto,
  DepositDecisionDto,
  DepositDeductionDto,
  DepositReceiptDto,
  DepositRefundDto,
  HandoverDto,
  ListOrdersQueryDto,
  ReadyForHandoverDto,
  RecordPaymentDto,
  RefundDecisionDto,
  RefundResultDto,
  RequestRefundDto,
  ReturnCollateralDto,
  ReverseDepositMovementDto,
  VoidOrderPenaltyDto,
  VoidPaymentDto,
} from './orders.dto.js';

type Ctx = { actorUserId: string; correlationId: string; idempotencyKey?: string };

const ORDER_INCLUDE = {
  items: true,
  payments: { orderBy: { recordedAt: 'asc' } },
  penalties: { orderBy: { createdAt: 'asc' } },
  deposits: {
    include: {
      movements: { orderBy: { createdAt: 'asc' } },
      deductionRequests: { orderBy: { createdAt: 'desc' } },
    },
  },
  collaterals: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.RentalOrderInclude;

const DEPOSIT_INCLUDE = {
  movements: { orderBy: { createdAt: 'asc' } },
  deductionRequests: { orderBy: { createdAt: 'desc' } },
} satisfies Prisma.DepositInclude;

type OrderRow = Prisma.RentalOrderGetPayload<{ include: typeof ORDER_INCLUDE }>;
type DepositRow = Prisma.DepositGetPayload<{ include: typeof DEPOSIT_INCLUDE }>;
type MovementRow = Prisma.DepositMovementGetPayload<Record<string, never>>;
type PaymentRow = Prisma.PaymentGetPayload<Record<string, never>>;
type RefundRow = Prisma.RefundGetPayload<Record<string, never>>;
type DeductionRow = Prisma.DepositDeductionRequestGetPayload<Record<string, never>>;
type CollateralRow = Prisma.CollateralGetPayload<Record<string, never>>;
type PenaltyRow = Prisma.OrderPenaltyGetPayload<Record<string, never>>;

/** Status refund yang masih menahan (mengunci) nilai refundable. */
const REFUND_RESERVING_STATUSES = ['REQUESTED', 'APPROVED', 'PROCESSING', 'SUCCEEDED'] as const;

const IDEMPOTENCY_TTL_MS = 24 * 3600 * 1000;

/** P2002 pada unique (tenantId, scope, key) — bukan konflik constraint lain. */
function isIdempotencyConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; meta?: { target?: unknown }; message?: string };
  if (e.code !== 'P2002') return false;
  const target = Array.isArray(e.meta?.target)
    ? e.meta!.target.join(',')
    : String(e.meta?.target ?? '');
  return target.includes('scope') || String(e.message ?? '').includes('scope');
}

/**
 * Order, pembayaran manual, dan deposit — ADR-001 §3–§4 + Notion 04.
 *
 * Prinsip:
 * - Order hasil konversi reservasi unik per reservasi (constraint DB), sehingga
 *   konversi ulang mengembalikan order yang sama, bukan membuat duplikat.
 * - Harga/total dihitung server dari snapshot item reservasi; client tidak
 *   pernah mengirim harga.
 * - Payment tidak menghapus/menimpa histori: koreksi lewat VOID beralasan.
 * - Deposit adalah ledger append-only; saldo dihitung dari movement, bukan
 *   status mutable. Semua command saldo mengunci baris deposit (FOR UPDATE)
 *   agar potongan/refund paralel tidak menghasilkan saldo negatif.
 * - Potongan deposit dua langkah: pengajuan (`deposit.deduct`) dan keputusan
 *   terpisah oleh aktor lain (`deposit.deduct.approve`).
 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tenantService: TenantService,
    private readonly paymentSettings: PaymentSettingsService,
    private readonly whatsappMessages: WhatsAppMessagesService,
  ) {}

  // ============================================================
  // Order
  // ============================================================

  async listOrders(tenantId: string, query: ListOrdersQueryDto, actorUserId: string) {
    await this.tenantService.requirePermission(tenantId, actorUserId, 'order.read');
    return this.prisma.withTenant(tenantId, async (tx) => {
      const where = {
        tenantId,
        ...(query.status ? { status: query.status } : {}),
      } as Prisma.RentalOrderWhereInput;
      const [rows, total] = await Promise.all([
        tx.rentalOrder.findMany({
          where,
          include: ORDER_INCLUDE,
          orderBy: { createdAt: 'desc' },
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
        tx.rentalOrder.count({ where }),
      ]);
      return {
        data: rows.map((row) => this.mapOrder(row)),
        page: query.page,
        pageSize: query.pageSize,
        total,
      };
    });
  }

  /** GET /orders/:id — detail order + riwayat snapshot pesan WhatsApp. */
  async getOrder(tenantId: string, orderId: string, actorUserId: string) {
    await this.tenantService.requirePermission(tenantId, actorUserId, 'order.read');
    return this.prisma.withTenant(tenantId, async (tx) => {
      const view = await this.loadOrder(tx, tenantId, orderId);
      return {
        ...view,
        whatsappMessages: await this.whatsappMessages.listSnapshots(tx, tenantId, orderId),
      };
    });
  }

  /** POST /orders — alias konversi berbasis reservasi (MVP). */
  async createOrder(tenantId: string, dto: CreateOrderDto, ctx: Ctx) {
    return this.convertReservation(tenantId, dto.reservationId, ctx);
  }

  /**
   * POST /reservations/:id/convert-to-order.
   * Hanya reservasi CONFIRMED. Kunci baris reservasi mencegah dua request
   * paralel membuat order ganda; unique (tenantId, sourceReservationId)
   * menjadi tameng terakhir.
   */
  async convertReservation(tenantId: string, reservationId: string, ctx: Ctx) {
    await this.tenantService.requirePermission(tenantId, ctx.actorUserId, 'order.create');
    return this.prisma.withTenant(tenantId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM reservations WHERE "tenantId" = ${tenantId} AND id = ${reservationId} FOR UPDATE`;

      const existing = await tx.rentalOrder.findFirst({
        where: { tenantId, sourceReservationId: reservationId },
        include: ORDER_INCLUDE,
      });
      if (existing) {
        return {
          ...this.mapOrder(existing),
          whatsappMessages: await this.whatsappMessages.listSnapshots(
            tx,
            tenantId,
            existing.id,
          ),
        };
      }

      const reservation = await tx.reservation.findUnique({
        where: { tenantId_id: { tenantId, id: reservationId } },
        include: { items: true, allocations: true },
      });
      if (!reservation) {
        throw new ApiError(ErrorCode.NOT_FOUND, 'Reservasi tidak ditemukan.');
      }
      if (reservation.status !== 'CONFIRMED') {
        throw new ApiError(
          ErrorCode.INVALID_STATE_TRANSITION,
          `Reservasi berstatus ${reservation.status} tidak dapat dikonversi menjadi order.`,
        );
      }
      if (reservation.items.length === 0) {
        throw new ApiError(
          ErrorCode.BUSINESS_RULE_VIOLATION,
          'Reservasi tidak memiliki item untuk dikonversi.',
        );
      }

      const tenant = await tx.tenant.findUnique({ where: { id: tenantId } });
      if (!tenant) throw new ApiError(ErrorCode.NOT_FOUND, 'Tenant tidak ditemukan.');
      if (tenant.status !== 'ACTIVE') {
        throw new ApiError(
          ErrorCode.BUSINESS_RULE_VIOLATION,
          'Tenant tidak aktif; order baru tidak dapat dibuat.',
        );
      }

      const totalAmount = reservation.items.reduce(
        (sum, item) => sum + item.priceSnapshot * BigInt(item.quantity),
        0n,
      );

      // Unit fisik hanya diatribusikan bila item berkuantitas 1 dan alokasinya
      // tepat satu; selain itu biarkan null (return memakai item/asset sendiri).
      const allocationsByProduct = new Map<string, string[]>();
      for (const allocation of reservation.allocations) {
        if (allocation.status !== 'ACTIVE' || !allocation.assetId) continue;
        const list = allocationsByProduct.get(allocation.productId) ?? [];
        list.push(allocation.assetId);
        allocationsByProduct.set(allocation.productId, list);
      }

      const order = await tx.rentalOrder.create({
        data: {
          tenantId,
          orderNumber: this.newOrderNumber(),
          sourceReservationId: reservationId,
          customerId: reservation.customerId,
          status: 'CONFIRMED',
          currency: 'IDR',
          totalAmount,
        },
      });

      await tx.rentalItem.createMany({
        data: reservation.items.map((item) => ({
          tenantId,
          orderId: order.id,
          productId: item.productId,
          assetId:
            item.quantity === 1 && allocationsByProduct.get(item.productId)?.length === 1
              ? allocationsByProduct.get(item.productId)![0]
              : null,
          quantity: item.quantity,
          startAt: item.startAt,
          endAt: item.endAt,
          priceSnapshot: item.priceSnapshot,
          currency: item.currency,
        })),
      });

      await tx.deposit.create({
        data: { tenantId, orderId: order.id, currency: 'IDR' },
      });

      await tx.reservation.update({
        where: { tenantId_id: { tenantId, id: reservationId } },
        data: { status: 'CONVERTED_TO_ORDER' },
      });

      await this.audit.record(
        {
          tenantId,
          actorUserId: ctx.actorUserId,
          action: 'ORDER_CREATED',
          domain: 'order',
          entityType: 'rental_order',
          entityId: order.id,
          fromState: reservation.status,
          toState: order.status,
          correlationId: ctx.correlationId,
          metadata: {
            orderNumber: order.orderNumber,
            reservationId,
            totalAmount: totalAmount.toString(),
            itemCount: reservation.items.length,
          },
        },
        tx,
      );

      const view = await this.loadOrder(tx, tenantId, order.id);
      return {
        ...view,
        whatsappMessages: await this.whatsappMessages.createBookingMessages(
          tx,
          tenantId,
          order.id,
        ),
      };
    });
  }

  async readyForHandover(
    tenantId: string,
    orderId: string,
    dto: ReadyForHandoverDto,
    ctx: Ctx,
  ) {
    await this.tenantService.requirePermission(tenantId, ctx.actorUserId, 'order.handover');
    const scope = 'order-ready-for-handover';
    return this.runIdempotent(
      tenantId,
      scope,
      ctx,
      { orderId, note: dto.note?.trim() ?? null },
      async (tx) => {
        const order = await this.requireOrder(tx, tenantId, orderId);
        if (order.status !== 'CONFIRMED') {
          throw new ApiError(
            ErrorCode.INVALID_STATE_TRANSITION,
            `Order berstatus ${order.status} tidak dapat ditandai siap serah-terima.`,
          );
        }
        await tx.rentalOrder.update({
          where: { tenantId_id: { tenantId, id: orderId } },
          data: { status: 'READY_FOR_HANDOVER' },
        });
        await this.audit.record(
          {
            tenantId,
            actorUserId: ctx.actorUserId,
            action: 'ORDER_READY_FOR_HANDOVER',
            domain: 'order',
            entityType: 'rental_order',
            entityId: orderId,
            fromState: order.status,
            toState: 'READY_FOR_HANDOVER',
            correlationId: ctx.correlationId,
            reason: dto.note?.trim() || undefined,
          },
          tx,
        );
        return this.loadOrder(tx, tenantId, orderId);
      },
    );
  }

  async handover(tenantId: string, orderId: string, dto: HandoverDto, ctx: Ctx) {
    await this.tenantService.requirePermission(tenantId, ctx.actorUserId, 'order.handover');
    const handoverAt = dto.handoverAt ? new Date(dto.handoverAt) : new Date();
    if (Number.isNaN(handoverAt.getTime())) {
      throw new ApiError(ErrorCode.VALIDATION_ERROR, 'handoverAt tidak valid.');
    }
    if (handoverAt.getTime() > Date.now() + 5 * 60 * 1000) {
      throw new ApiError(ErrorCode.VALIDATION_ERROR, 'handoverAt tidak boleh di masa depan.');
    }
    const scope = 'order-handover';
    return this.runIdempotent(
      tenantId,
      scope,
      ctx,
      {
        orderId,
        // Waktu default server tidak masuk fingerprint: retry tanpa field itu
        // harus tetap dianggap permintaan yang sama.
        handoverAt: dto.handoverAt ?? null,
        conditionNotes: dto.conditionNotes?.trim() ?? null,
        evidenceRefs: [...(dto.evidenceRefs ?? [])].sort(),
      },
      async (tx) => {
        const order = await this.requireOrder(tx, tenantId, orderId);
        if (order.status !== 'READY_FOR_HANDOVER') {
          throw new ApiError(
            ErrorCode.INVALID_STATE_TRANSITION,
            `Order berstatus ${order.status} tidak dapat diserah-terimakan.`,
          );
        }
        await tx.rentalOrder.update({
          where: { tenantId_id: { tenantId, id: orderId } },
          data: { status: 'ACTIVE' },
        });
        await this.audit.record(
          {
            tenantId,
            actorUserId: ctx.actorUserId,
            action: 'ORDER_HANDED_OVER',
            domain: 'order',
            entityType: 'rental_order',
            entityId: orderId,
            fromState: order.status,
            toState: 'ACTIVE',
            correlationId: ctx.correlationId,
            metadata: {
              handoverAt: handoverAt.toISOString(),
              conditionNotes: dto.conditionNotes?.trim() ?? null,
              evidenceRefs: dto.evidenceRefs ?? [],
            },
          },
          tx,
        );
        return this.loadOrder(tx, tenantId, orderId);
      },
    );
  }

  async completeOrder(
    tenantId: string,
    orderId: string,
    dto: CompleteOrderDto,
    ctx: Ctx,
  ) {
    await this.tenantService.requirePermission(tenantId, ctx.actorUserId, 'order.return');
    const scope = 'order-complete';
    return this.runIdempotent(
      tenantId,
      scope,
      ctx,
      { orderId, settlementNote: dto.settlementNote?.trim() ?? null },
      async (tx) => {
        const order = await this.requireOrder(tx, tenantId, orderId);
        if (order.status !== 'RETURN_IN_PROGRESS') {
          throw new ApiError(
            ErrorCode.INVALID_STATE_TRANSITION,
            `Order berstatus ${order.status} tidak dapat diselesaikan.`,
          );
        }
        const pendingReturns = await tx.returnRecord.count({
          where: { tenantId, orderId, status: 'PENDING' },
        });
        if (pendingReturns > 0) {
          throw new ApiError(
            ErrorCode.BUSINESS_RULE_VIOLATION,
            'Masih ada pengembalian PENDING yang harus diselesaikan/dibatalkan.',
          );
        }
        await tx.rentalOrder.update({
          where: { tenantId_id: { tenantId, id: orderId } },
          data: { status: 'COMPLETED' },
        });
        await this.audit.record(
          {
            tenantId,
            actorUserId: ctx.actorUserId,
            action: 'ORDER_COMPLETED',
            domain: 'order',
            entityType: 'rental_order',
            entityId: orderId,
            fromState: order.status,
            toState: 'COMPLETED',
            correlationId: ctx.correlationId,
            reason: dto.settlementNote?.trim() || undefined,
          },
          tx,
        );
        return this.loadOrder(tx, tenantId, orderId);
      },
    );
  }

  // ============================================================
  // Payment manual
  // ============================================================

  async listPayments(tenantId: string, orderId: string, actorUserId: string) {
    await this.tenantService.requirePermission(tenantId, actorUserId, 'payment.read');
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.requireOrder(tx, tenantId, orderId);
      const payments = await tx.payment.findMany({
        where: { tenantId, orderId },
        orderBy: { recordedAt: 'asc' },
      });
      return {
        data: payments.map((payment) => this.mapPayment(payment)),
      };
    });
  }

  /** GET /orders/:id/whatsapp-messages — histori snapshot pesan transaksi. */
  async listWhatsAppMessages(tenantId: string, orderId: string, actorUserId: string) {
    await this.tenantService.requirePermission(tenantId, actorUserId, 'payment.read');
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.requireOrder(tx, tenantId, orderId);
      return {
        data: await this.whatsappMessages.listSnapshots(tx, tenantId, orderId),
      };
    });
  }

  async recordPayment(
    tenantId: string,
    orderId: string,
    dto: RecordPaymentDto,
    ctx: Ctx,
  ) {
    await this.tenantService.requirePermission(tenantId, ctx.actorUserId, 'payment.record');
    const amount = this.parseAmount(dto.amount);
    const receivedAt = dto.receivedAt ? new Date(dto.receivedAt) : new Date();
    if (Number.isNaN(receivedAt.getTime())) {
      throw new ApiError(ErrorCode.VALIDATION_ERROR, 'receivedAt tidak valid.');
    }
    if (receivedAt.getTime() > Date.now() + 5 * 60 * 1000) {
      throw new ApiError(ErrorCode.VALIDATION_ERROR, 'receivedAt tidak boleh di masa depan.');
    }
    const reference = dto.reference?.trim() || null;
    const context = dto.context ?? 'NEW_BOOKING';
    const scope = 'record-payment';

    return this.runIdempotent(
      tenantId,
      scope,
      ctx,
      {
        orderId,
        amount: amount.toString(),
        currency: dto.currency,
        method: dto.method,
        context,
        // Waktu default server tidak masuk fingerprint (lihat handover).
        receivedAt: dto.receivedAt ?? null,
        reference,
      },
      async (tx) => {
        const order = await this.requireOrder(tx, tenantId, orderId);
        if (order.status === 'CANCELLED') {
          throw new ApiError(
            ErrorCode.INVALID_STATE_TRANSITION,
            'Pembayaran tidak dapat dicatat pada order CANCELLED.',
          );
        }
        if (order.currency !== dto.currency) {
          throw new ApiError(
            ErrorCode.VALIDATION_ERROR,
            `Mata uang order adalah ${order.currency}.`,
          );
        }

        await this.paymentSettings.assertMethodEnabled(
          tx,
          tenantId,
          context,
          dto.method,
        );

        const payment = await tx.payment.create({
          data: {
            tenantId,
            orderId,
            amount,
            currency: dto.currency,
            method: dto.method,
            context,
            status: 'RECORDED',
            reference,
            recordedAt: receivedAt,
          },
        });

        await this.audit.record(
          {
            tenantId,
            actorUserId: ctx.actorUserId,
            action: 'PAYMENT_RECORDED',
            domain: 'payment',
            entityType: 'payment',
            entityId: payment.id,
            toState: payment.status,
            correlationId: ctx.correlationId,
            metadata: {
              orderId,
              amount: amount.toString(),
              currency: payment.currency,
              method: payment.method,
              context: payment.context,
              reference,
            },
          },
          tx,
        );

        const view = await this.paymentWithTotals(tx, tenantId, orderId, payment);
        return {
          ...view,
          whatsappMessage: await this.whatsappMessages.createPaymentMessage(
            tx,
            tenantId,
            payment,
          ),
        };
      },
    );
  }

  async voidPayment(tenantId: string, paymentId: string, dto: VoidPaymentDto, ctx: Ctx) {
    await this.tenantService.requirePermission(tenantId, ctx.actorUserId, 'payment.void');
    const reason = dto.reason.trim();
    const scope = 'void-payment';

    return this.runIdempotent(
      tenantId,
      scope,
      ctx,
      { paymentId, reason },
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM payments WHERE "tenantId" = ${tenantId} AND id = ${paymentId} FOR UPDATE`;
        const payment = await tx.payment.findUnique({
          where: { tenantId_id: { tenantId, id: paymentId } },
        });
        if (!payment) throw new ApiError(ErrorCode.NOT_FOUND, 'Pembayaran tidak ditemukan.');
        if (payment.status !== 'RECORDED') {
          throw new ApiError(
            ErrorCode.INVALID_STATE_TRANSITION,
            `Pembayaran berstatus ${payment.status} tidak dapat di-void.`,
          );
        }

        const updated = await tx.payment.update({
          where: { tenantId_id: { tenantId, id: paymentId } },
          data: {
            status: 'VOIDED',
            voidReason: reason,
            voidedByUserId: ctx.actorUserId,
            voidedAt: new Date(),
          },
        });

        await this.audit.record(
          {
            tenantId,
            actorUserId: ctx.actorUserId,
            action: 'PAYMENT_VOIDED',
            domain: 'payment',
            entityType: 'payment',
            entityId: payment.id,
            fromState: payment.status,
            toState: updated.status,
            reason,
            correlationId: ctx.correlationId,
            metadata: {
              orderId: payment.orderId,
              amount: payment.amount.toString(),
              currency: payment.currency,
            },
          },
          tx,
        );

        return this.paymentWithTotals(tx, tenantId, payment.orderId, updated);
      },
    );
  }

  // ============================================================
  // Refund pembayaran sewa (terpisah dari payment dan deposit)
  // ============================================================

  async listRefunds(tenantId: string, orderId: string, actorUserId: string) {
    await this.tenantService.requirePermission(tenantId, actorUserId, 'payment.read');
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.requireOrder(tx, tenantId, orderId);
      const refunds = await tx.refund.findMany({
        where: { tenantId, orderId },
        orderBy: { requestedAt: 'asc' },
      });
      const payments = await tx.payment.findMany({
        where: { tenantId, orderId, id: { in: refunds.map((r) => r.paymentId) } },
      });
      const amountByPayment = new Map(payments.map((p) => [p.id, p.amount]));
      return {
        data: refunds.map((refund) => {
          const totals = this.refundTotalsFromRows(
            refunds.filter((r) => r.paymentId === refund.paymentId),
            amountByPayment.get(refund.paymentId) ?? 0n,
          );
          return this.mapRefund(refund, totals.refundableAmount, totals.refundedAmount);
        }),
      };
    });
  }

  async requestRefund(tenantId: string, orderId: string, dto: RequestRefundDto, ctx: Ctx) {
    await this.tenantService.requirePermission(tenantId, ctx.actorUserId, 'refund.request');
    const amount = this.parseAmount(dto.amount);
    const reason = dto.reason.trim();
    const reference = dto.reference?.trim() || null;
    const scope = 'refund-request';

    return this.runIdempotent(
      tenantId,
      scope,
      ctx,
      { orderId, paymentId: dto.paymentId, amount: amount.toString(), currency: dto.currency, reason, reference },
      async (tx) => {
        const order = await this.requireOrder(tx, tenantId, orderId);
        if (order.currency !== dto.currency) {
          throw new ApiError(ErrorCode.VALIDATION_ERROR, `Mata uang order adalah ${order.currency}.`);
        }

        // Kunci payment: dua pengajuan paralel tidak boleh sama-sama lolos
        // batas refundable. Refund hanya dapat dibuat untuk payment RECORDED.
        await tx.$queryRaw`SELECT id FROM payments WHERE "tenantId" = ${tenantId} AND id = ${dto.paymentId} FOR UPDATE`;
        const payment = await tx.payment.findUnique({
          where: { tenantId_id: { tenantId, id: dto.paymentId } },
        });
        if (!payment || payment.orderId !== orderId) {
          throw new ApiError(ErrorCode.NOT_FOUND, 'Pembayaran tidak ditemukan pada order ini.');
        }
        if (payment.status !== 'RECORDED') {
          throw new ApiError(
            ErrorCode.INVALID_STATE_TRANSITION,
            `Pembayaran berstatus ${payment.status} tidak dapat direfund.`,
          );
        }

        const totals = await this.refundTotals(tx, tenantId, payment.id, payment.amount);
        if (amount > totals.refundableAmount) {
          throw new ApiError(
            ErrorCode.BUSINESS_RULE_VIOLATION,
            `Nominal refund melebihi sisa yang dapat direfund (${totals.refundableAmount.toString()} IDR).`,
          );
        }

        const refund = await tx.refund.create({
          data: {
            tenantId,
            orderId,
            paymentId: payment.id,
            amount,
            currency: dto.currency,
            status: 'REQUESTED',
            reason,
            reference,
            requestedByUserId: ctx.actorUserId,
          },
        });

        await this.audit.record(
          {
            tenantId,
            actorUserId: ctx.actorUserId,
            action: 'REFUND_REQUESTED',
            domain: 'refund',
            entityType: 'refund',
            entityId: refund.id,
            toState: refund.status,
            reason,
            correlationId: ctx.correlationId,
            metadata: {
              orderId,
              paymentId: payment.id,
              amount: amount.toString(),
              currency: refund.currency,
              reference,
            },
          },
          tx,
        );

        return this.mapRefund(
          refund,
          totals.refundableAmount - amount,
          totals.refundedAmount,
        );
      },
    );
  }

  async approveRefund(tenantId: string, refundId: string, dto: RefundDecisionDto, ctx: Ctx) {
    await this.tenantService.requirePermission(tenantId, ctx.actorUserId, 'refund.approve');
    const decisionReason = dto.reason?.trim() || null;
    const scope = 'refund-approve';

    return this.runIdempotent(
      tenantId,
      scope,
      ctx,
      { refundId, decisionReason },
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM refunds WHERE "tenantId" = ${tenantId} AND id = ${refundId} FOR UPDATE`;
        const refund = await tx.refund.findUnique({
          where: { tenantId_id: { tenantId, id: refundId } },
        });
        if (!refund) throw new ApiError(ErrorCode.NOT_FOUND, 'Refund tidak ditemukan.');

        await tx.$queryRaw`SELECT id FROM payments WHERE "tenantId" = ${tenantId} AND id = ${refund.paymentId} FOR UPDATE`;
        const payment = await tx.payment.findUnique({
          where: { tenantId_id: { tenantId, id: refund.paymentId } },
        });
        if (!payment) throw new ApiError(ErrorCode.NOT_FOUND, 'Pembayaran tidak ditemukan.');
        if (refund.status !== 'REQUESTED') {
          throw new ApiError(
            ErrorCode.INVALID_STATE_TRANSITION,
            `Refund berstatus ${refund.status} tidak dapat disetujui.`,
          );
        }

        const totals = await this.refundTotals(tx, tenantId, payment.id, payment.amount);
        const reservedWithoutThis = totals.reservedAmount - refund.amount;
        if (refund.amount > payment.amount - reservedWithoutThis) {
          throw new ApiError(
            ErrorCode.BUSINESS_RULE_VIOLATION,
            'Nominal refund melebihi nilai pembayaran yang dapat direfund.',
          );
        }

        const updated = await tx.refund.update({
          where: { tenantId_id: { tenantId, id: refundId } },
          data: {
            status: 'APPROVED',
            approvedByUserId: ctx.actorUserId,
            decisionReason,
          },
        });

        await this.audit.record(
          {
            tenantId,
            actorUserId: ctx.actorUserId,
            action: 'REFUND_APPROVED',
            domain: 'refund',
            entityType: 'refund',
            entityId: refundId,
            fromState: refund.status,
            toState: updated.status,
            reason: decisionReason ?? refund.reason ?? undefined,
            correlationId: ctx.correlationId,
            metadata: {
              orderId: refund.orderId,
              paymentId: refund.paymentId,
              amount: refund.amount.toString(),
            },
          },
          tx,
        );

        return this.mapRefund(updated, totals.refundableAmount, totals.refundedAmount);
      },
    );
  }

  async recordRefundResult(
    tenantId: string,
    refundId: string,
    dto: RefundResultDto,
    ctx: Ctx,
  ) {
    await this.tenantService.requirePermission(tenantId, ctx.actorUserId, 'refund.process');
    const reference = dto.reference?.trim() || null;
    const resultNote = dto.note?.trim() || null;
    const scope = 'refund-record-result';

    return this.runIdempotent(
      tenantId,
      scope,
      ctx,
      { refundId, status: dto.status, reference, resultNote },
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM refunds WHERE "tenantId" = ${tenantId} AND id = ${refundId} FOR UPDATE`;
        const refund = await tx.refund.findUnique({
          where: { tenantId_id: { tenantId, id: refundId } },
        });
        if (!refund) throw new ApiError(ErrorCode.NOT_FOUND, 'Refund tidak ditemukan.');

        await tx.$queryRaw`SELECT id FROM payments WHERE "tenantId" = ${tenantId} AND id = ${refund.paymentId} FOR UPDATE`;
        const payment = await tx.payment.findUnique({
          where: { tenantId_id: { tenantId, id: refund.paymentId } },
        });
        if (!payment) throw new ApiError(ErrorCode.NOT_FOUND, 'Pembayaran tidak ditemukan.');
        if (!['APPROVED', 'PROCESSING'].includes(refund.status)) {
          throw new ApiError(
            ErrorCode.INVALID_STATE_TRANSITION,
            `Refund berstatus ${refund.status} tidak dapat dicatat hasilnya.`,
          );
        }

        const updated = await tx.refund.update({
          where: { tenantId_id: { tenantId, id: refundId } },
          data: {
            status: dto.status,
            processedByUserId: ctx.actorUserId,
            processedAt: new Date(),
            reference: reference ?? refund.reference,
            resultNote,
          },
        });

        const totals = await this.refundTotals(tx, tenantId, payment.id, payment.amount);
        await this.audit.record(
          {
            tenantId,
            actorUserId: ctx.actorUserId,
            action: dto.status === 'SUCCEEDED' ? 'REFUND_SUCCEEDED' : 'REFUND_FAILED',
            domain: 'refund',
            entityType: 'refund',
            entityId: refundId,
            fromState: refund.status,
            toState: updated.status,
            reason: resultNote ?? refund.reason ?? undefined,
            correlationId: ctx.correlationId,
            metadata: {
              orderId: refund.orderId,
              paymentId: refund.paymentId,
              amount: refund.amount.toString(),
              reference,
            },
          },
          tx,
        );

        return this.mapRefund(updated, totals.refundableAmount, totals.refundedAmount);
      },
    );
  }

  // ============================================================
  // Deposit ledger
  // ============================================================

  async getDeposit(tenantId: string, orderId: string, actorUserId: string) {
    await this.tenantService.requirePermission(tenantId, actorUserId, 'deposit.read');
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.requireOrder(tx, tenantId, orderId);
      const deposit = await this.ensureDeposit(tx, tenantId, orderId);
      const row = await tx.deposit.findUniqueOrThrow({
        where: { tenantId_id: { tenantId, id: deposit.id } },
        include: DEPOSIT_INCLUDE,
      });
      return this.mapDeposit(row);
    });
  }

  async receiveDeposit(tenantId: string, orderId: string, dto: DepositReceiptDto, ctx: Ctx) {
    await this.tenantService.requirePermission(tenantId, ctx.actorUserId, 'deposit.receive');
    const amount = this.parseAmount(dto.amount);
    const reference = dto.reference?.trim() || null;
    const note = dto.note?.trim() || null;
    const scope = 'deposit-receipt';

    return this.runIdempotent(
      tenantId,
      scope,
      ctx,
      {
        orderId,
        amount: amount.toString(),
        currency: dto.currency,
        method: dto.method ?? null,
        reference,
        note,
      },
      async (tx) => {
        const order = await this.requireOrder(tx, tenantId, orderId);
        this.assertDepositMovable(order.status);
        if (order.currency !== dto.currency) {
          throw new ApiError(
            ErrorCode.VALIDATION_ERROR,
            `Mata uang order adalah ${order.currency}.`,
          );
        }
        const deposit = await this.ensureDeposit(tx, tenantId, orderId);
        await this.lockDeposit(tx, tenantId, orderId);

        const movement = await tx.depositMovement.create({
          data: {
            tenantId,
            depositId: deposit.id,
            type: 'RECEIPT',
            amount,
            currency: dto.currency,
            reason: note,
            method: dto.method ?? null,
            reference,
            actorUserId: ctx.actorUserId,
            idempotencyKey: ctx.idempotencyKey ?? null,
          },
        });

        await this.audit.record(
          {
            tenantId,
            actorUserId: ctx.actorUserId,
            action: 'DEPOSIT_RECEIVED',
            domain: 'deposit',
            entityType: 'deposit_movement',
            entityId: movement.id,
            toState: movement.type,
            correlationId: ctx.correlationId,
            metadata: {
              orderId,
              amount: amount.toString(),
              method: dto.method ?? null,
              reference,
            },
          },
          tx,
        );

        return this.loadDeposit(tx, tenantId, orderId);
      },
    );
  }

  /**
   * Catat denda kerusakan yang sudah disetujui sebagai tagihan order.
   *
   * Nominal diambil dari inspeksi (bukan body) supaya angka yang ditagih selalu
   * sama dengan keputusan petugas. Unik per inspeksi: permintaan ulang
   * mengembalikan baris yang sudah ada, bukan membuat tagihan kedua.
   * `totalAmount` sewa tidak diubah; denda muncul terpisah sebagai
   * `penaltyTotalAmount` dan `amountDue`.
   */
  async createPenalty(
    tenantId: string,
    orderId: string,
    dto: CreateOrderPenaltyDto,
    ctx: Ctx,
  ) {
    await this.tenantService.requireMembership(tenantId, ctx.actorUserId, ['OWNER', 'MANAGER']);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const order = await this.requireOrder(tx, tenantId, orderId);
      const inspection = await tx.inspection.findUnique({
        where: { tenantId_id: { tenantId, id: dto.inspectionId } },
      });
      if (!inspection || inspection.orderId !== orderId) {
        throw new ApiError(ErrorCode.NOT_FOUND, 'Inspeksi tidak ditemukan pada order ini.');
      }
      if (inspection.status !== 'APPROVED') {
        throw new ApiError(
          ErrorCode.INVALID_STATE_TRANSITION,
          'Denda hanya dapat ditagihkan dari inspeksi berstatus APPROVED.',
        );
      }
      if (!inspection.penaltyAmount || inspection.penaltyAmount <= 0n) {
        throw new ApiError(
          ErrorCode.BUSINESS_RULE_VIOLATION,
          'Inspeksi tidak memiliki denda yang bisa ditagihkan.',
        );
      }

      const existing = await tx.orderPenalty.findUnique({
        where: { tenantId_inspectionId: { tenantId, inspectionId: dto.inspectionId } },
      });
      if (existing) return this.mapPenalty(existing);

      // Batas akumulasi denda per order (opsional). Plafon per inspeksi sudah
      // diterapkan saat usulan dihitung; di sini dicek total tagihan aktif.
      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { damagePenaltyOrderMaxAmount: true },
      });
      const orderCap = tenant?.damagePenaltyOrderMaxAmount ?? null;
      if (orderCap != null) {
        const recorded = await tx.orderPenalty.aggregate({
          where: { tenantId, orderId, status: 'RECORDED' },
          _sum: { amount: true },
        });
        const total = (recorded._sum.amount ?? 0n) + inspection.penaltyAmount;
        if (total > orderCap) {
          throw new ApiError(
            ErrorCode.BUSINESS_RULE_VIOLATION,
            `Total denda order melebihi batas ${orderCap.toString()} yang diatur tenant.`,
          );
        }
      }

      const penalty = await tx.orderPenalty.create({
        data: {
          tenantId,
          orderId,
          inspectionId: dto.inspectionId,
          amount: inspection.penaltyAmount,
          currency: order.currency,
          reason: dto.reason.trim(),
          createdByUserId: ctx.actorUserId,
        },
      });

      await this.audit.record(
        {
          tenantId,
          actorUserId: ctx.actorUserId,
          action: 'ORDER_PENALTY_CREATED',
          domain: 'returns',
          entityType: 'order_penalty',
          entityId: penalty.id,
          toState: 'RECORDED',
          correlationId: ctx.correlationId,
          reason: penalty.reason,
          metadata: {
            orderId,
            inspectionId: dto.inspectionId,
            amount: penalty.amount.toString(),
          },
        },
        tx,
      );

      return this.mapPenalty(penalty);
    });
  }

  /**
   * Batalkan denda yang salah tagih tanpa menghapus baris.
   *
   * Baris berstatus VOIDED tetap tersimpan beserta aktor dan alasannya, tetapi
   * tidak lagi dihitung dalam `penaltyTotalAmount`/`amountDue`. Permintaan
   * kedua mengembalikan baris yang sama (idempoten) tanpa audit ganda.
   */
  async voidPenalty(
    tenantId: string,
    orderId: string,
    penaltyId: string,
    dto: VoidOrderPenaltyDto,
    ctx: Ctx,
  ) {
    await this.tenantService.requireMembership(tenantId, ctx.actorUserId, ['OWNER', 'MANAGER']);
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.requireOrder(tx, tenantId, orderId);
      const penalty = await tx.orderPenalty.findUnique({
        where: { tenantId_id: { tenantId, id: penaltyId } },
      });
      if (!penalty || penalty.orderId !== orderId) {
        throw new ApiError(ErrorCode.NOT_FOUND, 'Denda tidak ditemukan pada order ini.');
      }
      if (penalty.status === 'VOIDED') return this.mapPenalty(penalty);

      const voided = await tx.orderPenalty.update({
        where: { tenantId_id: { tenantId, id: penaltyId } },
        data: {
          status: 'VOIDED',
          voidedAt: new Date(),
          voidedByUserId: ctx.actorUserId,
          voidedReason: dto.reason.trim(),
        },
      });

      await this.audit.record(
        {
          tenantId,
          actorUserId: ctx.actorUserId,
          action: 'ORDER_PENALTY_VOIDED',
          domain: 'returns',
          entityType: 'order_penalty',
          entityId: penalty.id,
          fromState: 'RECORDED',
          toState: 'VOIDED',
          correlationId: ctx.correlationId,
          reason: voided.voidedReason ?? undefined,
          metadata: {
            orderId,
            inspectionId: penalty.inspectionId,
            amount: penalty.amount.toString(),
          },
        },
        tx,
      );

      return this.mapPenalty(voided);
    });
  }

  async requestDeduction(
    tenantId: string,
    orderId: string,
    dto: DepositDeductionDto,
    ctx: Ctx,
  ) {
    await this.tenantService.requirePermission(tenantId, ctx.actorUserId, 'deposit.deduct');
    const amount = this.parseAmount(dto.amount);
    const reason = dto.reason.trim();
    const conditionNotes = dto.conditionNotes?.trim() || null;
    const scope = 'deposit-deduction-request';

    return this.runIdempotent(
      tenantId,
      scope,
      ctx,
      {
        orderId,
        amount: amount.toString(),
        currency: dto.currency,
        reason,
        conditionNotes,
      },
      async (tx) => {
        const order = await this.requireOrder(tx, tenantId, orderId);
        this.assertDepositMovable(order.status);
        if (order.currency !== dto.currency) {
          throw new ApiError(
            ErrorCode.VALIDATION_ERROR,
            `Mata uang order adalah ${order.currency}.`,
          );
        }

        // Potongan yang berasal dari inspeksi kerusakan: nominal harus sama
        // dengan denda final, dan satu inspeksi hanya boleh memotong sekali.
        if (dto.inspectionId) {
          const inspection = await tx.inspection.findUnique({
            where: { tenantId_id: { tenantId, id: dto.inspectionId } },
          });
          if (!inspection || inspection.orderId !== orderId) {
            throw new ApiError(ErrorCode.NOT_FOUND, 'Inspeksi tidak ditemukan pada order ini.');
          }
          if (inspection.status !== 'APPROVED' || !inspection.penaltyAmount) {
            throw new ApiError(
              ErrorCode.INVALID_STATE_TRANSITION,
              'Potongan deposit dari inspeksi hanya dapat diajukan setelah denda diputuskan (APPROVED).',
            );
          }
          if (inspection.penaltyAmount !== amount) {
            throw new ApiError(
              ErrorCode.VALIDATION_ERROR,
              `Nominal potongan harus sama dengan denda inspeksi (${inspection.penaltyAmount.toString()} IDR).`,
            );
          }
          const alreadyRequested = await tx.depositDeductionRequest.findFirst({
            where: { tenantId, inspectionId: dto.inspectionId },
          });
          if (alreadyRequested) {
            throw new ApiError(
              ErrorCode.BUSINESS_RULE_VIOLATION,
              'Inspeksi ini sudah memiliki permintaan potongan deposit.',
            );
          }
        }

        const deposit = await this.ensureDeposit(tx, tenantId, orderId);
        await this.lockDeposit(tx, tenantId, orderId);
        const balance = await this.depositBalance(tx, tenantId, deposit.id);
        if (amount > balance) {
          throw new ApiError(
            ErrorCode.BUSINESS_RULE_VIOLATION,
            `Nominal potongan melebihi saldo deposit (${balance.toString()} IDR).`,
          );
        }

        const request = await tx.depositDeductionRequest.create({
          data: {
            tenantId,
            orderId,
            depositId: deposit.id,
            amount,
            currency: dto.currency,
            reason,
            conditionNotes,
            requestedByUserId: ctx.actorUserId,
            inspectionId: dto.inspectionId ?? null,
            idempotencyKey: ctx.idempotencyKey ?? null,
          },
        });

        await this.audit.record(
          {
            tenantId,
            actorUserId: ctx.actorUserId,
            action: 'DEPOSIT_DEDUCTION_REQUESTED',
            domain: 'deposit',
            entityType: 'deposit_deduction_request',
            entityId: request.id,
            toState: request.status,
            correlationId: ctx.correlationId,
            reason,
            metadata: {
              orderId,
              amount: amount.toString(),
              conditionNotes,
              inspectionId: dto.inspectionId ?? null,
            },
          },
          tx,
        );

        return this.mapDeductionRequest(request, balance);
      },
    );
  }

  async approveDeduction(
    tenantId: string,
    requestId: string,
    dto: DepositDecisionDto,
    ctx: Ctx,
  ) {
    await this.tenantService.requirePermission(
      tenantId,
      ctx.actorUserId,
      'deposit.deduct.approve',
    );
    const decisionReason = dto.reason?.trim() || null;
    const scope = 'deposit-deduction-approve';

    return this.runIdempotent(
      tenantId,
      scope,
      ctx,
      { requestId, decisionReason },
      async (tx) => {
        const head = await tx.depositDeductionRequest.findUnique({
          where: { tenantId_id: { tenantId, id: requestId } },
        });
        if (!head) throw new ApiError(ErrorCode.NOT_FOUND, 'Permintaan potongan tidak ditemukan.');
        await this.lockDeposit(tx, tenantId, head.orderId);
        await tx.$queryRaw`SELECT id FROM deposit_deduction_requests WHERE "tenantId" = ${tenantId} AND id = ${requestId} FOR UPDATE`;

        const request = await tx.depositDeductionRequest.findUnique({
          where: { tenantId_id: { tenantId, id: requestId } },
        });
        if (!request) throw new ApiError(ErrorCode.NOT_FOUND, 'Permintaan potongan tidak ditemukan.');
        if (request.status !== 'PENDING') {
          throw new ApiError(
            ErrorCode.INVALID_STATE_TRANSITION,
            `Permintaan potongan berstatus ${request.status} tidak dapat disetujui.`,
          );
        }
        if (request.requestedByUserId === ctx.actorUserId) {
          throw new ApiError(
            ErrorCode.PERMISSION_DENIED,
            'Penyetuju harus aktor berbeda dari pengaju (approval terpisah).',
          );
        }

        const balance = await this.depositBalance(tx, tenantId, request.depositId);
        if (request.amount > balance) {
          throw new ApiError(
            ErrorCode.BUSINESS_RULE_VIOLATION,
            `Saldo deposit tidak mencukupi (${balance.toString()} IDR).`,
          );
        }

        const movement = await tx.depositMovement.create({
          data: {
            tenantId,
            depositId: request.depositId,
            type: 'DEDUCTION',
            amount: request.amount,
            currency: request.currency,
            reason: request.reason,
            actorUserId: ctx.actorUserId,
            idempotencyKey: ctx.idempotencyKey ?? null,
          },
        });

        const updated = await tx.depositDeductionRequest.update({
          where: { tenantId_id: { tenantId, id: requestId } },
          data: {
            status: 'APPROVED',
            approvedByUserId: ctx.actorUserId,
            decisionReason,
            decidedAt: new Date(),
            movementId: movement.id,
          },
        });

        await this.audit.record(
          {
            tenantId,
            actorUserId: ctx.actorUserId,
            action: 'DEPOSIT_DEDUCTION_APPROVED',
            domain: 'deposit',
            entityType: 'deposit_deduction_request',
            entityId: requestId,
            fromState: request.status,
            toState: updated.status,
            reason: decisionReason ?? request.reason,
            correlationId: ctx.correlationId,
            metadata: {
              orderId: request.orderId,
              amount: request.amount.toString(),
              movementId: movement.id,
            },
          },
          tx,
        );

        const newBalance = balance - request.amount;
        return this.mapDeductionRequest(updated, newBalance);
      },
    );
  }

  async rejectDeduction(
    tenantId: string,
    requestId: string,
    dto: DepositDecisionDto,
    ctx: Ctx,
  ) {
    await this.tenantService.requirePermission(
      tenantId,
      ctx.actorUserId,
      'deposit.deduct.approve',
    );
    const decisionReason = dto.reason?.trim() || null;
    const scope = 'deposit-deduction-reject';

    return this.runIdempotent(
      tenantId,
      scope,
      ctx,
      { requestId, decisionReason },
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM deposit_deduction_requests WHERE "tenantId" = ${tenantId} AND id = ${requestId} FOR UPDATE`;
        const request = await tx.depositDeductionRequest.findUnique({
          where: { tenantId_id: { tenantId, id: requestId } },
        });
        if (!request) throw new ApiError(ErrorCode.NOT_FOUND, 'Permintaan potongan tidak ditemukan.');
        if (request.status !== 'PENDING') {
          throw new ApiError(
            ErrorCode.INVALID_STATE_TRANSITION,
            `Permintaan potongan berstatus ${request.status} tidak dapat ditolak.`,
          );
        }
        if (request.requestedByUserId === ctx.actorUserId) {
          throw new ApiError(
            ErrorCode.PERMISSION_DENIED,
            'Penyetuju harus aktor berbeda dari pengaju (approval terpisah).',
          );
        }

        const updated = await tx.depositDeductionRequest.update({
          where: { tenantId_id: { tenantId, id: requestId } },
          data: {
            status: 'REJECTED',
            approvedByUserId: ctx.actorUserId,
            decisionReason,
            decidedAt: new Date(),
          },
        });

        await this.audit.record(
          {
            tenantId,
            actorUserId: ctx.actorUserId,
            action: 'DEPOSIT_DEDUCTION_REJECTED',
            domain: 'deposit',
            entityType: 'deposit_deduction_request',
            entityId: requestId,
            fromState: request.status,
            toState: updated.status,
            reason: decisionReason ?? undefined,
            correlationId: ctx.correlationId,
            metadata: { orderId: request.orderId, amount: request.amount.toString() },
          },
          tx,
        );

        const balance = await this.depositBalance(tx, tenantId, request.depositId);
        return this.mapDeductionRequest(updated, balance);
      },
    );
  }

  async refundDeposit(
    tenantId: string,
    orderId: string,
    dto: DepositRefundDto,
    ctx: Ctx,
  ) {
    await this.tenantService.requirePermission(tenantId, ctx.actorUserId, 'deposit.refund');
    const amount = this.parseAmount(dto.amount);
    const reason = dto.reason.trim();
    const reference = dto.reference?.trim() || null;
    const scope = 'deposit-refund';

    return this.runIdempotent(
      tenantId,
      scope,
      ctx,
      { orderId, amount: amount.toString(), currency: dto.currency, reason, reference },
      async (tx) => {
        const order = await this.requireOrder(tx, tenantId, orderId);
        this.assertDepositMovable(order.status);
        if (order.currency !== dto.currency) {
          throw new ApiError(
            ErrorCode.VALIDATION_ERROR,
            `Mata uang order adalah ${order.currency}.`,
          );
        }
        const deposit = await this.ensureDeposit(tx, tenantId, orderId);
        await this.lockDeposit(tx, tenantId, orderId);
        const balance = await this.depositBalance(tx, tenantId, deposit.id);
        if (amount > balance) {
          throw new ApiError(
            ErrorCode.BUSINESS_RULE_VIOLATION,
            `Nominal refund melebihi saldo deposit (${balance.toString()} IDR).`,
          );
        }

        const movement = await tx.depositMovement.create({
          data: {
            tenantId,
            depositId: deposit.id,
            type: 'REFUND',
            amount,
            currency: dto.currency,
            reason,
            reference,
            actorUserId: ctx.actorUserId,
            idempotencyKey: ctx.idempotencyKey ?? null,
          },
        });

        await this.audit.record(
          {
            tenantId,
            actorUserId: ctx.actorUserId,
            action: 'DEPOSIT_REFUNDED',
            domain: 'deposit',
            entityType: 'deposit_movement',
            entityId: movement.id,
            toState: movement.type,
            reason,
            correlationId: ctx.correlationId,
            metadata: { orderId, amount: amount.toString(), reference },
          },
          tx,
        );

        return this.loadDeposit(tx, tenantId, orderId);
      },
    );
  }

  async reverseMovement(
    tenantId: string,
    orderId: string,
    movementId: string,
    dto: ReverseDepositMovementDto,
    ctx: Ctx,
  ) {
    await this.tenantService.requirePermission(
      tenantId,
      ctx.actorUserId,
      'deposit.deduct.approve',
    );
    const reason = dto.reason.trim();
    const scope = 'deposit-reversal';

    return this.runIdempotent(
      tenantId,
      scope,
      ctx,
      { orderId, movementId, reason },
      async (tx) => {
        const order = await this.requireOrder(tx, tenantId, orderId);
        this.assertDepositMovable(order.status);
        const deposit = await this.ensureDeposit(tx, tenantId, orderId);
        await this.lockDeposit(tx, tenantId, orderId);

        const original = await tx.depositMovement.findUnique({
          where: { tenantId_id: { tenantId, id: movementId } },
        });
        if (!original || original.depositId !== deposit.id) {
          throw new ApiError(ErrorCode.NOT_FOUND, 'Movement deposit tidak ditemukan.');
        }
        if (original.type === 'REVERSAL') {
          throw new ApiError(
            ErrorCode.BUSINESS_RULE_VIOLATION,
            'Movement REVERSAL tidak dapat dibalik lagi.',
          );
        }
        const already = await tx.depositMovement.findFirst({
          where: { tenantId, reversesId: movementId },
        });
        if (already) {
          throw new ApiError(
            ErrorCode.BUSINESS_RULE_VIOLATION,
            'Movement ini sudah pernah dibalik.',
          );
        }

        const movements = await tx.depositMovement.findMany({
          where: { tenantId, depositId: deposit.id },
        });
        const balance = this.computeBalance(movements);
        const signed = this.signedAmount(original, movements);
        const newBalance = balance - signed;
        if (newBalance < 0n) {
          throw new ApiError(
            ErrorCode.BUSINESS_RULE_VIOLATION,
            'Reversal akan membuat saldo deposit negatif.',
          );
        }

        await tx.depositMovement.create({
          data: {
            tenantId,
            depositId: deposit.id,
            type: 'REVERSAL',
            amount: original.amount,
            currency: original.currency,
            reason,
            reversesId: original.id,
            actorUserId: ctx.actorUserId,
            idempotencyKey: ctx.idempotencyKey ?? null,
          },
        });

        await this.audit.record(
          {
            tenantId,
            actorUserId: ctx.actorUserId,
            action: 'DEPOSIT_MOVEMENT_REVERSED',
            domain: 'deposit',
            entityType: 'deposit_movement',
            entityId: original.id,
            fromState: original.type,
            toState: 'REVERSAL',
            reason,
            correlationId: ctx.correlationId,
            metadata: {
              orderId,
              amount: original.amount.toString(),
              balanceAfter: newBalance.toString(),
            },
          },
          tx,
        );

        return this.loadDeposit(tx, tenantId, orderId);
      },
    );
  }

  // ============================================================
  // Jaminan (collateral) — non-uang; uang tetap di ledger deposit
  // ============================================================

  /** GET /orders/:id/collaterals — daftar jaminan (ID card utama + lainnya). */
  async listCollaterals(tenantId: string, orderId: string, actorUserId: string) {
    await this.tenantService.requirePermission(tenantId, actorUserId, 'deposit.read');
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.requireOrder(tx, tenantId, orderId);
      const rows = await tx.collateral.findMany({
        where: { tenantId, orderId },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map((row) => this.mapCollateral(row));
    });
  }

  /**
   * POST /orders/:id/collaterals — catat jaminan baru (HELD).
   *
   * Aturan:
   * - ID_CARD bersifat utama: maksimal satu yang sedang HELD per order. Bila
   *   sudah ada ID card HELD, server menolak (409) — kembalikan dulu yang lama.
   * - OTHER opsional dan bebas jumlah.
   * - Jaminan uang TIDAK lewat sini; uang memakai ledger deposit.
   */
  async createCollateral(
    tenantId: string,
    orderId: string,
    dto: CreateCollateralDto,
    ctx: Ctx,
  ) {
    await this.tenantService.requirePermission(tenantId, ctx.actorUserId, 'deposit.receive');
    const label = this.collateralLabel(dto);
    const scope = 'collateral-create';

    return this.runIdempotent(
      tenantId,
      scope,
      ctx,
      {
        orderId,
        type: dto.type,
        label,
        documentNumber: dto.documentNumber?.trim() || null,
        description: dto.description?.trim() || null,
        notes: dto.notes?.trim() || null,
      },
      async (tx) => {
        const order = await this.requireOrder(tx, tenantId, orderId);
        this.assertCollateralMovable(order.status);

        if (dto.type === 'ID_CARD') {
          const held = await tx.collateral.findFirst({
            where: { tenantId, orderId, type: 'ID_CARD', status: 'HELD' },
          });
          if (held) {
            throw new ApiError(
              ErrorCode.BUSINESS_RULE_VIOLATION,
              'Order ini sudah memiliki ID card yang sedang dipegang. Kembalikan dulu sebelum mencatat ID card baru.',
            );
          }
        }

        const row = await tx.collateral.create({
          data: {
            tenantId,
            orderId,
            type: dto.type,
            status: 'HELD',
            label,
            documentNumber: dto.documentNumber?.trim() || null,
            description: dto.description?.trim() || null,
            notes: dto.notes?.trim() || null,
            actorUserId: ctx.actorUserId,
          },
        });

        await this.audit.record(
          {
            tenantId,
            actorUserId: ctx.actorUserId,
            action: 'COLLATERAL_HELD',
            domain: 'order',
            entityType: 'collateral',
            entityId: row.id,
            toState: row.status,
            correlationId: ctx.correlationId,
            metadata: { orderId, type: row.type, label: row.label },
          },
          tx,
        );

        return this.mapCollateral(row);
      },
    );
  }

  /**
   * POST /collaterals/:id/return — tandai jaminan sudah dikembalikan
   * (HELD → RETURNED). Baris tidak dihapus; riwayat tetap utuh.
   */
  async returnCollateral(
    tenantId: string,
    collateralId: string,
    dto: ReturnCollateralDto,
    ctx: Ctx,
  ) {
    await this.tenantService.requirePermission(tenantId, ctx.actorUserId, 'deposit.receive');
    const notes = dto.notes?.trim() || null;
    const scope = 'collateral-return';

    return this.runIdempotent(
      tenantId,
      scope,
      ctx,
      { collateralId, notes },
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM collaterals WHERE "tenantId" = ${tenantId} AND id = ${collateralId} FOR UPDATE`;
        const row = await tx.collateral.findUnique({
          where: { tenantId_id: { tenantId, id: collateralId } },
        });
        if (!row) throw new ApiError(ErrorCode.NOT_FOUND, 'Jaminan tidak ditemukan.');
        const order = await this.requireOrder(tx, tenantId, row.orderId);
        this.assertCollateralMovable(order.status);
        if (row.status !== 'HELD') {
          throw new ApiError(
            ErrorCode.INVALID_STATE_TRANSITION,
            `Jaminan berstatus ${row.status} tidak dapat dikembalikan.`,
          );
        }

        const updated = await tx.collateral.update({
          where: { tenantId_id: { tenantId, id: collateralId } },
          data: {
            status: 'RETURNED',
            returnedAt: new Date(),
            notes: notes ?? row.notes,
            actorUserId: ctx.actorUserId,
          },
        });

        await this.audit.record(
          {
            tenantId,
            actorUserId: ctx.actorUserId,
            action: 'COLLATERAL_RETURNED',
            domain: 'order',
            entityType: 'collateral',
            entityId: row.id,
            fromState: row.status,
            toState: updated.status,
            reason: notes ?? undefined,
            correlationId: ctx.correlationId,
            metadata: { orderId: row.orderId, type: row.type, label: row.label },
          },
          tx,
        );

        return this.mapCollateral(updated);
      },
    );
  }

  // ============================================================
  // Helpers
  // ============================================================

  private newOrderNumber(): string {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return `ORD-${day}-${randomBytes(4).toString('hex').toUpperCase()}`;
  }

  private parseAmount(value: string): bigint {
    if (!/^[1-9][0-9]{0,15}$/.test(value)) {
      throw new ApiError(
        ErrorCode.VALIDATION_ERROR,
        'amount harus integer rupiah utuh > 0 sebagai string.',
      );
    }
    return BigInt(value);
  }

  private assertDepositMovable(status: string): void {
    if (!['CONFIRMED', 'READY_FOR_HANDOVER', 'ACTIVE', 'RETURN_IN_PROGRESS'].includes(status)) {
      throw new ApiError(
        ErrorCode.INVALID_STATE_TRANSITION,
        `Deposit tidak dapat diubah pada order berstatus ${status}.`,
      );
    }
  }

  /** Jaminan hanya boleh berubah selama order masih dalam alur sewa aktif. */
  private assertCollateralMovable(status: string): void {
    if (!['CONFIRMED', 'READY_FOR_HANDOVER', 'ACTIVE', 'RETURN_IN_PROGRESS'].includes(status)) {
      throw new ApiError(
        ErrorCode.INVALID_STATE_TRANSITION,
        `Jaminan tidak dapat diubah pada order berstatus ${status}.`,
      );
    }
  }

  /** Label default untuk ID_CARD bila staf tidak mengisi; OTHER wajib label. */
  private collateralLabel(dto: CreateCollateralDto): string {
    const label = dto.label?.trim() || '';
    if (dto.type === 'ID_CARD') return label || 'KTP';
    if (!label) {
      throw new ApiError(
        ErrorCode.VALIDATION_ERROR,
        'Label jaminan (OTHER) wajib diisi — sebutkan nama barang/dokumen.',
      );
    }
    return label;
  }

  private async requireOrder(
    tx: Prisma.TransactionClient,
    tenantId: string,
    orderId: string,
  ) {
    const order = await tx.rentalOrder.findUnique({
      where: { tenantId_id: { tenantId, id: orderId } },
    });
    if (!order) throw new ApiError(ErrorCode.NOT_FOUND, 'Order tidak ditemukan.');
    return order;
  }

  private async loadOrder(
    tx: Prisma.TransactionClient,
    tenantId: string,
    orderId: string,
  ) {
    const row = await tx.rentalOrder.findUnique({
      where: { tenantId_id: { tenantId, id: orderId } },
      include: ORDER_INCLUDE,
    });
    if (!row) throw new ApiError(ErrorCode.NOT_FOUND, 'Order tidak ditemukan.');
    return this.mapOrder(row);
  }

  private async ensureDeposit(
    tx: Prisma.TransactionClient,
    tenantId: string,
    orderId: string,
  ) {
    const existing = await tx.deposit.findUnique({
      where: { tenantId_orderId: { tenantId, orderId } },
    });
    if (existing) return existing;
    return tx.deposit.create({
      data: { tenantId, orderId, currency: 'IDR' },
    });
  }

  private async lockDeposit(
    tx: Prisma.TransactionClient,
    tenantId: string,
    orderId: string,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM deposits WHERE "tenantId" = ${tenantId} AND "orderId" = ${orderId} FOR UPDATE`;
  }

  private async loadDeposit(
    tx: Prisma.TransactionClient,
    tenantId: string,
    orderId: string,
  ) {
    const deposit = await this.ensureDeposit(tx, tenantId, orderId);
    const row = await tx.deposit.findUniqueOrThrow({
      where: { tenantId_id: { tenantId, id: deposit.id } },
      include: DEPOSIT_INCLUDE,
    });
    return this.mapDeposit(row);
  }

  private async depositBalance(
    tx: Prisma.TransactionClient,
    tenantId: string,
    depositId: string,
  ): Promise<bigint> {
    const movements = await tx.depositMovement.findMany({
      where: { tenantId, depositId },
    });
    return this.computeBalance(movements);
  }

  /** Saldo = Σ signed(type); REVERSAL membalik arah movement asal. */
  private computeBalance(movements: MovementRow[]): bigint {
    return movements.reduce((sum, movement) => sum + this.signedAmount(movement, movements), 0n);
  }

  private signedAmount(movement: MovementRow, all: MovementRow[]): bigint {
    switch (movement.type) {
      case 'RECEIPT':
        return movement.amount;
      case 'DEDUCTION':
      case 'REFUND':
        return -movement.amount;
      case 'REVERSAL': {
        const original = all.find((m) => m.id === movement.reversesId);
        if (!original) return 0n;
        const originalSigned = this.signedAmount(original, all);
        return -originalSigned;
      }
      default:
        return 0n;
    }
  }

  private async refundTotals(
    tx: Prisma.TransactionClient,
    tenantId: string,
    paymentId: string,
    paymentAmount: bigint,
  ) {
    const rows = await tx.refund.findMany({ where: { tenantId, paymentId } });
    return this.refundTotalsFromRows(rows, paymentAmount);
  }

  /**
   * `reservedAmount` mencakup semua refund yang belum rilis (REQUESTED,
   * APPROVED, PROCESSING, SUCCEEDED). Hanya FAILED/CANCELLED yang melepas
   * kembali nilai refundable. Pemanggil wajib memegang lock baris payment.
   */
  private refundTotalsFromRows(rows: RefundRow[], paymentAmount: bigint) {
    let reservedAmount = 0n;
    let refundedAmount = 0n;
    for (const row of rows) {
      if ((REFUND_RESERVING_STATUSES as readonly string[]).includes(row.status)) {
        reservedAmount += row.amount;
      }
      if (row.status === 'SUCCEEDED') refundedAmount += row.amount;
    }
    return {
      reservedAmount,
      refundedAmount,
      refundableAmount: paymentAmount > reservedAmount ? paymentAmount - reservedAmount : 0n,
    };
  }

  private async paymentWithTotals(
    tx: Prisma.TransactionClient,
    tenantId: string,
    orderId: string,
    payment: PaymentRow,
  ) {
    const order = await tx.rentalOrder.findUniqueOrThrow({
      where: { tenantId_id: { tenantId, id: orderId } },
    });
    const paid = await tx.payment.aggregate({
      where: { tenantId, orderId, status: 'RECORDED' },
      _sum: { amount: true },
    });
    return {
      ...this.mapPayment(payment),
      orderTotals: {
        totalAmount: order.totalAmount.toString(),
        paidAmount: (paid._sum.amount ?? 0n).toString(),
        outstandingAmount: (order.totalAmount - (paid._sum.amount ?? 0n)).toString(),
      },
    };
  }

  private mapOrder(row: OrderRow) {
    const deposit = row.deposits[0] ?? null;
    const paid = row.payments
      .filter((payment) => payment.status === 'RECORDED')
      .reduce((sum, payment) => sum + payment.amount, 0n);
    // Denda kerusakan adalah tagihan terpisah dari harga sewa: totalAmount
    // tetap nilai sewa, sementara amountDue menjumlahkan keduanya. Denda
    // VOIDED tetap tampil di riwayat tetapi tidak menambah tagihan.
    const penaltyTotal = row.penalties
      .filter((penalty) => penalty.status === 'RECORDED')
      .reduce((sum, penalty) => sum + penalty.amount, 0n);
    return {
      id: row.id,
      orderNumber: row.orderNumber,
      status: row.status,
      currency: row.currency,
      totalAmount: row.totalAmount.toString(),
      paidAmount: paid.toString(),
      outstandingAmount: (row.totalAmount - paid).toString(),
      penaltyTotalAmount: penaltyTotal.toString(),
      amountDue: (row.totalAmount + penaltyTotal - paid).toString(),
      penalties: row.penalties.map((penalty) => this.mapPenalty(penalty)),
      sourceReservationId: row.sourceReservationId,
      customerId: row.customerId,
      hasOpenConflict: row.hasOpenConflict,
      items: row.items.map((item) => ({
        id: item.id,
        productId: item.productId,
        assetId: item.assetId,
        quantity: item.quantity,
        startAt: item.startAt,
        endAt: item.endAt,
        priceSnapshot: item.priceSnapshot.toString(),
        currency: item.currency,
      })),
      payments: row.payments.map((payment) => this.mapPayment(payment)),
      deposit: deposit ? this.mapDeposit(deposit) : null,
      collaterals: row.collaterals.map((collateral) => this.mapCollateral(collateral)),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private mapPayment(payment: PaymentRow) {
    return {
      id: payment.id,
      orderId: payment.orderId,
      amount: payment.amount.toString(),
      currency: payment.currency,
      method: payment.method,
      context: payment.context,
      status: payment.status,
      reference: payment.reference,
      voidReason: payment.voidReason,
      voidedByUserId: payment.voidedByUserId,
      voidedAt: payment.voidedAt,
      recordedAt: payment.recordedAt,
      createdAt: payment.createdAt,
    };
  }

  private mapCollateral(row: CollateralRow) {
    return {
      id: row.id,
      orderId: row.orderId,
      type: row.type,
      status: row.status,
      label: row.label,
      documentNumber: row.documentNumber,
      description: row.description,
      notes: row.notes,
      heldAt: row.heldAt,
      returnedAt: row.returnedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private mapDeposit(row: DepositRow) {
    const balance = this.computeBalance(row.movements);
    return {
      id: row.id,
      orderId: row.orderId,
      currency: row.currency,
      balance: balance.toString(),
      movements: row.movements.map((movement) => ({
        id: movement.id,
        type: movement.type,
        amount: movement.amount.toString(),
        currency: movement.currency,
        reason: movement.reason,
        method: movement.method,
        reference: movement.reference,
        reversesId: movement.reversesId,
        actorUserId: movement.actorUserId,
        createdAt: movement.createdAt,
      })),
      deductionRequests: row.deductionRequests.map((request) =>
        this.mapDeductionRequest(request, balance),
      ),
      createdAt: row.createdAt,
    };
  }

  private mapRefund(refund: RefundRow, refundableAmount: bigint, refundedAmount: bigint) {
    return {
      id: refund.id,
      orderId: refund.orderId,
      paymentId: refund.paymentId,
      amount: refund.amount.toString(),
      currency: refund.currency,
      status: refund.status,
      reason: refund.reason,
      reference: refund.reference,
      requestedByUserId: refund.requestedByUserId,
      approvedByUserId: refund.approvedByUserId,
      decisionReason: refund.decisionReason,
      processedByUserId: refund.processedByUserId,
      resultNote: refund.resultNote,
      requestedAt: refund.requestedAt,
      processedAt: refund.processedAt,
      refundableAmount: refundableAmount.toString(),
      refundedAmount: refundedAmount.toString(),
      createdAt: refund.createdAt,
      updatedAt: refund.updatedAt,
    };
  }

  private mapPenalty(penalty: PenaltyRow) {
    return {
      id: penalty.id,
      orderId: penalty.orderId,
      inspectionId: penalty.inspectionId,
      amount: penalty.amount.toString(),
      currency: penalty.currency,
      reason: penalty.reason,
      status: penalty.status,
      voidedAt: penalty.voidedAt,
      voidedReason: penalty.voidedReason,
      createdByUserId: penalty.createdByUserId,
      createdAt: penalty.createdAt,
    };
  }

  private mapDeductionRequest(request: DeductionRow, depositBalance: bigint) {
    return {
      id: request.id,
      orderId: request.orderId,
      depositId: request.depositId,
      amount: request.amount.toString(),
      currency: request.currency,
      status: request.status,
      reason: request.reason,
      conditionNotes: request.conditionNotes,
      requestedByUserId: request.requestedByUserId,
      approvedByUserId: request.approvedByUserId,
      decisionReason: request.decisionReason,
      decidedAt: request.decidedAt,
      inspectionId: request.inspectionId,
      movementId: request.movementId,
      depositBalance: depositBalance.toString(),
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
    };
  }

  /**
   * Jalankan command dalam transaksi tenant, dan bila Idempotency-Key diisi
   * simpan hasilnya. Retry dengan key & payload sama mengembalikan hasil lama;
   * payload berbeda → 409 IDEMPOTENCY_KEY_REUSED.
   */
  private async runIdempotent<T>(
    tenantId: string,
    scope: string,
    ctx: Ctx,
    payload: Record<string, unknown>,
    produce: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const key = ctx.idempotencyKey;
    if (!key) {
      return this.prisma.withTenant(tenantId, produce);
    }
    const fingerprint = hashToken(JSON.stringify({ op: scope, tenantId, ...payload }));

    try {
      return await this.prisma.withTenant(tenantId, async (tx) => {
        // Replay diperiksa SEBELUM command dijalankan: retry setelah command
        // berhasil tidak boleh gagal karena precondition state sudah berubah.
        const existing = await tx.idempotencyRecord.findUnique({
          where: { tenantId_scope_key: { tenantId, scope, key } },
        });
        if (existing) {
          return this.replayRecord(existing, fingerprint);
        }

        const result = await produce(tx);
        await tx.idempotencyRecord.create({
          data: {
            tenantId,
            scope,
            key,
            requestFingerprint: fingerprint,
            state: 'COMPLETED',
            responseStatus: 200,
            responseBody: JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue,
            expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
          },
        });
        return result;
      });
    } catch (err) {
      if (!isIdempotencyConflict(err)) throw err;
      return this.prisma.withTenant(tenantId, async (tx) => {
        const record = await tx.idempotencyRecord.findUnique({
          where: { tenantId_scope_key: { tenantId, scope, key } },
        });
        if (!record) throw err;
        return this.replayRecord(record, fingerprint);
      });
    }
  }

  private replayRecord<T>(
    record: Prisma.IdempotencyRecordGetPayload<Record<string, never>>,
    fingerprint: string,
  ): T {
    if (record.requestFingerprint !== fingerprint) {
      throw new ApiError(
        ErrorCode.IDEMPOTENCY_KEY_REUSED,
        'Idempotency-Key sudah dipakai untuk permintaan yang berbeda.',
      );
    }
    if (record.state !== 'COMPLETED' || record.responseBody == null) {
      throw new ApiError(
        ErrorCode.IDEMPOTENCY_KEY_REUSED,
        'Permintaan dengan Idempotency-Key yang sama masih diproses.',
      );
    }
    return record.responseBody as T;
  }
}
