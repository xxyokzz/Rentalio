import { Injectable } from '@nestjs/common';
import type {
  PaymentContext,
  PaymentMethod,
  Prisma,
  WhatsAppTemplatePurpose,
} from '@rentalio/database';
import { PrismaService } from '../prisma/prisma.service.js';
import { ApiError, ErrorCode } from '../common/errors.js';
import { TEMPLATE_METHODS } from './whatsapp-templates.defaults.js';

type TemplateRow = Prisma.WhatsAppTemplateGetPayload<Record<string, never>>;
type SnapshotRow = Prisma.TransactionMessageSnapshotGetPayload<Record<string, never>>;

export interface WhatsAppMessageView {
  id: string;
  orderId: string;
  paymentId: string | null;
  templateId: string | null;
  templateVersion: number | null;
  context: PaymentContext;
  paymentMethod: PaymentMethod;
  purpose: WhatsAppTemplatePurpose;
  templateName: string | null;
  body: string;
  createdAt: Date;
}

interface OrderContext {
  orderId: string;
  orderNumber: string;
  tenantName: string;
  timezone: string;
  customerName: string;
  itemsLabel: string;
  periodLabel: string;
  totalAmount: bigint;
}

const JENIS_TRANSAKSI: Record<PaymentContext, string> = {
  NEW_BOOKING: 'booking baru',
  ADD_UNIT: 'tambah unit',
  EXTENSION: 'perpanjangan sewa',
};

const PAYMENT_PURPOSE_ORDER: WhatsAppTemplatePurpose[] = [
  'PAYMENT_CONFIRMATION',
  'PAYMENT_INSTRUCTION',
];

const BOOKING_PURPOSE_ORDER: WhatsAppTemplatePurpose[] = [
  'PAYMENT_INSTRUCTION',
  'PAYMENT_CONFIRMATION',
];

/**
 * Merender template WhatsApp aktif menjadi pesan transaksi dan menyimpan
 * snapshot immutable (body ter-render + versi template).
 *
 * - Dipanggil DI DALAM transaksi domain (`Prisma.TransactionClient`) agar
 *   snapshot dan perubahan order/payment commit bersama.
 * - Template nonaktif tidak pernah dipakai; bila tidak ada template aktif,
 *   hasilnya `null`/array kosong, bukan pesan setengah jadi.
 * - Placeholder selalu terisi nilai nyata (bukan `undefined`).
 */
