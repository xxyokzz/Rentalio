import { Injectable } from '@nestjs/common';
import type { Prisma } from '@rentalio/database';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { TenantService } from '../tenant/tenant.service.js';
import { ApiError, ErrorCode } from '../common/errors.js';
import type {
  CancelReturnDto,
  CompleteReturnDto,
  CreateInspectionDto,
  CreateReturnDto,
  DecideInspectionDto,
  SubmitInspectionDto,
} from './returns.dto.js';
import { InspectionDecisionDto } from './returns.dto.js';
import { computeLateFee, type LateFeePolicy } from './late-fee.js';

type Ctx = { actorUserId: string; correlationId: string };

type ReturnWithItems = Prisma.ReturnRecordGetPayload<{ include: { items: true } }>;
type InspectionWithAttachments = Prisma.InspectionGetPayload<{
  include: { attachments: true };
}>;

const READ_ROLES = ['OWNER', 'MANAGER', 'STAFF', 'CASHIER'];
const WRITE_ROLES = ['OWNER', 'MANAGER', 'STAFF'];
const DECIDE_ROLES = ['OWNER', 'MANAGER'];

/**
 * Return & Inspection — ADR-001 §5.
 *
 * Aturan yang ditegakkan di service (bukan hanya di controller):
 * - Return hanya untuk order yang ada di tenant aktif (RLS + lookup komposit).
 * - Jumlah yang dikembalikan tidak boleh melebihi jumlah yang disewa,
 *   dihitung terhadap seluruh return non-CANCELLED pada order tersebut.
 * - Satu unit fisik hanya boleh muncul pada satu return aktif per order.
 * - Transisi status eksplisit: PENDING→COMPLETED|CANCELLED,
 *   DRAFT→SUBMITTED→APPROVED|REJECTED.
 * - Inspeksi hanya dapat dikaitkan ke return COMPLETED pada order yang sama.
 */
