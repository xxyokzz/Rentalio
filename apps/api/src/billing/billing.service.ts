import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { SubscriptionInvoiceStatus } from '@rentalio/database';
import QRCode from 'qrcode';
import type { AppConfig } from '../config/env.validation.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { TenantService } from '../tenant/tenant.service.js';
import { ApiError, ErrorCode } from '../common/errors.js';
import { QrisService } from './qris.service.js';
import { BillingSettlementService, type SubscriptionInvoiceRow } from './billing-settlement.service.js';

/**
 * Billing langganan platform: tenant membayar Rentalio lewat QRIS dinamis.
 *
 * Alur sengaja satu arah dan dapat diaudit:
 *   1. `POST /tenants/:id/subscription-invoices` membuat baris PENDING lebih
 *      dulu, mengubah QRIS statis platform menjadi QRIS dinamis bernominal, lalu
 *      menyimpan payload-nya. Baris PENDING berfungsi sebagai kunci (partial
 *      unique index) sehingga klik ganda tidak membuat dua tagihan.
 *   2. Pembayaran dilakukan dengan memindai QR tersebut. QRIS tidak punya
 *      callback, jadi status **tidak** berubah sendiri.
 *   3. Operator platform menandai lunas dari Admin Platform
 *      (`platform.subscriptions.settle`) setelah dana terverifikasi. Jalur itu
 *      memperpanjang langganan satu kali lewat `BillingSettlementService`.
 *
 * Harga bukan hard-code: `SUBSCRIPTION_PRICE_AMOUNT` adalah konfigurasi
 * deployment (keputusan komersial pemilik produk). Bila belum diatur, endpoint
 * menolak dengan pesan operasional alih-alih membuat tagihan Rp0.
 */

const MANAGE_PERMISSION = 'settings.subscription.manage';
const HISTORY_LIMIT = 10;
const PROVIDER = 'qris';

