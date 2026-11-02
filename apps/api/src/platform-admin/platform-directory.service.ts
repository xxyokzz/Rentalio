import { Injectable } from '@nestjs/common';
import type { Prisma } from '@rentalio/database';
import { PrismaService } from '../prisma/prisma.service.js';
import { ApiError, ErrorCode } from '../common/errors.js';
import { recordPlatformAudit, type PlatformAuditAction } from './platform-admin.audit.js';
import type { PlatformTenantDirectoryQueryDto } from './platform-admin.dto.js';

/**
 * UUID generik (tanpa memaksa versi tertentu) — dipakai untuk menolak id yang
 * jelas bukan UUID sebelum menyentuh kolom `uuid` PostgreSQL, agar input
 * sembarang menjadi 400, bukan error driver 500.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ringkasan tenant: identitas bisnis + status operasional, tanpa data PII. */
const TENANT_SUMMARY_SELECT = {
  id: true,
  slug: true,
  name: true,
  status: true,
  timezone: true,
  currency: true,
  createdAt: true,
  updatedAt: true,
  activatedAt: true,
  trialEndsAt: true,
} as const;

type DirectoryContext = { adminId: string; correlationId: string };

export type PlatformTenantStatusAction = 'SUSPEND' | 'REACTIVATE';

/**
 * Transisi yang diizinkan. `CLOSED` bersifat final, dan status tujuan tidak
 * pernah diambil dari request — hanya dari tabel ini.
 */
const STATUS_TRANSITIONS: Record<
  PlatformTenantStatusAction,
  {
    to: 'SUSPENDED' | 'ACTIVE';
    from: readonly string[];
    audit: PlatformAuditAction;
  }
> = {
  SUSPEND: {
    to: 'SUSPENDED',
    from: ['ACTIVE', 'PENDING_ACTIVATION'],
    audit: 'PLATFORM_TENANT_SUSPENDED',
  },
  REACTIVATE: {
    to: 'ACTIVE',
    from: ['SUSPENDED'],
    audit: 'PLATFORM_TENANT_REACTIVATED',
  },
};

const MIN_REASON_LENGTH = 10;

/**
 * Direktori tenant untuk Admin Platform.
 *
 * Hanya metadata minimum yang ditampilkan: identitas bisnis dan status
 * operasional. Data pelanggan, transaksi, dan isi katalog tenant tidak
 * diekspos lewat jalur ini.
 *
 * Baca lintas tenant memakai konteks `app.platform_admin` (SELECT-only policy
 * pada `tenants`), dan setiap halaman yang dikembalikan dicatat ke audit
 * append-only di transaksi yang sama. Tidak ada operasi tulis pada data tenant.
 */
@Injectable()
export class PlatformTenantDirectoryService {
  constructor(private readonly prisma: PrismaService) {}

