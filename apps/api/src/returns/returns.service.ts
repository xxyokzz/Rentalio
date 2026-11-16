import { Injectable } from '@nestjs/common';
import type { Prisma } from '@rentalio/database';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { TenantService } from '../tenant/tenant.service.js';
import { ApiError, ErrorCode } from '../common/errors.js';
import type {
  CancelReturnDto,
  CompleteReturnDto,
  CreateInspectionAttachmentDto,
  CreateInspectionDto,
  CreateReturnDto,
  DecideInspectionDto,
  SubmitInspectionDto,
} from './returns.dto.js';
import { InspectionDecisionDto } from './returns.dto.js';
import { computeLateFee, type LateFeePolicy } from './late-fee.js';
import {
  amountsForCategory,
  computeDamageFee,
  computeDamageFeeForLines,
  parseDamagePolicy,
  serializeDamagePolicy,
  DAMAGE_SEVERITIES,
  DAMAGE_SEVERITY_LABEL,
  type DamageAmounts,
  type DamageFeePolicy,
  type DamageSeverity,
  type DamageSuggestionLine,
} from './damage-fee.js';

type Ctx = { actorUserId: string; correlationId: string };

type ReturnWithItems = Prisma.ReturnRecordGetPayload<{ include: { items: true } }>;
type InspectionWithAttachments = Prisma.InspectionGetPayload<{
  include: { attachments: true; items: true };
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
        include: { attachments: true, items: { orderBy: { createdAt: 'asc' } } },
        orderBy: { createdAt: 'desc' },
      });
      return Promise.all(
        rows.map(async (row) =>
          this.mapInspection(row, await this.lateFeeForInspection(tx, tenantId, row)),
        ),
      );
    });
  }

  async getInspection(tenantId: string, inspectionId: string, actorUserId: string) {
    await this.tenantService.requireMembership(tenantId, actorUserId, READ_ROLES);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const row = await tx.inspection.findUnique({
        where: { tenantId_id: { tenantId, id: inspectionId } },
        include: { attachments: true, items: { orderBy: { createdAt: 'asc' } } },
      });
      if (!row) throw new ApiError(ErrorCode.NOT_FOUND, 'Inspeksi tidak ditemukan.');
      return this.mapInspection(row, await this.lateFeeForInspection(tx, tenantId, row));
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

      // Saklar inspeksi dimiliki tenant; service menolak lebih dulu agar klien
      // tidak bisa membuat inspeksi pada tenant yang mematikannya.
      const damagePolicy = await this.damageFeeContext(tx, tenantId);
      if (!damagePolicy.inspectionEnabled) {
        throw new ApiError(
          ErrorCode.BUSINESS_RULE_VIOLATION,
          'Inspeksi kerusakan dinonaktifkan untuk toko ini.',
        );
      }

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
        returnRecordId = dto.returnRecordId;
      }

      // Satu order hanya boleh punya satu inspeksi aktif: dua keputusan denda
      // untuk order yang sama akan membingungkan dan berisiko menagih ganda.
      const active = await tx.inspection.findFirst({
        where: { tenantId, orderId, status: { in: ['DRAFT', 'SUBMITTED'] } },
      });
      if (active) {
        throw new ApiError(
          ErrorCode.BUSINESS_RULE_VIOLATION,
          'Order ini sudah memiliki inspeksi aktif. Selesaikan atau tolak inspeksi tersebut lebih dulu.',
        );
      }

      // Snapshot konfigurasi saat inspeksi dibuat: perubahan nominal denda
      // setelah ini tidak boleh menulis ulang usulan inspeksi yang berjalan.
      const snapshot = serializeDamagePolicy(damagePolicy.policy);
      const prepared = dto.items?.length
        ? await this.prepareInspectionItems(tx, tenantId, orderId, damagePolicy.policy, dto.items)
        : null;
      const severity =
        (dto.severity as DamageSeverity | undefined) ??
        (prepared ? this.worstSeverity(prepared.severities) : null);
      const suggestion = prepared
        ? computeDamageFeeForLines(damagePolicy.policy, prepared.lines)
        : computeDamageFee(damagePolicy.policy, severity);

      const created = await tx.inspection.create({
        data: {
          tenantId,
          orderId,
          returnRecordId,
          summary: dto.summary?.trim() ?? null,
          inspectedByUserId: ctx.actorUserId,
          severity,
          damagePolicySnapshot: snapshot as unknown as Prisma.InputJsonValue,
          suggestedPenaltyAmount: suggestion.amount ? BigInt(suggestion.amount) : null,
        },
        include: { attachments: true, items: true },
      });
      if (prepared) {
        await tx.inspectionItem.createMany({
          data: prepared.rows.map((row) => ({ tenantId, inspectionId: created.id, ...row })),
        });
      }

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
          metadata: {
            orderId,
            returnRecordId,
            severity,
            damageFeeEnabled: damagePolicy.policy.enabled,
            suggestedPenaltyAmount: suggestion.amount,
            suggestedRawAmount: suggestion.rawAmount,
            capped: suggestion.capped,
            itemCount: prepared?.rows.length ?? 0,
          },
        },
        tx,
      );

      const reloaded = await tx.inspection.findUniqueOrThrow({
        where: { tenantId_id: { tenantId, id: created.id } },
        include: { attachments: true, items: { orderBy: { createdAt: 'asc' } } },
      });
      return this.mapInspection(
        reloaded,
        await this.lateFeeForInspection(tx, tenantId, reloaded),
      );
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
      // Usulan dihitung dari SNAPSHOT inspeksi (bukan konfigurasi tenant saat
      // ini), sehingga inspeksi lama tidak berubah saat owner mengganti nominal.
      const policy = parseDamagePolicy(existing.damagePolicySnapshot);
      // Rincian per item boleh diganti selama masih DRAFT. Usulan dihitung dari
      // snapshot, bukan dari tarif tenant yang berlaku sekarang.
      const prepared = dto.items?.length
        ? await this.prepareInspectionItems(
            tx,
            tenantId,
            existing.orderId,
            policy,
            dto.items,
          )
        : null;
      if (prepared) {
        await tx.inspectionItem.deleteMany({ where: { tenantId, inspectionId } });
        await tx.inspectionItem.createMany({
          data: prepared.rows.map((row) => ({ tenantId, inspectionId, ...row })),
        });
      }
      const severity = (dto.severity ??
        (prepared ? this.worstSeverity(prepared.severities) : existing.severity) ??
        null) as DamageSeverity | null;
      const suggestion = prepared
        ? computeDamageFeeForLines(policy, prepared.lines)
        : computeDamageFee(policy, severity);

      const updated = await tx.inspection.update({
        where: { id: inspectionId },
        data: {
          status: 'SUBMITTED',
          submittedAt: now,
          inspectedAt: existing.inspectedAt ?? now,
          inspectedByUserId: existing.inspectedByUserId ?? ctx.actorUserId,
          ...(dto.summary !== undefined && { summary: dto.summary?.trim() ?? null }),
          ...(severity !== null && { severity }),
          suggestedPenaltyAmount: suggestion.amount ? BigInt(suggestion.amount) : null,
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
          metadata: {
            orderId: existing.orderId,
            severity,
            suggestedPenaltyAmount: suggestion.amount,
            suggestedRawAmount: suggestion.rawAmount,
            capped: suggestion.capped,
            itemCount: prepared?.rows.length ?? 0,
          },
        },
        tx,
      );

      const reloaded = await tx.inspection.findUniqueOrThrow({
        where: { tenantId_id: { tenantId, id: inspectionId } },
        include: { attachments: true, items: { orderBy: { createdAt: 'asc' } } },
      });
      return this.mapInspection(
        reloaded,
        await this.lateFeeForInspection(tx, tenantId, reloaded),
      );
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
        include: { attachments: true, items: true },
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
            suggestedPenaltyAmount: existing.suggestedPenaltyAmount?.toString() ?? null,
          },
        },
        tx,
      );

      return this.mapInspection(
        updated,
        await this.lateFeeForInspection(tx, tenantId, updated),
      );
    });
  }

  /**
   * Daftarkan lampiran foto/dokumen yang sudah diunggah ke R2.
   *
   * Object key wajib berada di namespace tenant (`tenants/{tenantId}/inspections/`)
   * supaya tenant tidak bisa menautkan objek milik tenant lain. Tipe dan ukuran
   * dibatasi di server, bukan hanya di UI.
   */
  async addInspectionAttachment(
    tenantId: string,
    inspectionId: string,
    dto: CreateInspectionAttachmentDto,
    ctx: Ctx,
  ) {
    await this.tenantService.requireMembership(tenantId, ctx.actorUserId, WRITE_ROLES);
    const allowedMime = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    const maxBytes = 10 * 1024 * 1024;
    const prefix = `tenants/${tenantId}/inspections/`;

    if (!dto.objectKey.startsWith(prefix)) {
      throw new ApiError(
        ErrorCode.VALIDATION_ERROR,
        'objectKey lampiran harus berada di namespace upload tenant ini.',
      );
    }
    if (!allowedMime.includes(dto.mimeType)) {
      throw new ApiError(
        ErrorCode.VALIDATION_ERROR,
        'Tipe lampiran harus JPEG, PNG, WebP, atau PDF.',
      );
    }
    if (dto.fileSizeBytes !== undefined && dto.fileSizeBytes > maxBytes) {
      throw new ApiError(ErrorCode.VALIDATION_ERROR, 'Ukuran lampiran maksimum 10 MB.');
    }

    return this.prisma.withTenant(tenantId, async (tx) => {
      const inspection = await tx.inspection.findUnique({
        where: { tenantId_id: { tenantId, id: inspectionId } },
      });
      if (!inspection) throw new ApiError(ErrorCode.NOT_FOUND, 'Inspeksi tidak ditemukan.');
      if (inspection.status === 'REJECTED') {
        throw new ApiError(
          ErrorCode.INVALID_STATE_TRANSITION,
          'Inspeksi yang ditolak tidak menerima lampiran baru.',
        );
      }
      const existingCount = await tx.inspectionAttachment.count({
        where: { tenantId, inspectionId },
      });
      if (existingCount >= 10) {
        throw new ApiError(
          ErrorCode.BUSINESS_RULE_VIOLATION,
          'Satu inspeksi maksimal memiliki 10 lampiran.',
        );
      }

      const attachment = await tx.inspectionAttachment.create({
        data: {
          tenantId,
          inspectionId,
          objectKey: dto.objectKey,
          mimeType: dto.mimeType,
          fileSizeBytes: dto.fileSizeBytes ?? null,
          altText: dto.altText?.trim() || null,
          sortOrder: dto.sortOrder ?? existingCount,
        },
      });

      await this.audit.record(
        {
          tenantId,
          actorUserId: ctx.actorUserId,
          action: 'INSPECTION_ATTACHMENT_ADDED',
          domain: 'returns',
          entityType: 'inspection_attachment',
          entityId: attachment.id,
          correlationId: ctx.correlationId,
          metadata: {
            inspectionId,
            objectKey: attachment.objectKey,
            mimeType: attachment.mimeType,
            fileSizeBytes: attachment.fileSizeBytes,
          },
        },
        tx,
      );

      const reloaded = await tx.inspection.findUniqueOrThrow({
        where: { tenantId_id: { tenantId, id: inspectionId } },
        include: { attachments: true, items: { orderBy: { createdAt: 'asc' } } },
      });
      return this.mapInspection(
        reloaded,
        await this.lateFeeForInspection(tx, tenantId, reloaded),
      );
    });
  }

  /**
   * Teks WhatsApp hasil inspeksi (item 10).
   *
   * Sengaja tidak memakai template pembayaran: `PaymentContext` terikat pada
   * instruksi/konfirmasi pembayaran. Pesan disusun dari data inspeksi terkini
   * agar tidak memuat angka basi, dan hanya untuk inspeksi yang sudah diajukan.
   */
  async inspectionWhatsAppMessage(
    tenantId: string,
    inspectionId: string,
    actorUserId: string,
  ) {
    await this.tenantService.requireMembership(tenantId, actorUserId, READ_ROLES);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const row = await tx.inspection.findUnique({
        where: { tenantId_id: { tenantId, id: inspectionId } },
        include: { attachments: true, items: { orderBy: { createdAt: 'asc' } } },
      });
      if (!row) throw new ApiError(ErrorCode.NOT_FOUND, 'Inspeksi tidak ditemukan.');
      if (row.status === 'DRAFT') {
        throw new ApiError(
          ErrorCode.INVALID_STATE_TRANSITION,
          'Ajukan inspeksi terlebih dahulu sebelum mengirim hasil ke penyewa.',
        );
      }

      const [order, tenant] = await Promise.all([
        tx.rentalOrder.findUnique({
          where: { tenantId_id: { tenantId, id: row.orderId } },
          include: { customer: true },
        }),
        tx.tenant.findUnique({ where: { id: tenantId } }),
      ]);

      const view = this.mapInspection(
        row,
        await this.lateFeeForInspection(tx, tenantId, row),
      );
      const productIds = [...new Set(row.items.map((item) => item.productId))];
      const products =
        productIds.length > 0
          ? await tx.product.findMany({ where: { tenantId, id: { in: productIds } } })
          : [];
      const productName = new Map(products.map((product) => [product.id, product.name]));
      const rupiah = (value: string | null | undefined) =>
        `Rp${new Intl.NumberFormat('id-ID').format(Number(value ?? 0))}`;

      const total =
        view.penaltyAmount ?? view.suggestedTotal?.total ?? view.suggestedPenaltyAmount ?? null;
      const lines = [
        `Halo ${order?.customer?.name ?? 'kak'}, berikut hasil inspeksi pengembalian ${order?.orderNumber ?? ''} di ${tenant?.name ?? 'toko kami'}.`.trim(),
      ];
      if (view.items.length > 0) {
        lines.push('', 'Rincian kondisi:');
        for (const item of view.items) {
          const name = productName.get(item.productId) ?? item.productId;
          lines.push(`- ${name}: ${item.severityLabel} — ${rupiah(item.suggestedAmount)}`);
        }
      } else if (view.damageFee?.label) {
        lines.push('', `Kondisi: ${view.damageFee.label}`);
      }
      if (view.summary) lines.push(`Catatan: ${view.summary}`);
      lines.push(
        '',
        total && Number(total) > 0
          ? `Total denda kerusakan: ${rupiah(total)}.`
          : 'Tidak ada denda kerusakan yang dibebankan.',
        view.status === 'APPROVED'
          ? 'Denda sudah disetujui dan akan ditagihkan terpisah dari biaya sewa.'
          : 'Hasil ini masih menunggu keputusan pemilik toko.',
        '',
        'Silakan hubungi kami bila ada pertanyaan. Terima kasih.',
      );

      return {
        text: lines.join('\n'),
        phone: order?.customer?.phone ?? null,
        customerName: order?.customer?.name ?? null,
        orderNumber: order?.orderNumber ?? null,
        inspectionStatus: view.status,
        totalAmount: total,
      };
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

  /**
   * Konfigurasi inspeksi & denda kondisi tenant. Nilai uang dikirim balik ke
   * klien sebagai string agar aman untuk BigInt.
   */
  private async damageFeeContext(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<{ inspectionEnabled: boolean; policy: DamageFeePolicy }> {
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: {
        damageInspectionEnabled: true,
        damageFeeEnabled: true,
        damageFeeMinorAmount: true,
        damageFeeModerateAmount: true,
        damageFeeSevereAmount: true,
        damageFeeMaxAmount: true,
      },
    });
    // Nominal khusus kategori disalin ke snapshot agar inspeksi lama tetap
    // memakai tarif yang berlaku saat inspeksi dibuat.
    const categoryRows = await tx.damageFeeCategoryAmount.findMany({
      where: { tenantId },
      select: { categoryId: true, minorAmount: true, moderateAmount: true, severeAmount: true },
    });
    const categories: Record<string, DamageAmounts> = {};
    for (const row of categoryRows) {
      categories[row.categoryId] = {
        MINOR: row.minorAmount,
        MODERATE: row.moderateAmount,
        SEVERE: row.severeAmount,
      };
    }
    return {
      inspectionEnabled: tenant?.damageInspectionEnabled ?? false,
      policy: {
        enabled: tenant?.damageFeeEnabled ?? false,
        amounts: {
          MINOR: tenant?.damageFeeMinorAmount ?? 0n,
          MODERATE: tenant?.damageFeeModerateAmount ?? 0n,
          SEVERE: tenant?.damageFeeSevereAmount ?? 0n,
        },
        maxAmount: tenant?.damageFeeMaxAmount ?? null,
        ...(Object.keys(categories).length > 0 ? { categories } : {}),
      },
    };
  }

  /**
   * Validasi rincian kerusakan terhadap isi order dan resolusi tarif per
   * kategori. Semua angka dihitung server; klien hanya mengirim tingkat kondisi.
   */
  private async prepareInspectionItems(
    tx: Prisma.TransactionClient,
    tenantId: string,
    orderId: string,
    policy: DamageFeePolicy,
    input: { productId: string; assetId?: string; quantity?: number; severity: string; note?: string }[],
  ): Promise<{
    rows: {
      productId: string;
      assetId: string | null;
      quantity: number;
      severity: DamageSeverity;
      note: string | null;
      suggestedAmount: bigint | null;
    }[];
    lines: DamageSuggestionLine[];
    severities: DamageSeverity[];
  }> {
    const orderItems = await tx.rentalItem.findMany({
      where: { tenantId, orderId },
      select: { productId: true, quantity: true },
    });
    const orderedProducts = new Set(orderItems.map((item) => item.productId));
    const productIds = [...new Set(input.map((item) => item.productId))];

    const products = await tx.product.findMany({
      where: { tenantId, id: { in: productIds } },
      select: { id: true, categoryId: true },
    });
    const categoryByProduct = new Map(products.map((p) => [p.id, p.categoryId]));

    const assetIds = [
      ...new Set(input.map((i) => i.assetId).filter((id): id is string => Boolean(id))),
    ];
    const assets = assetIds.length
      ? await tx.asset.findMany({
          where: { tenantId, id: { in: assetIds } },
          select: { id: true, productId: true },
        })
      : [];
    const assetProduct = new Map(assets.map((asset) => [asset.id, asset.productId]));

    const rows: {
      productId: string;
      assetId: string | null;
      quantity: number;
      severity: DamageSeverity;
      note: string | null;
      suggestedAmount: bigint | null;
    }[] = [];
    const lines: DamageSuggestionLine[] = [];
    const severities: DamageSeverity[] = [];

    for (const item of input) {
      if (!orderedProducts.has(item.productId)) {
        throw new ApiError(
          ErrorCode.BUSINESS_RULE_VIOLATION,
          'Produk pada rincian kerusakan bukan bagian dari order ini.',
        );
      }
      if (item.assetId) {
        const owner = assetProduct.get(item.assetId);
        if (!owner) throw new ApiError(ErrorCode.NOT_FOUND, 'Asset tidak ditemukan.');
        if (owner !== item.productId) {
          throw new ApiError(
            ErrorCode.BUSINESS_RULE_VIOLATION,
            'Asset tidak termasuk produk pada rincian kerusakan.',
          );
        }
      }
      const severity = item.severity as DamageSeverity;
      if (!(DAMAGE_SEVERITIES as readonly string[]).includes(severity)) {
        throw new ApiError(ErrorCode.VALIDATION_ERROR, 'Tingkat kerusakan tidak dikenal.');
      }
      const quantity = item.quantity ?? 1;
      const amounts = amountsForCategory(policy, categoryByProduct.get(item.productId));
      const lineAmount = amounts[severity] * BigInt(quantity);
      rows.push({
        productId: item.productId,
        assetId: item.assetId ?? null,
        quantity,
        severity,
        note: item.note?.trim() || null,
        suggestedAmount: lineAmount > 0n ? lineAmount : null,
      });
      lines.push({ severity, quantity, amounts });
      severities.push(severity);
    }

    return { rows, lines, severities };
  }

  /** Tingkat terberat dipakai sebagai ringkasan inspeksi multi-item. */
  private worstSeverity(severities: DamageSeverity[]): DamageSeverity | null {
    if (severities.length === 0) return null;
    return severities.reduce((worst, current) =>
      DAMAGE_SEVERITIES.indexOf(current) > DAMAGE_SEVERITIES.indexOf(worst) ? current : worst,
    );
  }

  /** Denda keterlambatan untuk pengembalian milik inspeksi (bila ada). */
  private async lateFeeForInspection(
    tx: Prisma.TransactionClient,
    tenantId: string,
    inspection: { orderId: string; returnRecordId: string | null },
  ) {
    if (!inspection.returnRecordId) return null;
    const record = await tx.returnRecord.findUnique({
      where: { tenantId_id: { tenantId, id: inspection.returnRecordId } },
      select: { returnedAt: true },
    });
    if (!record) return null;
    const context = await this.lateFeeContext(tx, tenantId, inspection.orderId);
    return computeLateFee(context.policy, context.dueAt, record.returnedAt);
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

  private mapInspection(
    row: InspectionWithAttachments,
    lateFee: ReturnType<typeof computeLateFee> | null = null,
  ) {
    const policy = parseDamagePolicy(row.damagePolicySnapshot);
    const damageSuggestion =
      row.suggestedPenaltyAmount ??
      (() => {
        const single = computeDamageFee(policy, row.severity).amount;
        return single ? BigInt(single) : 0n;
      })();
    const lateFeeAmount =
      lateFee?.enabled && lateFee.units > 0 ? BigInt(lateFee.amount) : 0n;
    return {
      id: row.id,
      orderId: row.orderId,
      returnRecordId: row.returnRecordId,
      status: row.status,
      inspectedByUserId: row.inspectedByUserId,
      approvedByUserId: row.approvedByUserId,
      summary: row.summary,
      penaltyAmount: row.penaltyAmount?.toString() ?? null,
      severity: row.severity,
      suggestedPenaltyAmount: row.suggestedPenaltyAmount?.toString() ?? null,
      items: row.items.map((item) => ({
        id: item.id,
        productId: item.productId,
        assetId: item.assetId,
        quantity: item.quantity,
        severity: item.severity,
        severityLabel: DAMAGE_SEVERITY_LABEL[item.severity],
        note: item.note,
        suggestedAmount: item.suggestedAmount?.toString() ?? null,
      })),
      // Usulan gabungan dihitung server; klien tidak menjumlahkan sendiri.
      suggestedTotal: {
        damageFee: damageSuggestion.toString(),
        lateFee: lateFeeAmount.toString(),
        total: (damageSuggestion + lateFeeAmount).toString(),
      },
      // Usulan dibaca dari snapshot inspeksi, bukan konfigurasi tenant terkini.
      damageFee: computeDamageFee(policy, row.severity),
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
