import { Injectable } from '@nestjs/common';
import type { Prisma } from '@rentalio/database';
import { PrismaService } from '../prisma/prisma.service.js';
import { ReservationsService } from '../reservations/reservations.service.js';
import { SubscriptionPolicyService } from '../subscriptions/subscription-policy.service.js';
import { CatalogConfigService } from '../catalog-config/catalog-config.service.js';
import { ExtensionsService } from '../extensions/extensions.service.js';
import { RateLimitService, PUBLIC_RATE_LIMITS } from '../rate-limit/rate-limit.service.js';
import { AuditService } from '../audit/audit.service.js';
import { ApiError, ErrorCode } from '../common/errors.js';
import { hashToken, randomToken } from '../common/crypto.js';
import type { CreatePublicBookingDto, PortalExtensionRequestDto } from './public.dto.js';

/** UUID tenant tidak pernah dikirim ke publik; slug adalah identitas publik. */
export interface PublicTenant {
  slug: string;
  name: string;
  timezone: string;
  currency: string;
  bookingMode: string;
  catalogPolicy: string;
  whatsappNumber: string | null;
  bankTransferInstructions: string | null;
  qrisImageUrl: string | null;
}

const PUBLIC_METHODS = ['CASH', 'BANK_TRANSFER', 'QRIS'] as const;

/**
 * Token portal: 256-bit acak, hanya hash yang disimpan. Masa berlaku belum
 * ditetapkan sebagai keputusan bisnis final; baseline 30 hari dan dapat
 * dicabut dengan menandai `revokedAt`.
 */
const PORTAL_TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/;

/**
 * Normalisasi hostname untuk pencarian domain kustom: lowercase, tanpa port,
 * tanpa titik akhir (FQDN absolut). Mengembalikan null untuk bentuk yang tidak
 * mungkin menjadi domain tenant (IP literal, localhost, karakter ilegal).
 */
export function normalizeHostname(input: string): string | null {
  const withoutPort = input
    .trim()
    .toLowerCase()
    .replace(/:\d{1,5}$/, '')
    .replace(/\.$/, '');
  if (withoutPort.length < 4 || withoutPort.length > 253) return null;
  if (withoutPort === 'localhost' || withoutPort.endsWith('.localhost')) return null;
  // IPv4 literal tidak pernah dipakai sebagai domain kustom.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(withoutPort)) return null;
  const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
  if (!new RegExp(`^${label}(?:\\.${label})+$`).test(withoutPort)) return null;
  return withoutPort;
}

function money(value: bigint | number | null | undefined): string {
  return (value ?? 0n).toString();
}

/**
 * Alur penyewa publik (Notion 14). Tidak ada sumber kebenaran di client:
 * ketersediaan, harga, status, dan metode pembayaran selalu dibaca server.
 * Endpoint publik hanya mengembalikan data yang boleh dilihat penyewa.
 */