@Injectable()
export class ReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tenantService: TenantService,
  ) {}

  // ============================================================
  // Return records
  // ============================================================

  async listReturns(tenantId: string, orderId: string, actorUserId: string) {
    await this.tenantService.requireMembership(tenantId, actorUserId, READ_ROLES);
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.requireOrder(tx, tenantId, orderId);
      const rows = await tx.returnRecord.findMany({
        where: { tenantId, orderId },
        include: { items: true },
        orderBy: { createdAt: 'desc' },
      });
      const lateFee = await this.lateFeeContext(tx, tenantId, orderId);
      return rows.map((row) =>
        this.mapReturn(row, computeLateFee(lateFee.policy, lateFee.dueAt, row.returnedAt)),
      );
    });
  }

  async getReturn(tenantId: string, returnId: string, actorUserId: string) {
    await this.tenantService.requireMembership(tenantId, actorUserId, READ_ROLES);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const row = await tx.returnRecord.findUnique({
        where: { tenantId_id: { tenantId, id: returnId } },
        include: {
          items: true,
          inspections: { select: { id: true, status: true, createdAt: true } },
        },
      });
      if (!row) throw new ApiError(ErrorCode.NOT_FOUND, 'Return record tidak ditemukan.');
      const lateFee = await this.lateFeeContext(tx, tenantId, row.orderId);
      return {
        ...this.mapReturn(row, computeLateFee(lateFee.policy, lateFee.dueAt, row.returnedAt)),
        inspections: row.inspections.map((i) => ({
          id: i.id,
          status: i.status,
          createdAt: i.createdAt,
        })),
      };
    });
  }

  async createReturn(
    tenantId: string,
    orderId: string,
    dto: CreateReturnDto,
    ctx: Ctx,
  ) {
    await this.tenantService.requireMembership(tenantId, ctx.actorUserId, WRITE_ROLES);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const order = await this.requireOrder(tx, tenantId, orderId);
      await this.validateReturnItems(tx, tenantId, orderId, dto);

      // ADR-001 §3: pencatatan return memulai RETURN_IN_PROGRESS dari ACTIVE.
      // Order berstatus lain (mis. CONFIRMED pada fixture lama) dibiarkan:
      // transisi order hanya lewat command eksplisit di modul order.
      if (order.status === 'ACTIVE') {
        await tx.rentalOrder.update({
          where: { tenantId_id: { tenantId, id: orderId } },
          data: { status: 'RETURN_IN_PROGRESS' },
        });
      }

      const record = await tx.returnRecord.create({
        data: {
          tenantId,
          orderId,
          notes: dto.notes?.trim() ?? null,
        },
      });
      // Item ditulis terpisah (createMany) karena foreign key gabungan
      // (tenantId + relasi) tidak dapat diisi sebagai skalar pada nested create.
      await tx.returnItem.createMany({
        data: dto.items.map((item) => ({
          tenantId,
          returnRecordId: record.id,
          productId: item.productId,
          assetId: item.assetId ?? null,
          quantity: item.quantity,
          conditionNote: item.conditionNote?.trim() ?? null,
        })),
      });
      const created = await tx.returnRecord.findUniqueOrThrow({
        where: { tenantId_id: { tenantId, id: record.id } },
        include: { items: true },
      });

      await this.audit.record(
        {
          tenantId,
          actorUserId: ctx.actorUserId,
          action: 'RETURN_CREATED',
          domain: 'returns',
          entityType: 'return_record',
          entityId: created.id,
          toState: created.status,
          correlationId: ctx.correlationId,
          metadata: {
            orderId,
            itemCount: created.items.length,
            totalQuantity: created.items.reduce((sum, i) => sum + i.quantity, 0),
          },
        },
        tx,
      );

      const lateFee = await this.lateFeeContext(tx, tenantId, orderId);
      return this.mapReturn(
        created,
        computeLateFee(lateFee.policy, lateFee.dueAt, created.returnedAt),
      );
    });
  }

  async completeReturn(
    tenantId: string,
    returnId: string,
    dto: CompleteReturnDto,
    ctx: Ctx,
  ) {
    await this.tenantService.requireMembership(tenantId, ctx.actorUserId, WRITE_ROLES);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const existing = await tx.returnRecord.findUnique({
        where: { tenantId_id: { tenantId, id: returnId } },
        include: { items: true },
      });
      if (!existing) throw new ApiError(ErrorCode.NOT_FOUND, 'Return record tidak ditemukan.');
      if (existing.status !== 'PENDING') {
        throw new ApiError(
          ErrorCode.INVALID_STATE_TRANSITION,
          `Return berstatus ${existing.status} tidak dapat diselesaikan.`,
        );
      }

      const receivedAt = dto.receivedAt ? new Date(dto.receivedAt) : new Date();
      const updated = await tx.returnRecord.update({
        where: { id: returnId },
        data: {
          status: 'COMPLETED',
          returnedAt: receivedAt,
          receivedByUserId: ctx.actorUserId,
          ...(dto.notes !== undefined && { notes: dto.notes?.trim() ?? null }),
        },
        include: { items: true },
      });

      // Unit fisik kembali tersedia, kecuali yang memang ditandai rusak/maintenance.
      const assetIds = updated.items
        .map((i) => i.assetId)
        .filter((id): id is string => id !== null);
      if (assetIds.length > 0) {
        await tx.asset.updateMany({
          where: { tenantId, id: { in: assetIds }, status: 'RESERVED' },
          data: { status: 'AVAILABLE' },
        });
      }

      await this.audit.record(
        {
          tenantId,
          actorUserId: ctx.actorUserId,
          action: 'RETURN_COMPLETED',
          domain: 'returns',
          entityType: 'return_record',
          entityId: returnId,
          fromState: existing.status,
          toState: updated.status,
          correlationId: ctx.correlationId,
          metadata: { orderId: existing.orderId, returnedAt: receivedAt.toISOString() },
        },
        tx,
      );

      const lateFee = await this.lateFeeContext(tx, tenantId, existing.orderId);
      return this.mapReturn(
        updated,
        computeLateFee(lateFee.policy, lateFee.dueAt, updated.returnedAt),
      );
    });
  }

  async cancelReturn(
    tenantId: string,
    returnId: string,
    dto: CancelReturnDto,
    ctx: Ctx,
  ) {
    await this.tenantService.requireMembership(tenantId, ctx.actorUserId, ['OWNER', 'MANAGER']);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const existing = await tx.returnRecord.findUnique({
        where: { tenantId_id: { tenantId, id: returnId } },
        include: { items: true },
      });
      if (!existing) throw new ApiError(ErrorCode.NOT_FOUND, 'Return record tidak ditemukan.');
      if (existing.status !== 'PENDING') {
        throw new ApiError(
          ErrorCode.INVALID_STATE_TRANSITION,
          `Return berstatus ${existing.status} tidak dapat dibatalkan.`,
        );
      }

      const reason = dto.reason?.trim();
      const updated = await tx.returnRecord.update({
        where: { id: returnId },
        data: {
          status: 'CANCELLED',
          ...(reason && { notes: reason }),
        },
        include: { items: true },
      });

      await this.audit.record(
        {
          tenantId,
          actorUserId: ctx.actorUserId,
          action: 'RETURN_CANCELLED',
          domain: 'returns',
          entityType: 'return_record',
          entityId: returnId,
          fromState: existing.status,
          toState: updated.status,
          reason,
          correlationId: ctx.correlationId,
          metadata: { orderId: existing.orderId },
        },
        tx,
      );

      const lateFee = await this.lateFeeContext(tx, tenantId, existing.orderId);
      return this.mapReturn(
        updated,
        computeLateFee(lateFee.policy, lateFee.dueAt, updated.returnedAt),
      );
    });
  }

  // ============================================================
  // Inspections
  // ============================================================

  async listInspections(tenantId: string, orderId: string, actorUserId: string) {
    await this.tenantService.requireMembership(tenantId, actorUserId, READ_ROLES);
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.requireOrder(tx, tenantId, orderId);
      const rows = await tx.inspection.findMany({
        where: { tenantId, orderId },
        include: { attachments: true },
        orderBy: { createdAt: 'desc' },
      });
      return rows.map((row) => this.mapInspection(row));
    });
  }

  async getInspection(tenantId: string, inspectionId: string, actorUserId: string) {
    await this.tenantService.requireMembership(tenantId, actorUserId, READ_ROLES);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const row = await tx.inspection.findUnique({
        where: { tenantId_id: { tenantId, id: inspectionId } },
        include: { attachments: true },
      });
      if (!row) throw new ApiError(ErrorCode.NOT_FOUND, 'Inspeksi tidak ditemukan.');
      return this.mapInspection(row);
    });
  }

  async createInspection(
    tenantId: string,
    orderId: string,
    dto: CreateInspectionDto,
    ctx: Ctx,
  ) {
    await this.tenantService.requireMembership(tenantId, ctx.actorUserId, WRITE_ROLES);
    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.requireOrder(tx, tenantId, orderId);

      let returnRecordId: string | null = null;
      if (dto.returnRecordId) {
        const returnRecord = await tx.returnRecord.findUnique({
          where: { tenantId_id: { tenantId, id: dto.returnRecordId } },
        });
        if (!returnRecord || returnRecord.orderId !== orderId) {
          throw new ApiError(
            ErrorCode.NOT_FOUND,
            'Return record tidak ditemukan pada order ini.',
          );
        }
        if (returnRecord.status !== 'COMPLETED') {
          throw new ApiError(
            ErrorCode.INVALID_STATE_TRANSITION,
            'Inspeksi hanya dapat dibuat setelah pengembalian diselesaikan.',
          );
        }
        const active = await tx.inspection.findFirst({
          where: {
            tenantId,
            returnRecordId: dto.returnRecordId,
            status: { in: ['DRAFT', 'SUBMITTED'] },
          },
        });
        if (active) {
          throw new ApiError(
            ErrorCode.BUSINESS_RULE_VIOLATION,
            'Return record ini sudah memiliki inspeksi aktif.',
          );
        }
        returnRecordId = dto.returnRecordId;
      }

      const created = await tx.inspection.create({
        data: {
          tenantId,
          orderId,
          returnRecordId,
          summary: dto.summary?.trim() ?? null,
          inspectedByUserId: ctx.actorUserId,
        },
        include: { attachments: true },
      });

      await this.audit.record(
        {
          tenantId,
          actorUserId: ctx.actorUserId,
          action: 'INSPECTION_CREATED',
          domain: 'returns',
          entityType: 'inspection',
          entityId: created.id,
          toState: created.status,
          correlationId: ctx.correlationId,
          metadata: { orderId, returnRecordId },
        },
        tx,
      );

      return this.mapInspection(created);
    });
  }

  async submitInspection(
    tenantId: string,
    inspectionId: string,
    dto: SubmitInspectionDto,
    ctx: Ctx,
  ) {
    await this.tenantService.requireMembership(tenantId, ctx.actorUserId, WRITE_ROLES);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const existing = await tx.inspection.findUnique({
        where: { tenantId_id: { tenantId, id: inspectionId } },
      });
      if (!existing) throw new ApiError(ErrorCode.NOT_FOUND, 'Inspeksi tidak ditemukan.');
      if (existing.status !== 'DRAFT') {
        throw new ApiError(
          ErrorCode.INVALID_STATE_TRANSITION,
          `Inspeksi berstatus ${existing.status} tidak dapat diajukan.`,
        );
      }

      const now = new Date();
      const updated = await tx.inspection.update({
        where: { id: inspectionId },
        data: {
          status: 'SUBMITTED',
          submittedAt: now,
          inspectedAt: existing.inspectedAt ?? now,
          inspectedByUserId: existing.inspectedByUserId ?? ctx.actorUserId,
          ...(dto.summary !== undefined && { summary: dto.summary?.trim() ?? null }),
          ...(dto.penaltyAmount !== undefined && {
            penaltyAmount: BigInt(dto.penaltyAmount),
          }),
        },
        include: { attachments: true },
      });

      await this.audit.record(
        {
          tenantId,
          actorUserId: ctx.actorUserId,
          action: 'INSPECTION_SUBMITTED',
          domain: 'returns',
          entityType: 'inspection',
          entityId: inspectionId,
          fromState: existing.status,
          toState: updated.status,
          correlationId: ctx.correlationId,
          metadata: { orderId: existing.orderId },
        },
        tx,
      );

      return this.mapInspection(updated);
    });
  }

  async decideInspection(
    tenantId: string,
    inspectionId: string,
    dto: DecideInspectionDto,
    ctx: Ctx,
  ) {
    await this.tenantService.requireMembership(tenantId, ctx.actorUserId, DECIDE_ROLES);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const existing = await tx.inspection.findUnique({
        where: { tenantId_id: { tenantId, id: inspectionId } },
      });
      if (!existing) throw new ApiError(ErrorCode.NOT_FOUND, 'Inspeksi tidak ditemukan.');
      if (existing.status !== 'SUBMITTED') {
        throw new ApiError(
          ErrorCode.INVALID_STATE_TRANSITION,
          `Inspeksi berstatus ${existing.status} belum dapat diputuskan.`,
        );
      }

      if (dto.decision === InspectionDecisionDto.APPROVE && dto.penaltyAmount === undefined) {
        throw new ApiError(
          ErrorCode.VALIDATION_ERROR,
          'penaltyAmount wajib diisi untuk keputusan APPROVE.',
        );
      }

      const approve = dto.decision === InspectionDecisionDto.APPROVE;
      const updated = await tx.inspection.update({
        where: { id: inspectionId },
        data: {
          status: approve ? 'APPROVED' : 'REJECTED',
          approvedByUserId: ctx.actorUserId,
          decidedAt: new Date(),
          penaltyAmount: approve ? BigInt(dto.penaltyAmount ?? 0) : null,
          ...(dto.summary !== undefined && { summary: dto.summary?.trim() ?? null }),
        },
        include: { attachments: true },
      });

      await this.audit.record(
        {
          tenantId,
          actorUserId: ctx.actorUserId,
          action: 'INSPECTION_DECIDED',
          domain: 'returns',
          entityType: 'inspection',
          entityId: inspectionId,
          fromState: existing.status,
          toState: updated.status,
          correlationId: ctx.correlationId,
          metadata: {
            orderId: existing.orderId,
            decision: dto.decision,
            penaltyAmount: dto.penaltyAmount ?? null,
          },
        },
        tx,
      );

      return this.mapInspection(updated);
    });
  }

  // ============================================================
  // Helpers
  // ============================================================

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

  /**
   * Validasi item return terhadap isi order dan return sebelumnya.
   * Semua query berjalan di dalam transaksi dengan konteks tenant (RLS).
   */
  private async validateReturnItems(
    tx: Prisma.TransactionClient,
    tenantId: string,
    orderId: string,
    dto: CreateReturnDto,
  ): Promise<void> {
    // 1. Validasi struktural unit fisik lebih dahulu: duplikasi, keberadaan,
    //    kepemilikan produk, dan quantity per unit (satu baris = satu unit).
    const assetIds = [
      ...new Set(
        dto.items
          .map((item) => item.assetId)
          .filter((id): id is string => typeof id === 'string'),
      ),
    ];
    if (assetIds.length !== dto.items.filter((i) => i.assetId).length) {
      throw new ApiError(
        ErrorCode.VALIDATION_ERROR,
        'Satu unit fisik tidak boleh muncul lebih dari sekali dalam satu pengembalian.',
      );
    }

    if (assetIds.length > 0) {
      const assets = await tx.asset.findMany({
        where: { tenantId, id: { in: assetIds } },
      });
      const assetById = new Map(assets.map((asset) => [asset.id, asset]));

      for (const item of dto.items) {
        if (!item.assetId) continue;
        const asset = assetById.get(item.assetId);
        if (!asset) throw new ApiError(ErrorCode.NOT_FOUND, 'Asset tidak ditemukan.');
        if (asset.productId !== item.productId) {
          throw new ApiError(
            ErrorCode.BUSINESS_RULE_VIOLATION,
            'Asset tidak termasuk produk yang dikembalikan.',
          );
        }
        if (item.quantity !== 1) {
          throw new ApiError(
            ErrorCode.BUSINESS_RULE_VIOLATION,
            'Item dengan assetId harus memiliki quantity 1 (satu unit fisik per baris).',
          );
        }
      }
    }

    // 2. Validasi jumlah kumulatif terhadap isi order dan return sebelumnya.
    const orderItems = await tx.rentalItem.findMany({ where: { tenantId, orderId } });
    const orderedByProduct = new Map<string, number>();
    for (const item of orderItems) {
      orderedByProduct.set(
        item.productId,
        (orderedByProduct.get(item.productId) ?? 0) + item.quantity,
      );
    }

    const requestedByProduct = new Map<string, number>();
    for (const item of dto.items) {
      requestedByProduct.set(
        item.productId,
        (requestedByProduct.get(item.productId) ?? 0) + item.quantity,
      );
    }

    const priorRows = await tx.returnItem.groupBy({
      by: ['productId'],
      where: {
        tenantId,
        returnRecord: { orderId, status: { not: 'CANCELLED' } },
      },
      _sum: { quantity: true },
    });
    const priorByProduct = new Map<string, number>(
      priorRows.map((row) => [row.productId, row._sum.quantity ?? 0]),
    );

    for (const [productId, quantity] of requestedByProduct) {
      const ordered = orderedByProduct.get(productId) ?? 0;
      if (ordered === 0) {
        throw new ApiError(
          ErrorCode.BUSINESS_RULE_VIOLATION,
          'Produk yang dikembalikan bukan bagian dari order ini.',
        );
      }
      const alreadyReturned = priorByProduct.get(productId) ?? 0;
      if (alreadyReturned + quantity > ordered) {
        throw new ApiError(
          ErrorCode.BUSINESS_RULE_VIOLATION,
          'Jumlah pengembalian melebihi jumlah yang disewa pada order ini.',
        );
      }
    }

    if (assetIds.length === 0) return;

    // 3. Unit fisik yang sama tidak boleh dikembalikan dua kali pada order ini.
    const usedAssets = await tx.returnItem.findMany({
      where: {
        tenantId,
        assetId: { in: assetIds },
        returnRecord: { orderId, status: { not: 'CANCELLED' } },
      },
      select: { assetId: true },
    });
    if (usedAssets.length > 0) {
      throw new ApiError(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        'Asset sudah tercatat pada pengembalian lain untuk order ini.',
      );
    }
  }

  /**
   * Konfigurasi denda tenant + batas waktu order (endAt item terakhir).
   * Dihitung dari data server supaya klien tidak bisa mengarang nominal.
   */
  private async lateFeeContext(
    tx: Prisma.TransactionClient,
    tenantId: string,
    orderId: string,
  ): Promise<{ policy: LateFeePolicy; dueAt: Date | null }> {
    const [tenant, lastItem] = await Promise.all([
      tx.tenant.findUnique({
        where: { id: tenantId },
        select: { lateFeeEnabled: true, lateFeeUnit: true, lateFeeRateAmount: true },
      }),
      tx.rentalItem.findFirst({
        where: { tenantId, orderId },
        orderBy: { endAt: 'desc' },
        select: { endAt: true },
      }),
    ]);
    return {
      policy: {
        enabled: tenant?.lateFeeEnabled ?? false,
        unit: (tenant?.lateFeeUnit ?? 'DAY') as LateFeePolicy['unit'],
        rateAmount: tenant?.lateFeeRateAmount ?? 0n,
      },
      dueAt: lastItem?.endAt ?? null,
    };
  }

  private mapReturn(row: ReturnWithItems, lateFee: ReturnType<typeof computeLateFee>) {
    return {
      id: row.id,
      orderId: row.orderId,
      status: row.status,
      returnedAt: row.returnedAt,
      receivedByUserId: row.receivedByUserId,
      notes: row.notes,
      lateFee,
      items: row.items.map((item) => ({
        id: item.id,
        productId: item.productId,
        assetId: item.assetId,
        quantity: item.quantity,
        conditionNote: item.conditionNote,
      })),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private mapInspection(row: InspectionWithAttachments) {
    return {
      id: row.id,
      orderId: row.orderId,
      returnRecordId: row.returnRecordId,
      status: row.status,
      inspectedByUserId: row.inspectedByUserId,
      approvedByUserId: row.approvedByUserId,
      summary: row.summary,
      penaltyAmount: row.penaltyAmount?.toString() ?? null,
      currency: row.currency,
      inspectedAt: row.inspectedAt,
      submittedAt: row.submittedAt,
      decidedAt: row.decidedAt,
      attachments: row.attachments.map((attachment) => ({
        id: attachment.id,
        objectKey: attachment.objectKey,
        mimeType: attachment.mimeType,
        fileSizeBytes: attachment.fileSizeBytes,
        altText: attachment.altText,
        sortOrder: attachment.sortOrder,
        uploadedAt: attachment.uploadedAt,
      })),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
