import { Injectable } from '@nestjs/common';
import type { Prisma } from '@rentalio/database';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { TenantService } from '../tenant/tenant.service.js';
import { ApiError, ErrorCode } from '../common/errors.js';
import { hashToken } from '../common/crypto.js';
import type {
  AvailabilityQueryDto,
  CancelReservationDto,
  ConfirmReservationDto,
  CreateReservationDto,
  RejectReservationDto,
} from './reservations.dto.js';

type Ctx = {
  /** Null untuk booking tamu publik (tanpa sesi). */
  actorUserId?: string | null;
  correlationId: string;
  idempotencyKey?: string;
  /** Dilewati hanya oleh alur publik yang sudah meresolusi tenant aktif. */
  skipMembership?: boolean;
  /** Data tamu; pembuatan Customer dilakukan di transaksi yang sama. */
  guest?: {
    name: string;
    phone?: string;
    email?: string;
    termsVersion: string;
    termsAcceptedAt: Date;
  };
};
type ReservationWithRelations = Prisma.ReservationGetPayload<{
  include: { items: true; allocations: true };
}>;

const READ_ROLES = ['OWNER', 'MANAGER', 'STAFF', 'CASHIER'];
const CREATE_ROLES = ['OWNER', 'MANAGER', 'STAFF'];
const APPROVE_ROLES = ['OWNER', 'MANAGER'];
const CANCEL_ROLES = ['OWNER', 'MANAGER'];

/** Scope idempotency untuk create booking (dokumen 10: operasi kritis idempoten). */
const IDEMPOTENCY_SCOPE = 'create-reservation';
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
 * Reservasi & ketersediaan — ADR-001 §1 + Notion 04.
 *
 * Anti double-booking (dokumen 03 & 10), semua dalam SATU transaksi
 * `withTenant` (konteks RLS aktif):
 *   1. SELECT ... FOR UPDATE pada baris Product yang dipesan — serialisasi
 *      request paralel yang menyentuh produk yang sama.
 *   2. Hitung ketersediaan: alokasi ACTIVE tumpang tindih + maintenance.
 *   3. Insert alokasi — exclusion constraint PostgreSQL
 *      (btree_gist + tsrange '[)') menjadi tameng terakhir bila kandidat
 *      unit diselewengi (23P01 → dipetakan ke AVAILABILITY_CONFLICT).
 *
 * Mode booking (dari pengaturan tenant, bukan dari body request):
 *   - MANUAL: create → PENDING_APPROVAL tanpa alokasi permanen.
 *   - AUTOMATIC: create → check-and-allocate atomik → CONFIRMED;
 *     bila stok tidak tersedia, kebijakan katalog tenant menentukan:
 *       * CHECK_AVAILABILITY (Opsi A): PENDING_APPROVAL tanpa alokasi,
 *         approval admin memvalidasi ulang.
 *       * SKIP_AVAILABILITY (Opsi B): tolak — 409 AVAILABILITY_CONFLICT.
 *
 * Transisi status (terminal: REJECTED, CANCELLED, EXPIRED, CONVERTED_TO_ORDER):
 *   PENDING_APPROVAL → CONFIRMED | REJECTED
 *   PENDING_APPROVAL | CONFIRMED → CANCELLED (lepas alokasi atomik & idempoten)
 * Tidak ada endpoint PATCH status bebas.
 */