@Injectable()
export class PublicService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reservations: ReservationsService,
    private readonly subscriptions: SubscriptionPolicyService,
    private readonly rateLimit: RateLimitService,
    private readonly audit: AuditService,
    private readonly catalogConfig: CatalogConfigService,
    private readonly extensions: ExtensionsService,
  ) {}

  // ============================================================
  // Katalog publik
  // ============================================================

  async getCatalog(slug: string, ip: string) {
    await this.consume(PUBLIC_RATE_LIMITS.catalogIp, ip);
    const tenant = await this.resolveTenant(slug);

    const data = await this.prisma.withTenant(tenant.id, async (tx) => {
      const [categories, products] = await Promise.all([
        tx.category.findMany({ where: { tenantId: tenant.id }, orderBy: { name: 'asc' } }),
        tx.product.findMany({
          where: { tenantId: tenant.id, isActive: true },
          include: { rates: true },
          orderBy: { name: 'asc' },
        }),
      ]);
      return {
        categories: categories.map((category) => ({
          id: category.id,
          name: category.name,
        })),
        products: products.map((product) => this.mapProduct(product)),
      };
    });

    return { tenant: this.publicTenant(tenant), ...data };
  }

  /**
   * Konfigurasi presentasi live katalog publik (Notion 06 WEB-07). Hanya versi
   * PUBLISHED yang dibaca; bila tenant belum pernah publish, storefront memakai
   * konfigurasi default sehingga halaman tetap bisa dirender. Konfigurasi hanya
   * berisi presentasi — harga, stok, dan ketersediaan tetap dari domain Rentalio.
   */
  async getCatalogConfig(slug: string, ip: string) {
    await this.consume(PUBLIC_RATE_LIMITS.catalogIp, ip);
    const tenant = await this.resolveTenant(slug);
    const config = await this.catalogConfig.readPublished(tenant.id);
    return { tenant: this.publicTenant(tenant), ...config };
  }

  async getProduct(slug: string, productId: string, ip: string) {
    await this.consume(PUBLIC_RATE_LIMITS.catalogIp, ip);
    const tenant = await this.resolveTenant(slug);
    if (!/^[0-9a-f-]{36}$/i.test(productId)) {
      throw new ApiError(ErrorCode.NOT_FOUND, 'Produk tidak ditemukan.');
    }

    const product = await this.prisma.withTenant(tenant.id, async (tx) => {
      const row = await tx.product.findUnique({
        where: { tenantId_id: { tenantId: tenant.id, id: productId } },
        include: { rates: true },
      });
      return row && row.isActive ? row : null;
    });
    if (!product) throw new ApiError(ErrorCode.NOT_FOUND, 'Produk tidak ditemukan.');

    return { tenant: this.publicTenant(tenant), product: this.mapProduct(product) };
  }

  /**
   * Resolusi tenant dari hostname kustom (`tenant_domains`).
   *
   * Hanya domain yang sudah diverifikasi dan aktif yang dipakai, dan tenant
   * tetap harus ACTIVE. Semua kegagalan dijawab 404 yang sama agar status
   * domain/tenant internal tidak bocor ke publik.
   */
  async resolveDomain(hostname: string, ip: string) {
    await this.consume(PUBLIC_RATE_LIMITS.hostIp, ip);
    const normalized = normalizeHostname(hostname);
    if (!normalized) throw new ApiError(ErrorCode.NOT_FOUND, 'Katalog tidak ditemukan.');

    const tenant = await this.prisma.withPublicHostname(normalized, async (tx) => {
      const domain = await tx.tenantDomain.findUnique({ where: { hostname: normalized } });
      if (!domain || !domain.isActive || domain.verifiedAt === null) return null;
      // Domain menentukan tenant secara otoritatif; baru setelah itu tabel
      // tenant-scoped bisa dibaca di transaksi yang sama.
      await this.prisma.setTenant(domain.tenantId, tx);
      const row = await tx.tenant.findUnique({ where: { id: domain.tenantId } });
      return row && row.status === 'ACTIVE' ? row : null;
    });

    if (!tenant) throw new ApiError(ErrorCode.NOT_FOUND, 'Katalog tidak ditemukan.');
    return { tenant: this.publicTenant(tenant) };
  }

  async checkAvailability(slug: string, productId: string, startAt: string, endAt: string, ip: string) {
    await this.consume(PUBLIC_RATE_LIMITS.availabilityIp, ip);
    const tenant = await this.resolveTenant(slug);
    return this.reservations.checkPublicAvailability(tenant.id, productId, startAt, endAt);
  }

  // ============================================================
  // Booking tamu
  // ============================================================

  async createBooking(
    slug: string,
    dto: CreatePublicBookingDto,
    ctx: { ip: string; correlationId: string; idempotencyKey?: string },
  ) {
    await this.consume(PUBLIC_RATE_LIMITS.bookingIp, ctx.ip);
    const tenant = await this.resolveTenant(slug);
    await this.consume(PUBLIC_RATE_LIMITS.bookingTenant, tenant.id);

    if (!dto.guest.phone && !dto.guest.email) {
      throw new ApiError(
        ErrorCode.VALIDATION_ERROR,
        'Isi nomor WhatsApp atau email agar admin dapat menghubungi Anda.',
      );
    }

    // Restricted mode menolak komitmen baru (Notion 04/16).
    await this.subscriptions.assertTransactionAllowed(tenant.id);

    const reservation = await this.reservations.createReservation(
      tenant.id,
      {
        startAt: dto.startAt,
        endAt: dto.endAt,
        items: dto.items,
      },
      {
        correlationId: ctx.correlationId,
        idempotencyKey: ctx.idempotencyKey,
        skipMembership: true,
        actorUserId: null,
        guest: {
          name: dto.guest.name,
          phone: dto.guest.phone,
          email: dto.guest.email,
          termsVersion: dto.terms.version,
          termsAcceptedAt: new Date(),
        },
      },
    );

    const portal = await this.issuePortalToken(tenant.id, reservation.id);
    const summary = await this.loadReservationSummary(tenant.id, reservation.id);

    // Audit ditulis di konteks tenant: `audit_logs` memakai FORCE RLS dan
    // transaksi tanpa `app.tenant_id` akan ditolak (fail-closed).
    await this.prisma.withTenant(tenant.id, (tx) =>
      this.audit.record(
        {
          tenantId: tenant.id,
          action: 'PUBLIC_BOOKING_CREATED',
          domain: 'reservation',
          entityType: 'reservation',
          entityId: reservation.id,
          toState: reservation.status,
          correlationId: ctx.correlationId,
          metadata: {
            status: reservation.status,
            termsVersion: dto.terms.version,
            portalExpiresAt: portal.expiresAt.toISOString(),
          },
        },
        tx,
      ),
    );

    return {
      tenant: this.publicTenant(tenant),
      reservation: summary,
      portal: {
        token: portal.token,
        path: `/portal/${portal.token}`,
        expiresAt: portal.expiresAt,
      },
    };
  }

  // ============================================================
  // Portal pesanan
  // ============================================================

  async getPortalOrder(token: string, ip: string) {
    await this.consume(PUBLIC_RATE_LIMITS.portalIp, ip);
    // Token base64url 256-bit; tolak bentuk lain sebelum menyentuh database.
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) {
      throw new ApiError(ErrorCode.NOT_FOUND, 'Tautan pesanan tidak valid atau sudah kedaluwarsa.');
    }
    const tokenHash = hashToken(token);

    return this.prisma.withPortalToken(tokenHash, async (tx) => {
      const access = await tx.publicOrderAccess.findUnique({ where: { tokenHash } });
      if (!access || access.revokedAt || access.expiresAt.getTime() <= Date.now()) {
        throw new ApiError(ErrorCode.NOT_FOUND, 'Tautan pesanan tidak valid atau sudah kedaluwarsa.');
      }

      await this.prisma.setTenant(access.tenantId, tx);
      const tenant = await tx.tenant.findUnique({ where: { id: access.tenantId } });
      if (!tenant || tenant.status !== 'ACTIVE') {
        throw new ApiError(ErrorCode.NOT_FOUND, 'Tautan pesanan tidak valid atau sudah kedaluwarsa.');
      }

      const reservation = await tx.reservation.findUnique({
        where: { tenantId_id: { tenantId: tenant.id, id: access.reservationId } },
        include: {
          customer: { select: { name: true } },
          items: { include: { product: { select: { name: true } } } },
        },
      });
      if (!reservation) {
        throw new ApiError(ErrorCode.NOT_FOUND, 'Tautan pesanan tidak valid atau sudah kedaluwarsa.');
      }

      const order = await tx.rentalOrder.findFirst({
        where: { tenantId: tenant.id, sourceReservationId: reservation.id },
        include: {
          payments: {
            where: { status: 'RECORDED' },
            orderBy: { recordedAt: 'asc' },
          },
        },
      });

      // Riwayat pengajuan perpanjangan untuk pesanan ini. Status tetap
      // ditampilkan portal walau fitur sudah dimatikan tenant; `extensionsEnabled`
      // yang menentukan apakah pengajuan baru masih diterima.
      const extensions = order
        ? await tx.orderExtension.findMany({
            where: { tenantId: tenant.id, orderId: order.id },
            orderBy: { createdAt: 'desc' },
            take: 10,
          })
        : [];

      const settings = await tx.tenantPaymentMethodSetting.findMany({
        where: { tenantId: tenant.id, context: 'NEW_BOOKING' },
      });
      const enabledRows = new Map(settings.map((row) => [row.method, row.enabled]));
      const paymentMethods = PUBLIC_METHODS.filter((method) => enabledRows.get(method) ?? true);

      const reservationTotal = reservation.items.reduce(
        (sum, item) => sum + item.priceSnapshot * BigInt(item.quantity),
        0n,
      );
      const paidAmount = order
        ? order.payments.reduce((sum, payment) => sum + payment.amount, 0n)
        : 0n;
      const orderTotal = order?.totalAmount ?? reservationTotal;

      return {
        tenant: this.publicTenant(tenant),
        guestName: reservation.customer?.name ?? null,
        reservation: {
          reference: reservation.id,
          status: reservation.status,
          bookingMode: reservation.bookingMode,
          startAt: reservation.startAt,
          endAt: reservation.endAt,
          createdAt: reservation.createdAt,
          items: reservation.items.map((item) => ({
            name: item.product.name,
            quantity: item.quantity,
            lineTotal: money(item.priceSnapshot * BigInt(item.quantity)),
          })),
          totalAmount: money(reservationTotal),
        },
        order: order
          ? {
              orderNumber: order.orderNumber,
              status: order.status,
              totalAmount: money(order.totalAmount),
              paidAmount: money(paidAmount),
              outstandingAmount: money(order.totalAmount - paidAmount > 0n ? order.totalAmount - paidAmount : 0n),
              payments: order.payments.map((payment) => ({
                amount: money(payment.amount),
                method: payment.method,
                recordedAt: payment.recordedAt,
              })),
            }
          : null,
        summary: {
          totalAmount: money(orderTotal),
          paidAmount: money(paidAmount),
          outstandingAmount: money(orderTotal - paidAmount > 0n ? orderTotal - paidAmount : 0n),
        },
        paymentMethods,
        extensionsEnabled: tenant.rentalExtensionEnabled,
        extensions: extensions.map((extension) => ({
          id: extension.id,
          status: extension.status,
          previousEndAt: extension.previousEndAt,
          requestedEndAt: extension.requestedEndAt,
          amount: money(extension.amount),
          currency: extension.currency,
          createdAt: extension.createdAt,
          decidedAt: extension.decidedAt,
          decisionReason: extension.decisionReason,
        })),
        portalExpiresAt: access.expiresAt,
      };
    });
  }

  /**
   * Pengajuan perpanjangan dari portal tamu (tanpa sesi). Token hanya memberi
   * akses ke satu pesanan; tenant, order, periode, dan biaya ditentukan server.
   * Permintaan tetap berstatus PENDING_APPROVAL dan menunggu keputusan staff.
   */
  async requestPortalExtension(
    token: string,
    dto: PortalExtensionRequestDto,
    ctx: { ip: string; correlationId: string },
  ) {
    await this.consume(PUBLIC_RATE_LIMITS.portalIp, ctx.ip);
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) {
      throw new ApiError(ErrorCode.NOT_FOUND, 'Tautan pesanan tidak valid atau sudah kedaluwarsa.');
    }
    const tokenHash = hashToken(token);

    const scope = await this.prisma.withPortalToken(tokenHash, async (tx) => {
      const access = await tx.publicOrderAccess.findUnique({ where: { tokenHash } });
      if (!access || access.revokedAt || access.expiresAt.getTime() <= Date.now()) {
        throw new ApiError(ErrorCode.NOT_FOUND, 'Tautan pesanan tidak valid atau sudah kedaluwarsa.');
      }

      await this.prisma.setTenant(access.tenantId, tx);
      const tenant = await tx.tenant.findUnique({ where: { id: access.tenantId } });
      if (!tenant || tenant.status !== 'ACTIVE') {
        throw new ApiError(ErrorCode.NOT_FOUND, 'Tautan pesanan tidak valid atau sudah kedaluwarsa.');
      }
      if (!tenant.rentalExtensionEnabled) {
        throw new ApiError(
          ErrorCode.BUSINESS_RULE_VIOLATION,
          'Perpanjangan sewa tidak tersedia untuk toko ini.',
        );
      }

      // Perpanjangan selalu merujuk order hasil konversi reservasi sumber;
      // tanpa order tidak ada periode/biaya yang sah untuk dihitung.
      const order = await tx.rentalOrder.findFirst({
        where: { tenantId: tenant.id, sourceReservationId: access.reservationId },
        select: { id: true },
      });
      if (!order) {
        throw new ApiError(
          ErrorCode.INVALID_STATE_TRANSITION,
          'Perpanjangan belum tersedia sebelum pesanan dibuat.',
        );
      }

      return { tenantId: tenant.id, orderId: order.id, portalExpiresAt: access.expiresAt };
    });

    const extension = await this.extensions.requestExtensionFromPortal(
      scope.tenantId,
      scope.orderId,
      { requestedEndAt: dto.requestedEndAt, note: dto.note },
      { correlationId: ctx.correlationId },
    );

    return { extension, portalExpiresAt: scope.portalExpiresAt };
  }

  // ============================================================
  // Internal
  // ============================================================

  private async resolveTenant(slug: string) {
    const normalized = slug.trim().toLowerCase();
    if (!SLUG_PATTERN.test(normalized)) {
      throw new ApiError(ErrorCode.NOT_FOUND, 'Katalog tidak ditemukan.');
    }
    const tenant = await this.prisma.withPublicTenantSlug(normalized, (tx) =>
      tx.tenant.findUnique({ where: { slug: normalized } }),
    );
    // Tenant yang belum aktif, suspended, atau closed tidak pernah tampil
    // publik; jangan membocorkan status internalnya.
    if (!tenant || tenant.status !== 'ACTIVE') {
      throw new ApiError(ErrorCode.NOT_FOUND, 'Katalog tidak ditemukan.');
    }
    return tenant;
  }

  private async issuePortalToken(tenantId: string, reservationId: string) {
    const token = randomToken();
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + PORTAL_TOKEN_TTL_MS);

    await this.prisma.withTenant(tenantId, async (tx) => {
      // Satu tautan aktif per reservasi: issuance baru mencabut yang lama.
      await tx.publicOrderAccess.updateMany({
        where: { tenantId, reservationId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.publicOrderAccess.create({
        data: { tenantId, reservationId, tokenHash, expiresAt },
      });
    });

    return { token, expiresAt };
  }

  private async loadReservationSummary(tenantId: string, reservationId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const reservation = await tx.reservation.findUnique({
        where: { tenantId_id: { tenantId, id: reservationId } },
        include: {
          customer: { select: { name: true } },
          items: { include: { product: { select: { name: true } } } },
        },
      });
      if (!reservation) {
        throw new ApiError(ErrorCode.NOT_FOUND, 'Reservasi tidak ditemukan.');
      }
      const total = reservation.items.reduce(
        (sum, item) => sum + item.priceSnapshot * BigInt(item.quantity),
        0n,
      );
      return {
        reference: reservation.id,
        status: reservation.status,
        bookingMode: reservation.bookingMode,
        guestName: reservation.customer?.name ?? null,
        startAt: reservation.startAt,
        endAt: reservation.endAt,
        createdAt: reservation.createdAt,
        items: reservation.items.map((item) => ({
          name: item.product.name,
          quantity: item.quantity,
          lineTotal: money(item.priceSnapshot * BigInt(item.quantity)),
        })),
        totalAmount: money(total),
      };
    });
  }

  private mapProduct(
    product: Prisma.ProductGetPayload<{ include: { rates: true } }>,
  ) {
    const rate = product.rates[0];
    return {
      id: product.id,
      name: product.name,
      description: product.description,
      categoryId: product.categoryId,
      stockMode: product.stockMode,
      capacity: product.capacity,
      rate: rate
        ? {
            perDayAmount: money(rate.perDayAmount),
            perWeekAmount: rate.perWeekAmount === null ? null : money(rate.perWeekAmount),
            perMonthAmount: rate.perMonthAmount === null ? null : money(rate.perMonthAmount),
          }
        : null,
    };
  }

  private publicTenant(tenant: {
    slug: string;
    name: string;
    timezone: string;
    currency: string;
    bookingMode: string;
    catalogPolicy: string;
    whatsappNumber: string | null;
    bankTransferInstructions: string | null;
    qrisImageUrl: string | null;
  }): PublicTenant {
    return {
      slug: tenant.slug,
      name: tenant.name,
      timezone: tenant.timezone,
      currency: tenant.currency,
      bookingMode: tenant.bookingMode,
      catalogPolicy: tenant.catalogPolicy,
      whatsappNumber: tenant.whatsappNumber,
      bankTransferInstructions: tenant.bankTransferInstructions,
      qrisImageUrl: tenant.qrisImageUrl,
    };
  }

  private async consume(
    rule: { bucket: string; limit: number; windowSeconds: number },
    identifier: string,
  ): Promise<void> {
    const result = await this.rateLimit.consume(rule, identifier);
    if (!result.allowed) {
      throw new ApiError(
        ErrorCode.RATE_LIMITED,
        `Terlalu banyak permintaan. Coba lagi dalam ${result.retryAfterSeconds} detik.`,
      );
    }
  }
}