@Injectable()
export class WhatsAppMessagesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Pesan instruksi pembayaran untuk booking/order baru: satu pesan per
   * metode pembayaran yang aktif pada konteks NEW_BOOKING dan memiliki
   * template aktif. Tujuan diutamakan PAYMENT_INSTRUCTION.
   */
  async createBookingMessages(
    tx: Prisma.TransactionClient,
    tenantId: string,
    orderId: string,
  ): Promise<WhatsAppMessageView[]> {
    const context: PaymentContext = 'NEW_BOOKING';
    const ctx = await this.loadOrderContext(tx, tenantId, orderId);
    const methods = await this.enabledMethods(tx, tenantId, context);
    if (methods.length === 0) return [];

    const templates = await tx.whatsAppTemplate.findMany({
      where: {
        tenantId,
        context,
        paymentMethod: { in: methods },
        isActive: true,
      },
    });
    const byMethod = new Map<PaymentMethod, TemplateRow>();
    for (const method of methods) {
      const candidates = templates.filter((row) => row.paymentMethod === method);
      const chosen =
        BOOKING_PURPOSE_ORDER.map((purpose) =>
          candidates.find((row) => row.purpose === purpose),
        ).find((row): row is TemplateRow => Boolean(row)) ?? null;
      if (chosen) byMethod.set(method, chosen);
    }

    const result: WhatsAppMessageView[] = [];
    for (const method of TEMPLATE_METHODS) {
      const template = byMethod.get(method);
      if (!template) continue;
      result.push(
        await this.persistSnapshot(tx, {
          tenantId,
          orderId,
          paymentId: null,
          template,
          context,
          values: this.buildValues(ctx, context),
          renderedAt: new Date(),
        }),
      );
    }
    return result;
  }

  /**
   * Pesan konfirmasi untuk payment yang baru dicatat. Bila template
   * PAYMENT_CONFIRMATION tidak aktif, template PAYMENT_INSTRUCTION aktif
   * dipakai sebagai fallback dan tujuannya ikut tersimpan di snapshot.
   */
  async createPaymentMessage(
    tx: Prisma.TransactionClient,
    tenantId: string,
    payment: {
      id: string;
      orderId: string;
      amount: bigint;
      method: PaymentMethod;
      context: PaymentContext;
      recordedAt: Date;
    },
  ): Promise<WhatsAppMessageView | null> {
    const ctx = await this.loadOrderContext(tx, tenantId, payment.orderId);
    const templates = await tx.whatsAppTemplate.findMany({
      where: {
        tenantId,
        context: payment.context,
        paymentMethod: payment.method,
        isActive: true,
      },
    });
    if (templates.length === 0) return null;
    const template =
      PAYMENT_PURPOSE_ORDER.map((purpose) =>
        templates.find((row) => row.purpose === purpose),
      ).find((row): row is TemplateRow => Boolean(row)) ?? null;
    if (!template) return null;

    return this.persistSnapshot(tx, {
      tenantId,
      orderId: payment.orderId,
      paymentId: payment.id,
      template,
      context: payment.context,
      values: this.buildValues(ctx, payment.context, {
        amount: payment.amount,
        paidAt: payment.recordedAt,
      }),
      renderedAt: new Date(),
    });
  }

  /** Histori snapshot pesan untuk satu order, terbaru lebih dulu. */
  async listSnapshots(
    tx: Prisma.TransactionClient,
    tenantId: string,
    orderId: string,
  ): Promise<WhatsAppMessageView[]> {
    const rows = await tx.transactionMessageSnapshot.findMany({
      where: { tenantId, orderId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return rows.map((row) => this.mapSnapshot(row));
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private async persistSnapshot(
    tx: Prisma.TransactionClient,
    input: {
      tenantId: string;
      orderId: string;
      paymentId: string | null;
      template: TemplateRow;
      context: PaymentContext;
      values: Record<string, string>;
      renderedAt: Date;
    },
  ): Promise<WhatsAppMessageView> {
    const body = this.render(input.template.body, input.values);
    const row = await tx.transactionMessageSnapshot.create({
      data: {
        tenantId: input.tenantId,
        orderId: input.orderId,
        paymentId: input.paymentId,
        templateId: input.template.id,
        templateVersion: input.template.currentVersion,
        context: input.context,
        paymentMethod: input.template.paymentMethod,
        purpose: input.template.purpose,
        templateName: input.template.name,
        bodySnapshot: body,
        variables: input.values as Prisma.InputJsonValue,
        createdAt: input.renderedAt,
      },
    });
    return this.mapSnapshot(row);
  }

  /** Ganti placeholder resmi; placeholder tanpa nilai menjadi string kosong. */
  private render(body: string, values: Record<string, string>): string {
    return body
      .replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => values[key] ?? '')
      .trim();
  }

  private buildValues(
    ctx: OrderContext,
    context: PaymentContext,
    override: { amount?: bigint; paidAt?: Date } = {},
  ): Record<string, string> {
    const paidAt = override.paidAt ?? new Date();
    return {
      nama_bisnis: ctx.tenantName,
      nama_penyewa: ctx.customerName,
      nomor_pesanan: ctx.orderNumber,
      daftar_barang: ctx.itemsLabel,
      periode: ctx.periodLabel,
      nominal_tagihan: this.formatRupiah(override.amount ?? ctx.totalAmount),
      jenis_transaksi: JENIS_TRANSAKSI[context],
      waktu_pembayaran: this.formatDateTime(paidAt, ctx.timezone),
    };
  }

  private async loadOrderContext(
    tx: Prisma.TransactionClient,
    tenantId: string,
    orderId: string,
  ): Promise<OrderContext> {
    const order = await tx.rentalOrder.findUnique({
      where: { tenantId_id: { tenantId, id: orderId } },
      include: { items: true },
    });
    if (!order) throw new ApiError(ErrorCode.NOT_FOUND, 'Order tidak ditemukan.');

    const [tenant, customer] = await Promise.all([
      tx.tenant.findUnique({ where: { id: tenantId } }),
      order.customerId
        ? tx.customer.findUnique({
            where: { tenantId_id: { tenantId, id: order.customerId } },
          })
        : Promise.resolve(null),
    ]);
    if (!tenant) throw new ApiError(ErrorCode.NOT_FOUND, 'Tenant tidak ditemukan.');

    const productIds = [...new Set(order.items.map((item) => item.productId))];
    const products = productIds.length
      ? await tx.product.findMany({
          where: { tenantId, id: { in: productIds } },
          select: { id: true, name: true },
        })
      : [];
    const nameById = new Map(products.map((product) => [product.id, product.name]));

    const itemsLabel =
      order.items
        .map((item) => `${nameById.get(item.productId) ?? 'Item sewa'} ×${item.quantity}`)
        .join(', ') || '-';
    const startAt = order.items.reduce<Date | null>(
      (min, item) => (!min || item.startAt < min ? item.startAt : min),
      null,
    );
    const endAt = order.items.reduce<Date | null>(
      (max, item) => (!max || item.endAt > max ? item.endAt : max),
      null,
    );
    const periodLabel =
      startAt && endAt
        ? `${this.formatDate(startAt, tenant.timezone)} – ${this.formatDate(
            endAt,
            tenant.timezone,
          )}`
        : '-';

    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      tenantName: tenant.name,
      timezone: tenant.timezone,
      customerName: customer?.name ?? 'Penyewa',
      itemsLabel,
      periodLabel,
      totalAmount: order.totalAmount,
    };
  }

  /** Baris matriks yang tidak ada berarti aktif (aturan PaymentSettings). */
  private async enabledMethods(
    tx: Prisma.TransactionClient,
    tenantId: string,
    context: PaymentContext,
  ): Promise<PaymentMethod[]> {
    const rows = await tx.tenantPaymentMethodSetting.findMany({
      where: { tenantId, context },
    });
    const disabled = new Set(
      rows.filter((row) => !row.enabled).map((row) => row.method),
    );
    return TEMPLATE_METHODS.filter((method) => !disabled.has(method));
  }

  private mapSnapshot(row: SnapshotRow): WhatsAppMessageView {
    return {
      id: row.id,
      orderId: row.orderId,
      paymentId: row.paymentId,
      templateId: row.templateId,
      templateVersion: row.templateVersion,
      context: row.context,
      paymentMethod: row.paymentMethod,
      purpose: row.purpose,
      templateName: row.templateName,
      body: row.bodySnapshot,
      createdAt: row.createdAt,
    };
  }

  private formatRupiah(amount: bigint): string {
    return `Rp${amount.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
  }

  private formatDate(value: Date, timeZone: string): string {
    return this.dateFormatter(timeZone, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(value);
  }

  private formatDateTime(value: Date, timeZone: string): string {
    return this.dateFormatter(timeZone, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(value);
  }

  private dateFormatter(
    timeZone: string,
    options: Intl.DateTimeFormatOptions,
  ): Intl.DateTimeFormat {
    try {
      return new Intl.DateTimeFormat('id-ID', { ...options, timeZone });
    } catch {
      // timezone tidak valid di data lama: tetap hasilkan tanggal, bukan error.
      return new Intl.DateTimeFormat('id-ID', options);
    }
  }
}