export interface SubscriptionInvoiceView {
  id: string;
  status: SubscriptionInvoiceStatus;
  provider: string;
  /** Integer IDR utuh sebagai string (kontrak uang API memakai string). */
  amount: string;
  currency: string;
  /** String QRIS dinamis (nominal tertanam) untuk ditampilkan/disalin. */
  qrPayload: string | null;
  /** Gambar QR (data URL PNG); diisi saat tagihan PENDING ditampilkan. */
  qrImageDataUrl: string | null;
  expiresAt: string;
  paidAt: string | null;
  paidAmount: string | null;
  paymentMethod: string | null;
  paymentChannel: string | null;
  createdAt: string;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tenantService: TenantService,
    private readonly qris: QrisService,
    private readonly settlement: BillingSettlementService,
    @Inject('APP_CONFIG') private readonly config: AppConfig,
  ) {}

  /** Riwayat tagihan terbaru; dipakai UI untuk menampilkan tagihan menunggu. */
  async listInvoices(tenantId: string, actorUserId: string): Promise<SubscriptionInvoiceView[]> {
    await this.tenantService.requirePermission(tenantId, actorUserId, MANAGE_PERMISSION);
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.subscriptionInvoice.findMany({
        where: { tenantId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: HISTORY_LIMIT,
      }),
    );
    return Promise.all(rows.map((row) => this.toView(row)));
  }

  /** Buat (atau pakai ulang) tagihan QRIS yang masih menunggu pembayaran. */
  async createInvoice(
    tenantId: string,
    actorUserId: string,
    ctx: { correlationId: string },
  ): Promise<SubscriptionInvoiceView> {
    await this.tenantService.requirePermission(tenantId, actorUserId, MANAGE_PERMISSION);

    if (!this.qris.configured) {
      throw new ApiError(
        ErrorCode.BILLING_NOT_CONFIGURED,
        'Pembayaran QRIS belum diaktifkan. Hubungi tim Rentalio.',
      );
    }
    const amount = this.config.SUBSCRIPTION_PRICE_AMOUNT;
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new ApiError(
        ErrorCode.BILLING_NOT_CONFIGURED,
        'Harga langganan belum diatur. Hubungi tim Rentalio.',
      );
    }

    const now = new Date();
    const prepared = await this.prisma.withTenant(tenantId, async (tx) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { id: true, name: true },
      });
      if (!tenant) throw new ApiError(ErrorCode.NOT_FOUND, 'Tenant tidak ditemukan.');

      // Tagihan lama yang sudah lewat masa bayar ditutup dulu supaya index
      // "satu PENDING per tenant" tidak menghalangi tagihan baru.
      const pending = await tx.subscriptionInvoice.findFirst({
        where: { tenantId, status: SubscriptionInvoiceStatus.PENDING },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      if (pending) {
        if (pending.expiresAt.getTime() > now.getTime()) return { tenant, invoice: pending };
        await tx.subscriptionInvoice.update({
          where: { id: pending.id },
          data: { status: SubscriptionInvoiceStatus.EXPIRED },
        });
        await this.audit.record(
          {
            tenantId,
            actorUserId,
            action: 'SUBSCRIPTION_INVOICE_EXPIRED',
            domain: 'subscription',
            entityType: 'subscription_invoice',
            entityId: pending.id,
            fromState: 'PENDING',
            toState: 'EXPIRED',
            correlationId: ctx.correlationId,
          },
          tx,
        );
      }
      return { tenant, invoice: null };
    });
    if (prepared.invoice) return this.toView(prepared.invoice);

    const externalId = randomUUID();
    const expiresAt = new Date(
      now.getTime() + this.config.SUBSCRIPTION_INVOICE_DURATION_SECONDS * 1000,
    );

    // QRIS dinamis dibuat sebelum insert: kegagalan konfigurasi tidak boleh
    // meninggalkan baris PENDING yang menggantung tanpa QR.
    const { payload } = await this.qris.render(amount);

    let created: SubscriptionInvoiceRow;
    try {
      created = await this.prisma.withTenant(tenantId, (tx) =>
        tx.subscriptionInvoice.create({
          data: {
            tenantId,
            provider: PROVIDER,
            externalId,
            amount: BigInt(amount),
            currency: 'IDR',
            qrPayload: payload,
            expiresAt,
          },
        }),
      );
    } catch (error) {
      // Request paralel: tagihan PENDING milik request lain sudah dibuat.
      if (!isUniqueViolation(error)) throw error;
      const pending = await this.prisma.withTenant(tenantId, (tx) =>
        tx.subscriptionInvoice.findFirst({
          where: { tenantId, status: SubscriptionInvoiceStatus.PENDING },
        }),
      );
      if (pending) return this.toView(pending);
      throw error;
    }

    // Audit ditulis di transaksi ber-tenant yang sama: `audit_logs` memakai RLS
    // dan menolak insert tanpa `app.tenant_id`.
    const updated = await this.prisma.withTenant(tenantId, async (tx) => {
      await this.audit.record(
        {
          tenantId,
          actorUserId,
          action: 'SUBSCRIPTION_INVOICE_CREATED',
          domain: 'subscription',
          entityType: 'subscription_invoice',
          entityId: created.id,
          toState: 'PENDING',
          correlationId: ctx.correlationId,
          metadata: { amount, provider: PROVIDER, expiresAt: expiresAt.toISOString() },
        },
        tx,
      );
      return created;
    });

    return this.toView(updated);
  }

  /**
   * Penanda tagihan lunas yang dipakai Admin Platform.
   *
   * Tidak memakai `MANAGE_PERMISSION` tenant: otorisasinya sudah dilakukan
   * lapisan Admin Platform (permission `platform.subscriptions.settle`).
   */
  async settleInvoice(
    invoice: SubscriptionInvoiceRow,
    input: {
      paidAmount: number;
      method?: string | null;
      channel?: string | null;
      correlationId: string;
    },
  ): Promise<boolean> {
    return this.settlement.settle(invoice, input);
  }

  private async toView(row: SubscriptionInvoiceRow): Promise<SubscriptionInvoiceView> {
    let qrImageDataUrl: string | null = null;
    if (row.status === SubscriptionInvoiceStatus.PENDING && row.qrPayload) {
      qrImageDataUrl = await QRCode.toDataURL(row.qrPayload, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 512,
        color: { dark: '#111111', light: '#ffffff' },
      }).catch(() => {
        // Gambar gagal dirender bukan alasan menolak riwayat tagihan; payload
        // tetap dikirim agar klien bisa merender sendiri.
        this.logger.warn(`gagal merender gambar QR untuk invoice=${row.id}`);
        return null;
      });
    }

    return {
      id: row.id,
      status: row.status,
      provider: row.provider,
      amount: row.amount.toString(),
      currency: row.currency,
      qrPayload: row.qrPayload,
      qrImageDataUrl,
      expiresAt: row.expiresAt.toISOString(),
      paidAt: row.paidAt ? row.paidAt.toISOString() : null,
      paidAmount: row.paidAmount === null ? null : row.paidAmount.toString(),
      paymentMethod: row.paymentMethod,
      paymentChannel: row.paymentChannel,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
