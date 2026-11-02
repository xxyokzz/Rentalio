import { Injectable } from '@nestjs/common';
import type { Prisma } from '@rentalio/database';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { TenantService } from '../tenant/tenant.service.js';
import { ApiError, ErrorCode } from '../common/errors.js';
import { hashToken } from '../common/crypto.js';
import type {
  ApproveExtensionDto,
  OverrideExtensionConflictDto,
  RejectExtensionDto,
  RequestExtensionDto,
  ResolveExtensionConflictDto,
} from './extensions.dto.js';

type Ctx = { actorUserId: string; correlationId: string; idempotencyKey?: string };

const IDEMPOTENCY_TTL_MS = 24 * 3600 * 1000;
const DAY_MS = 86_400_000;

const EXTENSION_INCLUDE = {
  override: true,
  conflicts: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.OrderExtensionInclude;

const ORDER_INCLUDE = { items: true } satisfies Prisma.RentalOrderInclude;

type ExtensionRow = Prisma.OrderExtensionGetPayload<{ include: typeof EXTENSION_INCLUDE }>;
type ExtensionWithOverride = Prisma.OrderExtensionGetPayload<{
  include: { override: true };
}>;
type OverrideRow = Prisma.ExtensionOverrideGetPayload<Record<string, never>>;
type ConflictRow = Prisma.ExtensionConflictGetPayload<Record<string, never>>;
type OrderRow = Prisma.RentalOrderGetPayload<{ include: typeof ORDER_INCLUDE }>;
type AllocationWithContext = Prisma.ReservationAllocationGetPayload<{
  include: { reservation: { include: { customer: true; sourceOrder: true } } };
}>;

interface ConflictCandidate {
  allocationId: string;
  reservationId: string | null;
  orderId: string | null;
  orderNumber: string | null;
  customerName: string | null;
  productId: string;
  productName: string;
  assetId: string | null;
  startAt: Date;
  endAt: Date;
  quantity: number;
  reason: 'ASSET_OVERLAP' | 'CAPACITY_EXCEEDED';
}

function isIdempotencyConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; meta?: { target?: unknown }; message?: string };
  if (e.code !== 'P2002') return false;
  const target = Array.isArray(e.meta?.target)
    ? e.meta!.target.join(',')
    : String(e.meta?.target ?? '');
  return target.includes('scope') || String(e.message ?? '').includes('scope');
}

function daysBetween(startAt: Date, endAt: Date): number {
  return Math.max(1, Math.ceil((endAt.getTime() - startAt.getTime()) / DAY_MS));
}

/**
 * Perpanjangan sewa — ADR-001 §8.
 *
 * Aturan inti:
 * - Pengajuan tidak mengubah periode/alokasi; perubahan hanya pada APPROVED
 *   yang berhasil membuat alokasi periode tambahan dalam transaksi yang sama.
 * - Opsi A (CHECK_AVAILABILITY) selalu memeriksa ketersediaan; konflik → 409.
 * - Opsi B (SKIP_AVAILABILITY) dapat melewati pemeriksaan awal, tetapi bila
 *   backend menghitung konflik, persetujuan hanya boleh lewat command
 *   override dengan permission `rental.extension.override_conflict`, alasan,
 *   dan konfirmasi risiko. Daftar konflik selalu dihitung server.
 * - Override, alokasi, flag order/booking terdampak, relasi konflik, dan audit
 *   dibuat dalam satu transaksi idempoten.
 *
 * Constraint PostgreSQL (migration 016) tetap menjadi tameng terakhir:
 * overlap yang tidak tercatat sebagai konflik override ditolak 23P01.
 */