  async listTenants(query: PlatformTenantDirectoryQueryDto, context: DirectoryContext) {
    const search = query.q?.trim();
    const where: Prisma.TenantWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' as const } },
              { slug: { contains: search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const { rows, total } = await this.prisma.withPlatformAdmin(async (tx) => {
      const [rows, total] = await Promise.all([
        tx.tenant.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
          select: {
            id: true,
            slug: true,
            name: true,
            status: true,
            createdAt: true,
            trialEndsAt: true,
          },
        }),
        tx.tenant.count({ where }),
      ]);
      await recordPlatformAudit(tx, {
        actorAdminId: context.adminId,
        action: 'PLATFORM_TENANT_DIRECTORY_VIEWED',
        targetType: 'tenant_directory',
        correlationId: context.correlationId,
        metadata: {
          page: query.page,
          pageSize: query.pageSize,
          status: query.status ?? null,
          // Query pencarian tidak disimpan mentah: bisa memuat nama orang.
          hasSearch: Boolean(search),
          returned: rows.length,
          total,
        },
      });
      return { rows, total };
    });

    return {
      data: rows,
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  /**
   * Ringkasan satu tenant. Percobaan yang gagal (id tidak valid/tidak ada) juga
   * diaudit dengan `outcome: FAILED`, sehingga pencarian id sembarangan oleh
   * akun admin tetap meninggalkan jejak.
   */
  async getTenant(tenantId: string, context: DirectoryContext) {
    const validId = UUID_PATTERN.test(tenantId);
    const tenant = await this.prisma.withPlatformAdmin(async (tx) => {
      const found = validId
        ? await tx.tenant.findUnique({
            where: { id: tenantId },
            select: TENANT_SUMMARY_SELECT,
          })
        : null;
      await recordPlatformAudit(tx, {
        actorAdminId: context.adminId,
        action: 'PLATFORM_TENANT_SUMMARY_VIEWED',
        targetType: 'tenant',
        targetId: tenantId,
        outcome: found ? 'SUCCESS' : 'FAILED',
        correlationId: context.correlationId,
        metadata: { found: Boolean(found), validId },
      });
      return found;
    });

    if (!validId) throw new ApiError(ErrorCode.VALIDATION_ERROR, 'ID tenant harus UUID.');
    if (!tenant) throw new ApiError(ErrorCode.NOT_FOUND, 'Tenant tidak ditemukan.');
    return { data: tenant };
  }

  /**
   * Suspend/reactivate tenant.
   *
   * Perubahan dilakukan dengan `updateMany` yang menyertakan status sumber,
   * sehingga dua admin yang menekan tombol bersamaan tidak menghasilkan dua
   * transisi sah. Audit ditulis di transaksi yang sama untuk keberhasilan
   * maupun penolakan (id tidak valid, tenant hilang, transisi ilegal, balapan).
   */
  async changeTenantStatus(
    tenantId: string,
    action: PlatformTenantStatusAction,
    reasonInput: string,
    context: DirectoryContext,
  ) {
    const reason = reasonInput.trim();
    if (reason.length < MIN_REASON_LENGTH) {
      throw new ApiError(ErrorCode.VALIDATION_ERROR, 'Alasan perubahan status minimal 10 karakter.');
    }

    const validId = UUID_PATTERN.test(tenantId);
    const transition = STATUS_TRANSITIONS[action];

    const result = await this.prisma.withPlatformAdmin(async (tx) => {
      const tenant = validId
        ? await tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true, status: true } })
        : null;

      const auditFailure = async (denial: string, fromStatus?: string) => {
        await recordPlatformAudit(tx, {
          actorAdminId: context.adminId,
          action: transition.audit,
          targetType: 'tenant',
          targetId: tenantId,
          reason,
          outcome: 'FAILED',
          correlationId: context.correlationId,
          metadata: {
            denial,
            validId,
            requestedStatus: transition.to,
            ...(fromStatus ? { fromStatus } : {}),
          },
        });
      };

      if (!tenant) {
        await auditFailure(validId ? 'NOT_FOUND' : 'INVALID_ID');
        return { error: 'NOT_FOUND' as const };
      }

      if (!transition.from.includes(tenant.status)) {
        await auditFailure('INVALID_STATE', tenant.status);
        return { error: 'INVALID_STATE' as const, fromStatus: tenant.status };
      }

      // Kunci optimistik: hanya berhasil bila status masih sama seperti yang dibaca.
      const changed = await tx.tenant.updateMany({
        where: { id: tenantId, status: tenant.status },
        data: { status: transition.to },
      });
      if (changed.count !== 1) {
        await auditFailure('CONCURRENT_CHANGE', tenant.status);
        return { error: 'INVALID_STATE' as const, fromStatus: tenant.status };
      }

      const updated = await tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: TENANT_SUMMARY_SELECT,
      });
      await recordPlatformAudit(tx, {
        actorAdminId: context.adminId,
        action: transition.audit,
        targetType: 'tenant',
        targetId: tenantId,
        reason,
        outcome: 'SUCCESS',
        correlationId: context.correlationId,
        metadata: { fromStatus: tenant.status, toStatus: transition.to },
      });
      return { tenant: updated };
    });

    if ('error' in result) {
      if (result.error === 'NOT_FOUND') {
        throw new ApiError(ErrorCode.NOT_FOUND, 'Tenant tidak ditemukan.');
      }
      throw new ApiError(
        ErrorCode.INVALID_STATE_TRANSITION,
        `Perubahan status tenant tidak diizinkan dari ${result.fromStatus}.`,
      );
    }
    return { data: result.tenant };
  }
}