@Injectable()
export class ReservationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tenantService: TenantService,
  ) {}

  // ============================================================
  // Ketersediaan
  // ============================================================

  /**
   * GET /tenants/:tenantId/availability — cek ketersediaan satu produk
   * untuk periode tanpa membuat reservasi (read-only, tanpa lock tulis).
   */
  async checkAvailability(
    tenantId: string,
    query: AvailabilityQueryDto,
    actorUserId: string,
  ) {
    await this.tenantService.requireMembership(tenantId, actorUserId, READ_ROLES);
    const startAt = this.parseDate(query.startAt);
    const endAt = this.parseDate(query.endAt);
    this.assertPeriod(startAt, endAt);

    return this.prisma.withTenant(tenantId, async (tx) => {
      const product = await tx.product.findUnique({
        where: { tenantId_id: { tenantId, id: query.productId } },
      });
      if (!product) throw new ApiError(ErrorCode.NOT_FOUND, 'Produk tidak ditemukan.');

      const snapshot = await this.computeAvailability(
        tx,
        tenantId,
        product.id,
        startAt,
        endAt,
      );
      return {
        productId: product.id,
        stockMode: product.stockMode,
        startAt,
        endAt,
        capacity: snapshot.capacity,
        allocated: snapshot.allocated,
        available: snapshot.available,
        maintenanceBlocked: snapshot.maintenanceBlocked,
        availableAssetIds: snapshot.freeAssetIds,
      };
    });
  }

  /**
   * Ketersediaan untuk katalog publik (tanpa sesi). Hanya produk aktif yang
   * boleh terlihat, dan daftar unit fisik tidak pernah dikembalikan ke publik.
   */
  async checkPublicAvailability(
    tenantId: string,
    productId: string,
    startAtIso: string,
    endAtIso: string,
  ) {
    const startAt = this.parseDate(startAtIso);
    const endAt = this.parseDate(endAtIso);
    this.assertPeriod(startAt, endAt);

    return this.prisma.withTenant(tenantId, async (tx) => {
      const product = await tx.product.findUnique({
        where: { tenantId_id: { tenantId, id: productId } },
      });
      if (!product || !product.isActive) {
        throw new ApiError(ErrorCode.NOT_FOUND, 'Produk tidak ditemukan.');
      }
      const snapshot = await this.computeAvailability(
        tx,
        tenantId,
        product.id,
        startAt,
        endAt,
      );
      return {
        productId: product.id,
        stockMode: product.stockMode,
        startAt,
        endAt,
        capacity: snapshot.capacity,
        available: snapshot.available,
        maintenanceBlocked: snapshot.maintenanceBlocked,
      };
    });
  }

  /**
   * Hitung ketersediaan satu produk pada periode [startAt, endAt).
   * Pemanggil yang melakukan lock bila hasilnya dipakai untuk keputusan tulis.
   */
  private async computeAvailability(
    tx: Prisma.TransactionClient,
    tenantId: string,
    productId: string,
    startAt: Date,
    endAt: Date,
  ) {
    const product = await tx.product.findUnique({
      where: { tenantId_id: { tenantId, id: productId } },
    });
    if (!product) throw new ApiError(ErrorCode.NOT_FOUND, 'Produk tidak ditemukan.');

    // Maintenance yang tumpang tindih: unit fisik tidak tersedia.
    const overlappingMaintenance = await tx.assetMaintenance.findMany({
      where: {
        tenantId,
        productId,
        startAt: { lt: endAt },
        endAt: { gt: startAt },
      },
      select: { assetId: true },
    });
    const maintenanceAssetIds = new Set(overlappingMaintenance.map((m) => m.assetId));

    if (product.stockMode === 'QUANTITY') {
      // Stok kuantitas: jumlahkan alokasi ACTIVE tumpang tindih.
      const rows = await tx.reservationAllocation.findMany({
        where: {
          tenantId,
          productId,
          status: 'ACTIVE',
          startAt: { lt: endAt },
          endAt: { gt: startAt },
        },
        select: { quantity: true, assetId: true },
      });
      const allocatedByQuantity = rows.reduce((sum, r) => sum + r.quantity, 0);
      const blockedInMaintenance = rows.filter(
        (r) => r.assetId && maintenanceAssetIds.has(r.assetId),
      ).length;
      const available = Math.max(0, product.capacity - allocatedByQuantity);
      return {
        stockMode: product.stockMode as 'QUANTITY',
        capacity: product.capacity,
        allocated: allocatedByQuantity,
        maintenanceBlocked: blockedInMaintenance,
        available,
        freeAssetIds: [] as string[],
      };
    }

    // INDIVIDUAL_UNITS: ketersediaan per unit (exclusion constraint per asset).
    const assets = await tx.asset.findMany({
      where: { tenantId, productId, status: { notIn: ['RETIRED', 'DAMAGED'] } },
      orderBy: { code: 'asc' },
      select: { id: true },
    });
    const allocatedAssets = await tx.reservationAllocation.findMany({
      where: {
        tenantId,
        productId,
        status: 'ACTIVE',
        assetId: { not: null },
        startAt: { lt: endAt },
        endAt: { gt: startAt },
      },
      select: { assetId: true },
    });
    const allocatedAssetIds = new Set(
      allocatedAssets.map((a) => a.assetId as string),
    );
    const freeAssetIds = assets
      .filter(
        (a) => !allocatedAssetIds.has(a.id) && !maintenanceAssetIds.has(a.id),
      )
      .map((a) => a.id);
    return {
      stockMode: product.stockMode as 'INDIVIDUAL_UNITS',
      capacity: assets.length,
      allocated: allocatedAssetIds.size,
      maintenanceBlocked: maintenanceAssetIds.size,
      available: freeAssetIds.length,
      freeAssetIds,
    };
  }

  /** Kunci baris produk (serialisasi request paralel pada produk yang sama). */
  private async lockProduct(
    tx: Prisma.TransactionClient,
    tenantId: string,
    productId: string,
  ): Promise<void> {
    // Prisma tidak mendukung FOR UPDATE secara deklaratif; raw query aman di sini
    // karena tenantId & productId bertipe uuid dan dikirim sebagai parameter.
    await tx.$queryRaw`SELECT id FROM products WHERE "tenantId" = ${tenantId} AND id = ${productId} FOR UPDATE`;
  }

  // ============================================================
  // Create
  // ============================================================

  async createReservation(
    tenantId: string,
    dto: CreateReservationDto,
    ctx: Ctx,
  ) {
    if (!ctx.skipMembership) {
      await this.tenantService.requireMembership(tenantId, ctx.actorUserId!, CREATE_ROLES);
    }
    const startAt = this.parseDate(dto.startAt);
    const endAt = this.parseDate(dto.endAt);
    this.assertPeriod(startAt, endAt);

    // Item duplikat per produk digabung agar perhitungan kapasitas benar.
    const merged = new Map<string, number>();
    for (const item of dto.items) {
      merged.set(item.productId, (merged.get(item.productId) ?? 0) + item.quantity);
    }

    // Fingerprint menormalisasi urutan item: body identik secara semantik
    // dengan key yang sama harus menghasilkan reservasi yang sama.
    const fingerprint = ctx.idempotencyKey
      ? hashToken(
          JSON.stringify({
            op: IDEMPOTENCY_SCOPE,
            tenantId,
            startAt: startAt.toISOString(),
            endAt: endAt.toISOString(),
            customerId: dto.customerId ?? null,
            items: [...merged.entries()]
              .map(([productId, quantity]) => ({ productId, quantity }))
              .sort((a, b) => a.productId.localeCompare(b.productId)),
          }),
        )
      : null;

    try {
      return await this.prisma.withTenant(tenantId, async (tx) => {
      const tenant = await tx.tenant.findUnique({ where: { id: tenantId } });
      if (!tenant) throw new ApiError(ErrorCode.NOT_FOUND, 'Tenant tidak ditemukan.');

      // Booking tamu: buat Customer (isGuest) di transaksi yang sama agar
      // reservasi dan data kontak tidak pernah terpisah.
      let customerId = dto.customerId ?? null;
      if (!customerId && ctx.guest) {
        const guest = await tx.customer.create({
          data: {
            tenantId,
            name: ctx.guest.name.trim(),
            email: ctx.guest.email?.trim().toLowerCase() || null,
            phone: ctx.guest.phone?.trim() || null,
            isGuest: true,
          },
        });
        customerId = guest.id;
      }

      if (customerId) {
        const customer = await tx.customer.findUnique({
          where: { tenantId_id: { tenantId, id: customerId } },
        });
        if (!customer) {
          throw new ApiError(ErrorCode.NOT_FOUND, 'Pelanggan tidak ditemukan.');
        }
      }

      // Validasi keberadaan produk sebelum mengunci.
      for (const productId of merged.keys()) {
        const product = await tx.product.findUnique({
          where: { tenantId_id: { tenantId, id: productId } },
        });
        if (!product) throw new ApiError(ErrorCode.NOT_FOUND, 'Produk tidak ditemukan.');
        if (!product.isActive) {
          throw new ApiError(
            ErrorCode.BUSINESS_RULE_VIOLATION,
            'Produk tidak aktif dan tidak dapat dibooking.',
          );
        }
      }

      // Kunci semua produk (urut agar deterministik) lalu evaluasi ketersediaan.
      const productIds = [...merged.keys()].sort();
      for (const productId of productIds) {
        await this.lockProduct(tx, tenantId, productId);
      }

      const snapshots = new Map<
        string,
        Awaited<ReturnType<typeof this.computeAvailability>>
      >();
      let available = true;
      for (const productId of productIds) {
        const snapshot = await this.computeAvailability(
          tx,
          tenantId,
          productId,
          startAt,
          endAt,
        );
        snapshots.set(productId, snapshot);
        if (merged.get(productId)! > snapshot.available) available = false;
      }

      const automatic = tenant.bookingMode === 'AUTOMATIC';
      const skipPolicy = tenant.catalogPolicy === 'SKIP_AVAILABILITY';

      if (!available && skipPolicy) {
        // Opsi B: booking baru saat stok kosong/tidak tersedia selalu ditolak,
        // termasuk pada mode MANUAL — katalog hanya menawarkan click-to-chat
        // (Notion 14 §A.6, 16 §1). UI memblokir lebih awal, tetapi API tetap
        // menegakkan aturan yang sama agar tidak bisa dilewati.
        throw new ApiError(
          ErrorCode.AVAILABILITY_CONFLICT,
          'Stok tidak tersedia untuk periode yang diminta; hubungi admin melalui WhatsApp untuk alternatif.',
        );
      }

      const status = automatic && available ? 'CONFIRMED' : 'PENDING_APPROVAL';

      const reservation = await tx.reservation.create({
        data: {
          tenantId,
          customerId,
          status,
          bookingMode: tenant.bookingMode,
          startAt,
          endAt,
          ...(ctx.guest && {
            guestTermsVersion: ctx.guest.termsVersion,
            guestTermsAcceptedAt: ctx.guest.termsAcceptedAt,
          }),
        },
      });

      // Item dibuat terpisah (FK gabungan tenantId + relasi).
      // Harga dihitung server dari Rate (per hari × jumlah hari) — harga
      // dari client tidak pernah dipercaya (Notion 04, kontrak harga).
      const rates = await tx.rate.findMany({
        where: { tenantId, productId: { in: productIds } },
      });
      const rateByProduct = new Map(rates.map((r) => [r.productId, r.perDayAmount]));
      const days = BigInt(
        Math.max(1, Math.ceil((endAt.getTime() - startAt.getTime()) / 86_400_000)),
      );
      for (const [productId, quantity] of merged) {
        const perDay = rateByProduct.get(productId) ?? 0n;
        await tx.reservationItem.create({
          data: {
            tenantId,
            reservationId: reservation.id,
            productId,
            quantity,
            startAt,
            endAt,
            priceSnapshot: perDay * days,
            currency: 'IDR',
          },
        });
      }

      let allocatedCount = 0;
      if (status === 'CONFIRMED') {
        // Check-and-allocate atomik: produk sudah terkunci, aman terhadap balapan.
        allocatedCount = await this.allocateAll(
          tx,
          tenantId,
          reservation.id,
          merged,
          snapshots,
          startAt,
          endAt,
        );
      }

      await this.audit.record(
        {
          tenantId,
          actorUserId: ctx.actorUserId,
          action: 'RESERVATION_CREATED',
          domain: 'reservation',
          entityType: 'reservation',
          entityId: reservation.id,
          toState: status,
          correlationId: ctx.correlationId,
          metadata: {
            source: ctx.guest ? 'PUBLIC_GUEST' : 'STAFF',
            bookingMode: tenant.bookingMode,
            catalogPolicy: tenant.catalogPolicy,
            startAt: startAt.toISOString(),
            endAt: endAt.toISOString(),
            items: Object.fromEntries(merged),
            allocated: allocatedCount,
            ...(ctx.guest && { termsVersion: ctx.guest.termsVersion }),
          },
        },
        tx,
      );

      const result = await this.loadReservation(tx, tenantId, reservation.id);

      // Ditulis paling akhir di transaksi yang sama. Unique (tenantId, scope,
      // key) membuat request paralel dengan key sama memblokir di index sampai
      // transaksi pemenang commit, lalu rollback utuh — tidak ada booking ganda.
      if (ctx.idempotencyKey && fingerprint) {
        await tx.idempotencyRecord.create({
          data: {
            tenantId,
            scope: IDEMPOTENCY_SCOPE,
            key: ctx.idempotencyKey,
            requestFingerprint: fingerprint,
            state: 'COMPLETED',
            responseStatus: 201,
            responseBody: JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue,
            expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
          },
        });
      }

      return result;
      });
    } catch (err) {
      if (!ctx.idempotencyKey || !fingerprint || !isIdempotencyConflict(err)) throw err;
      return this.replayIdempotent(tenantId, ctx.idempotencyKey, fingerprint, err);
    }
  }

  /**
   * Replay hasil request sebelumnya untuk Idempotency-Key yang sama.
   * Fingerprint berbeda → 409 IDEMPOTENCY_KEY_REUSED (key dipakai ulang untuk
   * payload lain). Record belum COMPLETED tidak pernah dianggap sukses.
   */
  private async replayIdempotent(
    tenantId: string,
    key: string,
    fingerprint: string,
    original: unknown,
  ): Promise<ReservationWithRelations> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const record = await tx.idempotencyRecord.findUnique({
        where: {
          tenantId_scope_key: { tenantId, scope: IDEMPOTENCY_SCOPE, key },
        },
      });
      if (!record) throw original;
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
      return record.responseBody as unknown as ReservationWithRelations;
    });
  }

  // ============================================================
  // Confirm / Cancel / Reject
  // ============================================================

  /**
   * PENDING_APPROVAL → CONFIRMED: cek ulang ketersediaan dan alokasikan
   * dalam transaksi yang sama. Konflik → 409 AVAILABILITY_CONFLICT tanpa
   * alokasi parsial dan tanpa mengubah status (ADR-001 §1).
   */
  async confirmReservation(
    tenantId: string,
    reservationId: string,
    dto: ConfirmReservationDto,
    ctx: Ctx,
  ) {
    await this.tenantService.requireMembership(tenantId, ctx.actorUserId!, APPROVE_ROLES);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const reservation = await this.requireReservation(tx, tenantId, reservationId);
      if (reservation.status !== 'PENDING_APPROVAL') {
        throw new ApiError(
          ErrorCode.INVALID_STATE_TRANSITION,
          `Reservasi berstatus ${reservation.status} tidak dapat dikonfirmasi.`,
        );
      }

      const items = new Map<string, number>();
      for (const item of reservation.items) {
        items.set(item.productId, (items.get(item.productId) ?? 0) + item.quantity);
      }
      const productIds = [...items.keys()].sort();
      for (const productId of productIds) {
        await this.lockProduct(tx, tenantId, productId);
      }

      const snapshots = new Map<
        string,
        Awaited<ReturnType<typeof this.computeAvailability>>
      >();
      for (const productId of productIds) {
        const snapshot = await this.computeAvailability(
          tx,
          tenantId,
          productId,
          reservation.startAt,
          reservation.endAt,
        );
        snapshots.set(productId, snapshot);
        if (items.get(productId)! > snapshot.available) {
          // Tidak ada alokasi parsial — transaksi dibatalkan oleh error.
          throw new ApiError(
            ErrorCode.AVAILABILITY_CONFLICT,
            'Stok tidak lagi tersedia untuk periode reservasi ini.',
          );
        }
      }

      await tx.reservation.update({
        where: { id: reservationId },
        data: { status: 'CONFIRMED' },
      });
      const allocatedCount = await this.allocateAll(
        tx,
        tenantId,
        reservationId,
        items,
        snapshots,
        reservation.startAt,
        reservation.endAt,
      );

      await this.audit.record(
        {
          tenantId,
          actorUserId: ctx.actorUserId,
          action: 'RESERVATION_CONFIRMED',
          domain: 'reservation',
          entityType: 'reservation',
          entityId: reservationId,
          fromState: reservation.status,
          toState: 'CONFIRMED',
          reason: dto.note?.trim() || undefined,
          correlationId: ctx.correlationId,
          metadata: { allocated: allocatedCount },
        },
        tx,
      );

      return this.loadReservation(tx, tenantId, reservationId);
    });
  }

  /**
   * Nonterminal → CANCELLED: pelepasan alokasi transaksional dan idempoten.
   * Reservation yang sudah menjadi order tidak dibatalkan secara implisit —
   * konversi order di luar cakupan modul ini (terminal CONVERTED_TO_ORDER).
   */
  async cancelReservation(
    tenantId: string,
    reservationId: string,
    dto: CancelReservationDto,
    ctx: Ctx,
  ) {
    await this.tenantService.requireMembership(tenantId, ctx.actorUserId!, CANCEL_ROLES);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const reservation = await this.requireReservation(tx, tenantId, reservationId);
      const cancellable =
        reservation.status === 'PENDING_APPROVAL' || reservation.status === 'CONFIRMED';
      if (!cancellable) {
        throw new ApiError(
          ErrorCode.INVALID_STATE_TRANSITION,
          `Reservasi berstatus ${reservation.status} tidak dapat dibatalkan.`,
        );
      }

      const released = await this.releaseAllocations(tx, tenantId, reservationId);
      await tx.reservation.update({
        where: { id: reservationId },
        data: { status: 'CANCELLED' },
      });

      await this.audit.record(
        {
          tenantId,
          actorUserId: ctx.actorUserId,
          action: 'RESERVATION_CANCELLED',
          domain: 'reservation',
          entityType: 'reservation',
          entityId: reservationId,
          fromState: reservation.status,
          toState: 'CANCELLED',
          reason: dto.reason?.trim() || undefined,
          correlationId: ctx.correlationId,
          metadata: { releasedAllocations: released },
        },
        tx,
      );

      return this.loadReservation(tx, tenantId, reservationId);
    });
  }

  /** PENDING_APPROVAL → REJECTED: keputusan eksplisit aktor berizin. */
  async rejectReservation(
    tenantId: string,
    reservationId: string,
    dto: RejectReservationDto,
    ctx: Ctx,
  ) {
    await this.tenantService.requireMembership(tenantId, ctx.actorUserId!, APPROVE_ROLES);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const reservation = await this.requireReservation(tx, tenantId, reservationId);
      if (reservation.status !== 'PENDING_APPROVAL') {
        throw new ApiError(
          ErrorCode.INVALID_STATE_TRANSITION,
          `Reservasi berstatus ${reservation.status} tidak dapat ditolak.`,
        );
      }
      await tx.reservation.update({
        where: { id: reservationId },
        data: { status: 'REJECTED' },
      });
      await this.audit.record(
        {
          tenantId,
          actorUserId: ctx.actorUserId,
          action: 'RESERVATION_REJECTED',
          domain: 'reservation',
          entityType: 'reservation',
          entityId: reservationId,
          fromState: reservation.status,
          toState: 'REJECTED',
          reason: dto.reason?.trim() || undefined,
          correlationId: ctx.correlationId,
        },
        tx,
      );
      return this.loadReservation(tx, tenantId, reservationId);
    });
  }

  // ============================================================
  // Read
  // ============================================================

  async listReservations(tenantId: string, actorUserId: string) {
    await this.tenantService.requireMembership(tenantId, actorUserId, READ_ROLES);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.reservation.findMany({
        where: { tenantId },
        include: { items: true, allocations: true },
        orderBy: { startAt: 'asc' },
      });
      return rows.map((row) => this.mapReservation(row));
    });
  }

  async getReservation(tenantId: string, reservationId: string, actorUserId: string) {
    await this.tenantService.requireMembership(tenantId, actorUserId, READ_ROLES);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const row = await this.requireReservation(tx, tenantId, reservationId);
      return this.mapReservation(row);
    });
  }

  // ============================================================
  // Helper internal
  // ============================================================

  private async requireReservation(
    tx: Prisma.TransactionClient,
    tenantId: string,
    reservationId: string,
  ): Promise<ReservationWithRelations> {
    const row = await tx.reservation.findUnique({
      where: { tenantId_id: { tenantId, id: reservationId } },
      include: { items: true, allocations: true },
    });
    if (!row) {
      throw new ApiError(ErrorCode.NOT_FOUND, 'Reservasi tidak ditemukan.');
    }
    return row;
  }

  private async loadReservation(
    tx: Prisma.TransactionClient,
    tenantId: string,
    reservationId: string,
  ): Promise<ReturnType<typeof this.mapReservation>> {
    const row = await this.requireReservation(tx, tenantId, reservationId);
    return this.mapReservation(row);
  }

  /**
   * Buat alokasi untuk semua item setelah ketersediaan divalidasi.
   * Untuk INDIVIDUAL_UNITS unit dipilih dari kandidat bebas; kegagalan
   * exclusion constraint (balapan ekstrem) dipetakan ke AVAILABILITY_CONFLICT.
   * Mengembalikan jumlah alokasi yang dibuat.
   */
  private async allocateAll(
    tx: Prisma.TransactionClient,
    tenantId: string,
    reservationId: string,
    items: Map<string, number>,
    snapshots: Map<string, Awaited<ReturnType<typeof this.computeAvailability>>>,
    startAt: Date,
    endAt: Date,
  ): Promise<number> {
    let created = 0;
    const productIds = [...items.keys()].sort();
    for (const productId of productIds) {
      const quantity = items.get(productId)!;
      const snapshot = snapshots.get(productId)!;
      if (snapshot.stockMode === 'QUANTITY') {
        try {
          await tx.reservationAllocation.create({
            data: {
              tenantId,
              productId,
              reservationId,
              quantity,
              startAt,
              endAt,
              status: 'ACTIVE',
            },
          });
          created += 1;
        } catch (err) {
          this.rethrowAsConflict(err);
        }
        continue;
      }

      // INDIVIDUAL_UNITS: alokasikan unit fisik konkret.
      const chosen = snapshot.freeAssetIds.slice(0, quantity);
      if (chosen.length < quantity) {
        throw new ApiError(
          ErrorCode.AVAILABILITY_CONFLICT,
          'Stok unit fisik tidak mencukupi untuk periode yang diminta.',
        );
      }
      for (const assetId of chosen) {
        try {
          await tx.reservationAllocation.create({
            data: {
              tenantId,
              productId,
              assetId,
              reservationId,
              quantity: 1,
              startAt,
              endAt,
              status: 'ACTIVE',
            },
          });
          created += 1;
        } catch (err) {
          this.rethrowAsConflict(err);
        }
        await tx.asset.update({
          where: { tenantId_id: { tenantId, id: assetId } },
          data: { status: 'RESERVED' },
        });
      }
    }
    return created;
  }

  /** Lepas seluruh alokasi ACTIVE milik reservasi (idempoten). */
  private async releaseAllocations(
    tx: Prisma.TransactionClient,
    tenantId: string,
    reservationId: string,
  ): Promise<number> {
    const active = await tx.reservationAllocation.findMany({
      where: { tenantId, reservationId, status: 'ACTIVE' },
      select: { id: true, assetId: true },
    });
    if (active.length === 0) return 0;

    const assetIds = active
      .map((a) => a.assetId)
      .filter((id): id is string => id !== null);
    await tx.reservationAllocation.updateMany({
      where: { id: { in: active.map((a) => a.id) } },
      data: { status: 'RELEASED', releasedAt: new Date() },
    });
    // Kembalikan unit fisik ke AVAILABLE bila tidak dialokasikan reservasi lain.
    if (assetIds.length > 0) {
      await tx.asset.updateMany({
        where: { tenantId, id: { in: assetIds }, status: 'RESERVED' },
        data: { status: 'AVAILABLE' },
      });
    }
    return active.length;
  }

  /** Exclusion constraint PostgreSQL (23P01) → 409 AVAILABILITY_CONFLICT. */
  private rethrowAsConflict(err: unknown): never {
    const code =
      (err as { code?: string; meta?: { code?: string } } | null)?.code ??
      (err as { meta?: { code?: string } } | null)?.meta?.code;
    const message = err instanceof Error ? err.message : '';
    if (
      code === '23P01' ||
      message.includes('23P01') ||
      message.includes('reservation_allocations_no_overlap_asset')
    ) {
      throw new ApiError(
        ErrorCode.AVAILABILITY_CONFLICT,
        'Periode bentrok dengan alokasi yang sudah ada.',
      );
    }
    throw err;
  }

  private parseDate(value: string): Date {
    const date = new Date(value);
    if (isNaN(date.getTime())) {
      throw new ApiError(
        ErrorCode.VALIDATION_ERROR,
        'Format tanggal tidak valid (gunakan ISO 8601).',
      );
    }
    return date;
  }

  private assertPeriod(startAt: Date, endAt: Date): void {
    if (startAt >= endAt) {
      throw new ApiError(
        ErrorCode.VALIDATION_ERROR,
        'startAt harus sebelum endAt.',
      );
    }
  }

  private mapReservation(row: ReservationWithRelations) {
    return {
      id: row.id,
      status: row.status,
      bookingMode: row.bookingMode,
      customerId: row.customerId,
      startAt: row.startAt,
      endAt: row.endAt,
      holdExpiresAt: row.holdExpiresAt,
      hasOpenConflict: row.hasOpenConflict,
      items: row.items.map((item) => ({
        id: item.id,
        productId: item.productId,
        quantity: item.quantity,
        startAt: item.startAt,
        endAt: item.endAt,
        priceSnapshot: item.priceSnapshot.toString(),
        currency: item.currency,
      })),
      allocations: row.allocations.map((allocation) => ({
        id: allocation.id,
        productId: allocation.productId,
        assetId: allocation.assetId,
        quantity: allocation.quantity,
        startAt: allocation.startAt,
        endAt: allocation.endAt,
        status: allocation.status,
        releasedAt: allocation.releasedAt,
      })),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