@Injectable()
export class ExtensionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tenantService: TenantService,
  ) {}

  // ============================================================
  // Read & request
  // ============================================================

  async listExtensions(tenantId: string, orderId: string, actorUserId: string) {
    await this.tenantService.requirePermission(tenantId, actorUserId, 'order.read');
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.requireOrder(tx, tenantId, orderId);
      const rows = await tx.orderExtension.findMany({
        where: { tenantId, orderId },
        include: EXTENSION_INCLUDE,
        orderBy: { createdAt: 'desc' },
      });
      return rows.map((row) => this.mapExtension(row));
    });
  }

  async getExtension(
    tenantId: string,
    orderId: string,
    extensionId: string,
    actorUserId: string,
  ) {
    await this.tenantService.requirePermission(tenantId, actorUserId, 'order.read');
    return this.prisma.withTenant(tenantId, async (tx) =>
      this.mapExtension(await this.requireExtension(tx, tenantId, orderId, extensionId)),
    );
  }

  /**
   * Antrean permintaan perpanjangan lintas order (halaman Pesanan staf).
   *
   * Hanya membaca: keputusan tetap lewat command approve/reject per order,
   * sehingga tidak ada jalur kedua yang bisa memutuskan tanpa aturan
   * ketersediaan/override. Konteks order (nomor, status, pelanggan) ikut
   * disertakan agar operator tidak perlu membuka tiap pesanan hanya untuk
   * mengenali permintaannya.
   */
  async listPendingExtensions(
    tenantId: string,
    actorUserId: string,
    status: 'PENDING_APPROVAL' | 'ALL' = 'PENDING_APPROVAL',
  ) {
    await this.tenantService.requirePermission(tenantId, actorUserId, 'order.read');
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.orderExtension.findMany({
        where: { tenantId, ...(status === 'ALL' ? {} : { status: 'PENDING_APPROVAL' }) },
        include: {
          ...EXTENSION_INCLUDE,
          order: {
            select: {
              orderNumber: true,
              status: true,
              customer: { select: { name: true } },
            },
          },
        },
        // Antrean: yang paling lama menunggu diproses lebih dulu.
        orderBy: { createdAt: 'asc' },
      });
      return rows.map((row) => ({
        ...this.mapExtension(row),
        order: {
          orderNumber: row.order.orderNumber,
          status: row.order.status,
          customerName: row.order.customer?.name ?? null,
        },
      }));
    });
  }

  async requestExtension(
    tenantId: string,
    orderId: string,
    dto: RequestExtensionDto,
    ctx: Ctx,
  ) {
    await this.tenantService.requirePermission(
      tenantId,
      ctx.actorUserId,
      'rental.extension.request',
    );
    const requestedEndAt = this.parseRequestedEndAt(dto.requestedEndAt);
    const note = dto.note?.trim() || null;

    return this.runIdempotent(
      tenantId,
      'order-extension-request',
      ctx,
      { orderId, requestedEndAt: requestedEndAt.toISOString(), note },
      (tx) =>
        this.createExtensionRequest(tx, tenantId, orderId, {
          requestedEndAt,
          note,
          actorUserId: ctx.actorUserId,
          correlationId: ctx.correlationId,
          source: 'STAFF',
        }),
    );
  }

  /**
   * Pengajuan perpanjangan dari portal tamu (token pesanan, tanpa sesi).
   *
   * Aturan bisnis identik dengan pengajuan staf — flag fitur tenant, status
   * order, periode, satu permintaan pending, dan biaya yang dihitung server —
   * sehingga tidak ada jalur kedua yang bisa melewati validasi. Aktor tidak
   * ada: `requestedByUserId` dan `actorUserId` audit bernilai null, sementara
   * permintaan tetap menunggu keputusan OWNER/MANAGER lewat command approve.
   */
  async requestExtensionFromPortal(
    tenantId: string,
    orderId: string,
    input: { requestedEndAt: string; note?: string },
    ctx: { correlationId: string },
  ) {
    const requestedEndAt = this.parseRequestedEndAt(input.requestedEndAt);
    const note = input.note?.trim() || null;
    return this.prisma.withTenant(tenantId, (tx) =>
      this.createExtensionRequest(tx, tenantId, orderId, {
        requestedEndAt,
        note,
        actorUserId: null,
        correlationId: ctx.correlationId,
        source: 'PORTAL',
      }),
    );
  }

  private parseRequestedEndAt(value: string): Date {
    const requestedEndAt = new Date(value);
    if (Number.isNaN(requestedEndAt.getTime())) {
      throw new ApiError(ErrorCode.VALIDATION_ERROR, 'requestedEndAt tidak valid.');
    }
    return requestedEndAt;
  }

  private async createExtensionRequest(
    tx: Prisma.TransactionClient,
    tenantId: string,
    orderId: string,
    input: {
      requestedEndAt: Date;
      note: string | null;
      actorUserId: string | null;
      correlationId: string;
      source: 'STAFF' | 'PORTAL';
    },
  ) {
    const { requestedEndAt, note } = input;
    const tenant = await this.requireTenant(tx, tenantId);
    if (!tenant.rentalExtensionEnabled) {
      throw new ApiError(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        'Fitur perpanjangan sewa tidak diaktifkan untuk tenant ini.',
      );
    }
    const order = await this.requireOrder(tx, tenantId, orderId);
    this.assertExtendableOrder(order);

    const previousEndAt = order.items.reduce(
      (latest, item) => (item.endAt > latest ? item.endAt : latest),
      order.items[0]?.endAt ?? new Date(0),
    );
    if (requestedEndAt.getTime() <= previousEndAt.getTime()) {
      throw new ApiError(
        ErrorCode.VALIDATION_ERROR,
        'requestedEndAt harus setelah tanggal akhir sewa saat ini.',
      );
    }

    const pending = await tx.orderExtension.findFirst({
      where: { tenantId, orderId, status: 'PENDING_APPROVAL' },
    });
    if (pending) {
      throw new ApiError(
        ErrorCode.INVALID_STATE_TRANSITION,
        'Masih ada permintaan perpanjangan yang menunggu keputusan.',
      );
    }

    const amount = await this.computeExtensionAmount(tx, tenantId, order, requestedEndAt);
    const extension = await tx.orderExtension.create({
      data: {
        tenantId,
        orderId,
        status: 'PENDING_APPROVAL',
        previousEndAt,
        requestedEndAt,
        amount,
        currency: 'IDR',
        requestedByUserId: input.actorUserId,
      },
    });

    await this.audit.record(
      {
        tenantId,
        actorUserId: input.actorUserId,
        action: 'ORDER_EXTENSION_REQUESTED',
        domain: 'order',
        entityType: 'order_extension',
        entityId: extension.id,
        toState: 'PENDING_APPROVAL',
        reason: note ?? undefined,
        correlationId: input.correlationId,
        metadata: {
          orderId,
          source: input.source,
          previousEndAt: previousEndAt.toISOString(),
          requestedEndAt: requestedEndAt.toISOString(),
          amount: amount.toString(),
        },
      },
      tx,
    );

    return this.mapExtension(
      await this.requireExtension(tx, tenantId, orderId, extension.id),
    );
  }

  // ============================================================
  // Approve / reject
  // ============================================================

  async approveExtension(
    tenantId: string,
    orderId: string,
    extensionId: string,
    dto: ApproveExtensionDto,
    ctx: Ctx,
  ) {
    await this.tenantService.requirePermission(
      tenantId,
      ctx.actorUserId,
      'rental.extension.approve',
    );
    return this.runIdempotent(
      tenantId,
      'order-extension-approve',
      ctx,
      { orderId, extensionId, note: dto.note?.trim() ?? null },
      async (tx) => {
        const tenant = await this.requireTenant(tx, tenantId);
        if (!tenant.rentalExtensionEnabled) {
          throw new ApiError(
            ErrorCode.BUSINESS_RULE_VIOLATION,
            'Fitur perpanjangan sewa tidak diaktifkan untuk tenant ini.',
          );
        }

        const extension = await this.requirePendingExtension(tx, tenantId, orderId, extensionId);
        const order = await this.requireOrder(tx, tenantId, orderId);
        this.assertExtendableOrder(order);

        // Konflik dihitung server di dalam transaksi; client tidak pernah
        // mengirim daftar konflik sebagai sumber kebenaran.
        const conflicts = await this.computeConflicts(tx, tenantId, order, extension);
        if (conflicts.length > 0) {
          throw new ApiError(
            ErrorCode.AVAILABILITY_CONFLICT,
            tenant.catalogPolicy === 'SKIP_AVAILABILITY'
              ? 'Periode perpanjangan bertabrakan dengan booking lain. Diperlukan override konflik yang berizin, beralasan, dan dikonfirmasi risikonya.'
              : 'Periode perpanjangan tidak tersedia. Selesaikan konflik jadwal sebelum menyetujui.',
            {
              policy: tenant.catalogPolicy,
              requiresOverride: tenant.catalogPolicy === 'SKIP_AVAILABILITY',
              conflicts: conflicts.map((conflict) => this.mapConflictCandidate(conflict)),
            },
          );
        }

        // Status APPROVED ditulis SEBELUM alokasi karena trigger PostgreSQL
        // hanya menerima override untuk extension yang sudah APPROVED; kedua
        // langkah tetap dalam satu transaksi (gagal alokasi → rollback status).
        await tx.orderExtension.update({
          where: { tenantId_id: { tenantId, id: extensionId } },
          data: {
            status: 'APPROVED',
            decidedByUserId: ctx.actorUserId,
            decidedAt: new Date(),
            decisionReason: dto.note?.trim() || null,
          },
        });
        await this.allocateExtension(tx, tenantId, extension, order, null);
        await tx.rentalItem.updateMany({
          where: { tenantId, orderId },
          data: { endAt: extension.requestedEndAt },
        });
        await tx.rentalOrder.update({
          where: { tenantId_id: { tenantId, id: orderId } },
          data: { totalAmount: { increment: extension.amount } },
        });

        await this.audit.record(
          {
            tenantId,
            actorUserId: ctx.actorUserId,
            action: 'ORDER_EXTENSION_APPROVED',
            domain: 'order',
            entityType: 'order_extension',
            entityId: extensionId,
            fromState: extension.status,
            toState: 'APPROVED',
            reason: dto.note?.trim() || undefined,
            correlationId: ctx.correlationId,
            metadata: {
              orderId,
              policy: tenant.catalogPolicy,
              previousEndAt: extension.previousEndAt.toISOString(),
              requestedEndAt: extension.requestedEndAt.toISOString(),
              amount: extension.amount.toString(),
            },
          },
          tx,
        );

        return this.mapExtension(
          await this.requireExtension(tx, tenantId, orderId, extensionId),
        );
      },
    );
  }

  async rejectExtension(
    tenantId: string,
    orderId: string,
    extensionId: string,
    dto: RejectExtensionDto,
    ctx: Ctx,
  ) {
    await this.tenantService.requirePermission(
      tenantId,
      ctx.actorUserId,
      'rental.extension.approve',
    );
    return this.runIdempotent(
      tenantId,
      'order-extension-reject',
      ctx,
      { orderId, extensionId, reason: dto.reason.trim() },
      async (tx) => {
        const extension = await this.requirePendingExtension(tx, tenantId, orderId, extensionId);
        await tx.orderExtension.update({
          where: { tenantId_id: { tenantId, id: extensionId } },
          data: {
            status: 'REJECTED',
            decidedByUserId: ctx.actorUserId,
            decidedAt: new Date(),
            decisionReason: dto.reason.trim(),
          },
        });
        await this.audit.record(
          {
            tenantId,
            actorUserId: ctx.actorUserId,
            action: 'ORDER_EXTENSION_REJECTED',
            domain: 'order',
            entityType: 'order_extension',
            entityId: extensionId,
            fromState: extension.status,
            toState: 'REJECTED',
            reason: dto.reason.trim(),
            correlationId: ctx.correlationId,
            metadata: { orderId },
          },
          tx,
        );
        return this.mapExtension(
          await this.requireExtension(tx, tenantId, orderId, extensionId),
        );
      },
    );
  }

  // ============================================================
  // Override konflik Opsi B
  // ============================================================

  async overrideExtensionConflict(
    tenantId: string,
    orderId: string,
    extensionId: string,
    dto: OverrideExtensionConflictDto,
    ctx: Ctx,
  ) {
    await this.tenantService.requirePermission(
      tenantId,
      ctx.actorUserId,
      'rental.extension.override_conflict',
    );
    const reason = dto.reason.trim();
    if (!dto.riskConfirmed) {
      throw new ApiError(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        'Konfirmasi risiko (riskConfirmed: true) wajib untuk override konflik.',
      );
    }

    return this.runIdempotent(
      tenantId,
      'order-extension-override',
      ctx,
      { orderId, extensionId, reason, riskConfirmed: true },
      async (tx) => {
        const tenant = await this.requireTenant(tx, tenantId);
        if (!tenant.rentalExtensionEnabled) {
          throw new ApiError(
            ErrorCode.BUSINESS_RULE_VIOLATION,
            'Fitur perpanjangan sewa tidak diaktifkan untuk tenant ini.',
          );
        }
        if (tenant.catalogPolicy !== 'SKIP_AVAILABILITY') {
          throw new ApiError(
            ErrorCode.BUSINESS_RULE_VIOLATION,
            'Override konflik hanya berlaku untuk tenant dengan kebijakan Opsi B (SKIP_AVAILABILITY).',
          );
        }

        const extension = await this.requirePendingExtension(tx, tenantId, orderId, extensionId);
        const order = await this.requireOrder(tx, tenantId, orderId);
        this.assertExtendableOrder(order);

        const conflicts = await this.computeConflicts(tx, tenantId, order, extension);
        if (conflicts.length === 0) {
          throw new ApiError(
            ErrorCode.BUSINESS_RULE_VIOLATION,
            'Tidak ada konflik yang perlu di-override; setujui perpanjangan lewat command approve.',
          );
        }

        const override = await tx.extensionOverride
          .create({
            data: {
              tenantId,
              extensionId,
              orderId,
              policy: tenant.catalogPolicy,
              reason,
              riskAcknowledgedAt: new Date(),
              actorUserId: ctx.actorUserId,
              previousEndAt: extension.previousEndAt,
              requestedEndAt: extension.requestedEndAt,
              amountSnapshot: extension.amount,
              currency: extension.currency,
              conflictCount: conflicts.length,
            },
          })
          .catch((err: unknown) => this.rethrowAsDecided(err));

        await tx.extensionConflict.createMany({
          data: conflicts.map((conflict) => ({
            tenantId,
            extensionId,
            orderId,
            conflictingAllocationId: conflict.allocationId,
            conflictingReservationId: conflict.reservationId,
            conflictingOrderId: conflict.orderId,
            status: 'OPEN',
            summary: this.mapConflictCandidate(conflict) as Prisma.InputJsonValue,
          })),
        });

        if (conflicts.length > 0) {
          // Flag operasional — lifecycle booking/order terdampak TIDAK diubah.
          const reservationIds = [
            ...new Set(
              conflicts
                .map((conflict) => conflict.reservationId)
                .filter((id): id is string => id !== null),
            ),
          ];
          const orderIds = [
            ...new Set(
              conflicts
                .map((conflict) => conflict.orderId)
                .filter((id): id is string => id !== null),
            ),
          ];
          if (reservationIds.length > 0) {
            await tx.reservation.updateMany({
              where: { tenantId, id: { in: reservationIds } },
              data: { hasOpenConflict: true },
            });
          }
          if (orderIds.length > 0) {
            await tx.rentalOrder.updateMany({
              where: { tenantId, id: { in: orderIds } },
              data: { hasOpenConflict: true },
            });
          }
        }

        await tx.orderExtension.update({
          where: { tenantId_id: { tenantId, id: extensionId } },
          data: {
            status: 'APPROVED',
            decidedByUserId: ctx.actorUserId,
            decidedAt: new Date(),
            decisionReason: reason,
          },
        });
        await this.allocateExtension(tx, tenantId, extension, order, override.id);
        await tx.rentalItem.updateMany({
          where: { tenantId, orderId },
          data: { endAt: extension.requestedEndAt },
        });
        await tx.rentalOrder.update({
          where: { tenantId_id: { tenantId, id: orderId } },
          data: {
            totalAmount: { increment: extension.amount },
            hasOpenConflict: true,
          },
        });

        await this.audit.record(
          {
            tenantId,
            actorUserId: ctx.actorUserId,
            action: 'ORDER_EXTENSION_CONFLICT_OVERRIDDEN',
            domain: 'order',
            entityType: 'order_extension',
            entityId: extensionId,
            fromState: extension.status,
            toState: 'APPROVED',
            reason,
            correlationId: ctx.correlationId,
            metadata: {
              overrideId: override.id,
              orderId,
              policy: tenant.catalogPolicy,
              riskAcknowledged: true,
              previousEndAt: extension.previousEndAt.toISOString(),
              requestedEndAt: extension.requestedEndAt.toISOString(),
              amount: extension.amount.toString(),
              conflicts: conflicts.map((conflict) => this.mapConflictCandidate(conflict)),
            },
          },
          tx,
        );

        const loaded = await this.requireExtension(tx, tenantId, orderId, extensionId);
        return {
          ...this.mapExtension(loaded),
          operationalTasks: loaded.conflicts.map((conflict) => this.mapTask(conflict)),
        };
      },
    );
  }

  // ============================================================
  // Penyelesaian konflik & ringkasan operasional
  // ============================================================

  /**
   * Tandai satu tugas konflik selesai.
   *
   * Idempoten: konflik yang sudah RESOLVED dikembalikan apa adanya tanpa
   * audit ganda. Flag `hasOpenConflict` pada order/booking terdampak selalu
   * dihitung ulang dari konflik OPEN yang tersisa — jadi flag bersih tepat
   * ketika konflik terakhir untuk order tersebut selesai, bukan berdasarkan
   * asumsi client.
   */
  async resolveConflict(
    tenantId: string,
    orderId: string,
    extensionId: string,
    conflictId: string,
    dto: ResolveExtensionConflictDto,
    ctx: Ctx,
  ) {
    await this.tenantService.requirePermission(
      tenantId,
      ctx.actorUserId,
      'rental.extension.resolve_conflict',
    );
    const resolutionNote = dto.resolutionNote.trim();
    if (resolutionNote.length < 3) {
      throw new ApiError(ErrorCode.VALIDATION_ERROR, 'resolutionNote minimal 3 karakter.');
    }

    return this.runIdempotent(
      tenantId,
      'extension-conflict-resolve',
      ctx,
      { orderId, extensionId, conflictId, resolutionNote },
      async (tx) => {
        const extension = await this.requireExtension(tx, tenantId, orderId, extensionId);
        if (extension.status !== 'APPROVED') {
          throw new ApiError(
            ErrorCode.INVALID_STATE_TRANSITION,
            `Permintaan perpanjangan berstatus ${extension.status} tidak memiliki konflik operasional.`,
          );
        }
        const conflict = await this.requireConflict(
          tx,
          tenantId,
          orderId,
          extensionId,
          conflictId,
        );

        let resolved = conflict;
        if (conflict.status === 'OPEN') {
          resolved = await tx.extensionConflict.update({
            where: { id: conflictId },
            data: {
              status: 'RESOLVED',
              resolvedAt: new Date(),
              resolvedByUserId: ctx.actorUserId,
              resolutionNote,
            },
          });
          await this.audit.record(
            {
              tenantId,
              actorUserId: ctx.actorUserId,
              action: 'ORDER_EXTENSION_CONFLICT_RESOLVED',
              domain: 'order',
              entityType: 'extension_conflict',
              entityId: conflictId,
              fromState: 'OPEN',
              toState: 'RESOLVED',
              reason: resolutionNote,
              correlationId: ctx.correlationId,
              metadata: {
                orderId,
                extensionId,
                conflictingAllocationId: conflict.conflictingAllocationId,
                conflictingOrderId: conflict.conflictingOrderId,
                conflictingReservationId: conflict.conflictingReservationId,
              },
            },
            tx,
          );
        }

        const flags = await this.refreshConflictFlags(tx, tenantId, conflict);
        const openConflictsRemaining = await tx.extensionConflict.count({
          where: { tenantId, orderId, status: 'OPEN' },
        });

        return {
          conflict: this.mapConflictRecord(resolved),
          hasOpenConflict: flags,
          openConflictsRemaining,
          alreadyResolved: conflict.status === 'RESOLVED',
        };
      },
    );
  }

  /**
   * Ringkasan operasional: order & reservasi ber-flag konflik beserta detail
   * konflik (termasuk yang sudah selesai bila filter=RESOLVED/ALL).
   * Hanya membaca; tidak pernah mengubah lifecycle. Kontrak data ini siap
   * dipakai konsumen frontend terpisah.
   */
  async getConflictOverview(
    tenantId: string,
    actorUserId: string,
    status: 'OPEN' | 'RESOLVED' | 'ALL' = 'OPEN',
  ) {
    await this.tenantService.requirePermission(tenantId, actorUserId, 'order.read');

    return this.prisma.withTenant(tenantId, async (tx) => {
      const conflicts = await tx.extensionConflict.findMany({
        where: { tenantId, ...(status === 'ALL' ? {} : { status }) },
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        take: 500,
      });

      const extensionRows = await tx.orderExtension.findMany({
        where: { tenantId, id: { in: [...new Set(conflicts.map((row) => row.extensionId))] } },
        include: { override: true },
      });
      const extensionById = new Map(extensionRows.map((row) => [row.id, row]));

      const orderIds = [
        ...new Set(
          conflicts
            .flatMap((row) => [row.orderId, row.conflictingOrderId])
            .filter((id): id is string => id !== null),
        ),
      ];
      const reservationIds = [
        ...new Set(
          conflicts
            .map((row) => row.conflictingReservationId)
            .filter((id): id is string => id !== null),
        ),
      ];

      const orders = await tx.rentalOrder.findMany({
        where: { tenantId, OR: [{ hasOpenConflict: true }, { id: { in: orderIds } }] },
        include: { customer: true },
        orderBy: [{ hasOpenConflict: 'desc' }, { updatedAt: 'desc' }],
        take: 200,
      });
      const reservations = await tx.reservation.findMany({
        where: { tenantId, OR: [{ hasOpenConflict: true }, { id: { in: reservationIds } }] },
        include: { customer: true },
        orderBy: [{ hasOpenConflict: 'desc' }, { updatedAt: 'desc' }],
        take: 200,
      });

      const openConflicts = await tx.extensionConflict.count({
        where: { tenantId, status: 'OPEN' },
      });
      const resolvedConflicts = await tx.extensionConflict.count({
        where: { tenantId, status: 'RESOLVED' },
      });
      const flaggedOrders = await tx.rentalOrder.count({
        where: { tenantId, hasOpenConflict: true },
      });
      const flaggedReservations = await tx.reservation.count({
        where: { tenantId, hasOpenConflict: true },
      });

      const orderConflicts = (orderId: string) =>
        conflicts.filter(
          (row) => row.orderId === orderId || row.conflictingOrderId === orderId,
        );

      return {
        generatedAt: new Date().toISOString(),
        filter: status,
        summary: { openConflicts, resolvedConflicts, flaggedOrders, flaggedReservations },
        orders: orders.map((order) => {
          const rows = orderConflicts(order.id);
          return {
            id: order.id,
            orderNumber: order.orderNumber,
            status: order.status,
            customerName: order.customer?.name ?? null,
            currency: order.currency,
            totalAmount: order.totalAmount.toString(),
            hasOpenConflict: order.hasOpenConflict,
            openConflictCount: rows.filter((row) => row.status === 'OPEN').length,
            conflicts: rows.map((row) =>
              this.mapOverviewConflict(row, extensionById.get(row.extensionId) ?? null),
            ),
            createdAt: order.createdAt,
            updatedAt: order.updatedAt,
          };
        }),
        reservations: reservations.map((reservation) => {
          const rows = conflicts.filter(
            (row) => row.conflictingReservationId === reservation.id,
          );
          return {
            id: reservation.id,
            status: reservation.status,
            customerName: reservation.customer?.name ?? null,
            startAt: reservation.startAt,
            endAt: reservation.endAt,
            hasOpenConflict: reservation.hasOpenConflict,
            openConflictCount: rows.filter((row) => row.status === 'OPEN').length,
            conflicts: rows.map((row) =>
              this.mapOverviewConflict(row, extensionById.get(row.extensionId) ?? null),
            ),
            createdAt: reservation.createdAt,
            updatedAt: reservation.updatedAt,
          };
        }),
      };
    });
  }

  // ============================================================
  // Konflik & alokasi
  // ============================================================

  /**
   * Hitung konflik server-side untuk periode [previousEndAt, requestedEndAt).
   * - Unit fisik: setiap alokasi ACTIVE yang overlap adalah konflik.
   * - Stok kuantitas: hanya menjadi konflik bila pemakaian puncak (termasuk
   *   periode tambahan) melebihi kapasitas produk.
   */
  private async computeConflicts(
    tx: Prisma.TransactionClient,
    tenantId: string,
    order: OrderRow,
    extension: ExtensionRow,
  ): Promise<ConflictCandidate[]> {
    const conflicts = new Map<string, ConflictCandidate>();
    const productIds = [...new Set(order.items.map((item) => item.productId))].sort();
    const products = await tx.product.findMany({
      where: { tenantId, id: { in: productIds } },
    });
    const productById = new Map(products.map((product) => [product.id, product]));

    for (const productId of productIds) {
      const product = productById.get(productId);
      if (!product) continue;
      const items = order.items.filter((item) => item.productId === productId);

      if (product.stockMode === 'INDIVIDUAL_UNITS') {
        for (const item of items) {
          if (!item.assetId) continue;
          const rows = await tx.reservationAllocation.findMany({
            where: {
              tenantId,
              assetId: item.assetId,
              status: 'ACTIVE',
              startAt: { lt: extension.requestedEndAt },
              endAt: { gt: extension.previousEndAt },
            },
            include: {
              reservation: { include: { customer: true, sourceOrder: true } },
            },
            orderBy: { startAt: 'asc' },
          });
          for (const row of rows) {
            conflicts.set(
              row.id,
              this.toConflict(row, product.id, product.name, 'ASSET_OVERLAP'),
            );
          }
        }
        continue;
      }

      // QUANTITY: cek kapasitas puncak pada rentang perpanjangan.
      const requestedQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
      const rows = await tx.reservationAllocation.findMany({
        where: {
          tenantId,
          productId,
          status: 'ACTIVE',
          startAt: { lt: extension.requestedEndAt },
          endAt: { gt: extension.previousEndAt },
        },
        include: {
          reservation: { include: { customer: true, sourceOrder: true } },
        },
        orderBy: { startAt: 'asc' },
      });
      const peak = this.peakUsage(
        [
          ...rows.map((row) => ({
            startAt: row.startAt,
            endAt: row.endAt,
            quantity: row.quantity,
          })),
          {
            startAt: extension.previousEndAt,
            endAt: extension.requestedEndAt,
            quantity: requestedQuantity,
          },
        ],
        extension.previousEndAt,
        extension.requestedEndAt,
      );
      if (peak <= product.capacity) continue;
      for (const row of rows) {
        conflicts.set(
          row.id,
          this.toConflict(row, product.id, product.name, 'CAPACITY_EXCEEDED'),
        );
      }
    }

    return [...conflicts.values()];
  }

  private peakUsage(
    intervals: { startAt: Date; endAt: Date; quantity: number }[],
    startAt: Date,
    endAt: Date,
  ): number {
    const points = new Set<number>([startAt.getTime()]);
    for (const interval of intervals) {
      if (interval.startAt >= startAt && interval.startAt < endAt) {
        points.add(interval.startAt.getTime());
      }
    }
    let peak = 0;
    for (const point of points) {
      let used = 0;
      for (const interval of intervals) {
        if (interval.startAt.getTime() <= point && interval.endAt.getTime() > point) {
          used += interval.quantity;
        }
      }
      if (used > peak) peak = used;
    }
    return peak;
  }

  private toConflict(
    row: AllocationWithContext,
    productId: string,
    productName: string,
    reason: ConflictCandidate['reason'],
  ): ConflictCandidate {
    const reservation = row.reservation;
    return {
      allocationId: row.id,
      reservationId: reservation?.id ?? null,
      orderId: reservation?.sourceOrder?.id ?? null,
      orderNumber: reservation?.sourceOrder?.orderNumber ?? null,
      customerName: reservation?.customer?.name ?? null,
      productId,
      productName,
      assetId: row.assetId,
      startAt: row.startAt,
      endAt: row.endAt,
      quantity: row.quantity,
      reason,
    };
  }

  /**
   * Buat alokasi periode tambahan. `overrideId` hanya diisi oleh command
   * override; trigger PostgreSQL memvalidasi bahwa setiap overlap tercatat.
   */
  private async allocateExtension(
    tx: Prisma.TransactionClient,
    tenantId: string,
    extension: ExtensionRow,
    order: OrderRow,
    overrideId: string | null,
  ): Promise<void> {
    const products = await tx.product.findMany({
      where: { tenantId, id: { in: [...new Set(order.items.map((i) => i.productId))] } },
    });
    const productById = new Map(products.map((product) => [product.id, product]));

    const quantityByProduct = new Map<string, number>();
    for (const item of order.items) {
      const product = productById.get(item.productId);
      if (!product) {
        throw new ApiError(ErrorCode.NOT_FOUND, 'Produk order tidak ditemukan.');
      }
      if (product.stockMode === 'INDIVIDUAL_UNITS' && item.assetId) {
        try {
          await tx.reservationAllocation.create({
            data: {
              tenantId,
              productId: item.productId,
              assetId: item.assetId,
              reservationId: order.sourceReservationId!,
              extensionId: extension.id,
              overrideId,
              quantity: 1,
              startAt: extension.previousEndAt,
              endAt: extension.requestedEndAt,
              status: 'ACTIVE',
            },
          });
        } catch (err) {
          this.rethrowAsConflict(err);
        }
      } else {
        quantityByProduct.set(
          item.productId,
          (quantityByProduct.get(item.productId) ?? 0) + item.quantity,
        );
      }
    }

    for (const [productId, quantity] of quantityByProduct) {
      try {
        await tx.reservationAllocation.create({
          data: {
            tenantId,
            productId,
            reservationId: order.sourceReservationId!,
            extensionId: extension.id,
            overrideId,
            quantity,
            startAt: extension.previousEndAt,
            endAt: extension.requestedEndAt,
            status: 'ACTIVE',
          },
        });
      } catch (err) {
        this.rethrowAsConflict(err);
      }
    }
  }

  /**
   * Dua command override paralel untuk extension yang SAMA: unique index
   * `extension_overrides_extensionId_key` menolak yang kedua.
   *
   * Tanpa pemetaan ini Prisma melempar P2002 mentah dan filter error
   * mengubahnya menjadi 500 INTERNAL_ERROR — padahal keputusan sejenis sudah
   * dibuat oleh permintaan lain dan klien cukup memuat ulang data.
   */
  private rethrowAsDecided(err: unknown): never {
    if ((err as { code?: string } | null)?.code === 'P2002') {
      throw new ApiError(
        ErrorCode.INVALID_STATE_TRANSITION,
        'Permintaan perpanjangan ini sudah diputuskan oleh permintaan lain; muat ulang data.',
      );
    }
    throw err;
  }

  /**
   * Trigger/exclusion PostgreSQL (23P01) → 409 AVAILABILITY_CONFLICT.
   * Ini menangkap balapan yang lolos dari pemeriksaan konflik awal.
   */
  private rethrowAsConflict(err: unknown): never {
    const code =
      (err as { code?: string; meta?: { code?: string } } | null)?.code ??
      (err as { meta?: { code?: string } } | null)?.meta?.code;
    const message = err instanceof Error ? err.message : '';
    if (code === '23P01' || message.includes('23P01')) {
      throw new ApiError(
        ErrorCode.AVAILABILITY_CONFLICT,
        'Periode perpanjangan bertabrakan dengan alokasi yang sudah ada; hitung ulang konflik dan ulangi keputusan.',
      );
    }
    throw err;
  }

  /**
   * Biaya perpanjangan dihitung server dari Rate per hari, dengan fallback
   * proporsional terhadap snapshot harga item. Harga dari client tidak dipakai.
   */
  private async computeExtensionAmount(
    tx: Prisma.TransactionClient,
    tenantId: string,
    order: OrderRow,
    requestedEndAt: Date,
  ): Promise<bigint> {
    const productIds = [...new Set(order.items.map((item) => item.productId))];
    const rates = await tx.rate.findMany({
      where: { tenantId, productId: { in: productIds } },
    });
    const rateByProduct = new Map(rates.map((rate) => [rate.productId, rate.perDayAmount]));

    let amount = 0n;
    for (const item of order.items) {
      if (item.endAt >= requestedEndAt) continue;
      const extraDays = BigInt(daysBetween(item.endAt, requestedEndAt));
      const originalDays = BigInt(daysBetween(item.startAt, item.endAt));
      const perDay =
        rateByProduct.get(item.productId) ?? item.priceSnapshot / (originalDays || 1n);
      amount += perDay * extraDays * BigInt(item.quantity);
    }
    return amount;
  }

  // ============================================================
  // Helpers: load, validasi, idempotency
  // ============================================================

  private async requireTenant(tx: Prisma.TransactionClient, tenantId: string) {
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new ApiError(ErrorCode.NOT_FOUND, 'Tenant tidak ditemukan.');
    return tenant;
  }

  private async requireOrder(
    tx: Prisma.TransactionClient,
    tenantId: string,
    orderId: string,
  ): Promise<OrderRow> {
    const order = await tx.rentalOrder.findUnique({
      where: { tenantId_id: { tenantId, id: orderId } },
      include: ORDER_INCLUDE,
    });
    if (!order) throw new ApiError(ErrorCode.NOT_FOUND, 'Order tidak ditemukan.');
    return order;
  }

  private assertExtendableOrder(order: OrderRow): void {
    if (order.items.length === 0) {
      throw new ApiError(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        'Order tidak memiliki item untuk diperpanjang.',
      );
    }
    if (order.status !== 'ACTIVE') {
      throw new ApiError(
        ErrorCode.INVALID_STATE_TRANSITION,
        `Order berstatus ${order.status} tidak dapat diperpanjang.`,
      );
    }
    if (!order.sourceReservationId) {
      throw new ApiError(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        'Order tanpa reservasi sumber belum mendukung perpanjangan.',
      );
    }
  }

  private async requireExtension(
    tx: Prisma.TransactionClient,
    tenantId: string,
    orderId: string,
    extensionId: string,
  ): Promise<ExtensionRow> {
    const row = await tx.orderExtension.findUnique({
      where: { tenantId_id: { tenantId, id: extensionId } },
      include: EXTENSION_INCLUDE,
    });
    if (!row || row.orderId !== orderId) {
      throw new ApiError(ErrorCode.NOT_FOUND, 'Permintaan perpanjangan tidak ditemukan.');
    }
    return row;
  }

  private async requireConflict(
    tx: Prisma.TransactionClient,
    tenantId: string,
    orderId: string,
    extensionId: string,
    conflictId: string,
  ): Promise<ConflictRow> {
    const row = await tx.extensionConflict.findFirst({
      where: { tenantId, id: conflictId },
    });
    if (!row || row.extensionId !== extensionId || row.orderId !== orderId) {
      throw new ApiError(ErrorCode.NOT_FOUND, 'Konflik perpanjangan tidak ditemukan.');
    }
    return row;
  }

  /**
   * Hitung ulang flag operasional dari konflik OPEN yang tersisa. Order X
   * ber-flag bila X adalah order perpanjangan atau order yang bertabrakan.
   * Reservasi ber-flag bila menjadi booking yang bertabrakan.
   */
  private async refreshConflictFlags(
    tx: Prisma.TransactionClient,
    tenantId: string,
    conflict: ConflictRow,
  ): Promise<{
    orders: { id: string; hasOpenConflict: boolean; openConflicts: number }[];
    reservation: { id: string; hasOpenConflict: boolean; openConflicts: number } | null;
  }> {
    const orderIds = [
      ...new Set(
        [conflict.orderId, conflict.conflictingOrderId].filter(
          (id): id is string => id !== null,
        ),
      ),
    ];
    const orders: { id: string; hasOpenConflict: boolean; openConflicts: number }[] = [];
    for (const id of orderIds) {
      const openConflicts = await tx.extensionConflict.count({
        where: { tenantId, status: 'OPEN', OR: [{ orderId: id }, { conflictingOrderId: id }] },
      });
      await tx.rentalOrder.updateMany({
        where: { tenantId, id },
        data: { hasOpenConflict: openConflicts > 0 },
      });
      orders.push({ id, hasOpenConflict: openConflicts > 0, openConflicts });
    }

    let reservation: { id: string; hasOpenConflict: boolean; openConflicts: number } | null =
      null;
    if (conflict.conflictingReservationId) {
      const id = conflict.conflictingReservationId;
      const openConflicts = await tx.extensionConflict.count({
        where: { tenantId, status: 'OPEN', conflictingReservationId: id },
      });
      await tx.reservation.updateMany({
        where: { tenantId, id },
        data: { hasOpenConflict: openConflicts > 0 },
      });
      reservation = { id, hasOpenConflict: openConflicts > 0, openConflicts };
    }

    return { orders, reservation };
  }

  private async requirePendingExtension(
    tx: Prisma.TransactionClient,
    tenantId: string,
    orderId: string,
    extensionId: string,
  ): Promise<ExtensionRow> {
    const row = await this.requireExtension(tx, tenantId, orderId, extensionId);
    if (row.status !== 'PENDING_APPROVAL') {
      throw new ApiError(
        ErrorCode.INVALID_STATE_TRANSITION,
        `Permintaan perpanjangan berstatus ${row.status} tidak dapat diproses.`,
      );
    }
    return row;
  }

  private mapExtension(row: ExtensionRow) {
    return {
      id: row.id,
      orderId: row.orderId,
      status: row.status,
      previousEndAt: row.previousEndAt,
      requestedEndAt: row.requestedEndAt,
      amount: row.amount.toString(),
      currency: row.currency,
      requestedByUserId: row.requestedByUserId,
      decidedByUserId: row.decidedByUserId,
      decidedAt: row.decidedAt,
      decisionReason: row.decisionReason,
      override: row.override ? this.mapOverride(row.override) : null,
      conflicts: row.conflicts.map((conflict) => ({
        ...this.mapTask(conflict),
        summary: conflict.summary ?? null,
      })),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private mapOverride(row: OverrideRow) {
    return {
      id: row.id,
      policy: row.policy,
      reason: row.reason,
      riskAcknowledgedAt: row.riskAcknowledgedAt,
      actorUserId: row.actorUserId,
      previousEndAt: row.previousEndAt,
      requestedEndAt: row.requestedEndAt,
      amountSnapshot: row.amountSnapshot.toString(),
      currency: row.currency,
      conflictCount: row.conflictCount,
      createdAt: row.createdAt,
    };
  }

  private mapConflictRecord(row: ConflictRow) {
    return {
      id: row.id,
      extensionId: row.extensionId,
      orderId: row.orderId,
      status: row.status,
      conflictingAllocationId: row.conflictingAllocationId,
      conflictingReservationId: row.conflictingReservationId,
      conflictingOrderId: row.conflictingOrderId,
      summary: row.summary ?? null,
      resolvedAt: row.resolvedAt,
      resolvedByUserId: row.resolvedByUserId,
      resolutionNote: row.resolutionNote,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private mapOverviewConflict(row: ConflictRow, extension: ExtensionWithOverride | null) {
    return {
      ...this.mapConflictRecord(row),
      extension: extension
        ? {
            id: extension.id,
            orderId: extension.orderId,
            status: extension.status,
            previousEndAt: extension.previousEndAt,
            requestedEndAt: extension.requestedEndAt,
            overrideReason: extension.override?.reason ?? null,
          }
        : null,
    };
  }

  private mapTask(row: ConflictRow) {
    return {
      id: row.id,
      status: row.status,
      conflictingAllocationId: row.conflictingAllocationId,
      conflictingReservationId: row.conflictingReservationId,
      conflictingOrderId: row.conflictingOrderId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private mapConflictCandidate(conflict: ConflictCandidate) {
    return {
      allocationId: conflict.allocationId,
      reservationId: conflict.reservationId,
      orderId: conflict.orderId,
      orderNumber: conflict.orderNumber,
      customerName: conflict.customerName,
      productId: conflict.productId,
      productName: conflict.productName,
      assetId: conflict.assetId,
      startAt: conflict.startAt.toISOString(),
      endAt: conflict.endAt.toISOString(),
      quantity: conflict.quantity,
      reason: conflict.reason,
    };
  }

  private async runIdempotent<T>(
    tenantId: string,
    scope: string,
    ctx: Ctx,
    payload: Record<string, unknown>,
    produce: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const key = ctx.idempotencyKey;
    if (!key) return this.prisma.withTenant(tenantId, produce);
    const fingerprint = hashToken(JSON.stringify({ op: scope, tenantId, ...payload }));

    try {
      return await this.prisma.withTenant(tenantId, async (tx) => {
        const existing = await tx.idempotencyRecord.findUnique({
          where: { tenantId_scope_key: { tenantId, scope, key } },
        });
        if (existing) return this.replayRecord(existing, fingerprint);

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
