import { Injectable } from '@nestjs/common';
import type { Prisma } from '@rentalio/database';
import { PrismaService } from '../prisma/prisma.service.js';
import { ApiError, ErrorCode } from '../common/errors.js';
import { recordPlatformAudit } from './platform-admin.audit.js';
import type { PlatformAdminDirectoryQueryDto } from './platform-admin.dto.js';

/**
 * UUID generik (tanpa memaksa versi tertentu) — dipakai untuk menolak id yang
 * jelas bukan UUID sebelum menyentuh kolom `uuid` PostgreSQL, agar input
 * sembarang menjadi 400, bukan error driver 500.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type DirectoryContext = { adminId: string; correlationId: string };

/** Identitas admin + status sesi/MFA; hash password dan secret TOTP tidak pernah ikut. */
const ADMIN_SUMMARY_SELECT = {
  id: true,
  email: true,
  status: true,
  mfaEnrolledAt: true,
  lastLoginAt: true,
  createdAt: true,
} as const;

/** Hanya penugasan yang masih aktif (revokedAt null) yang ditampilkan. */
const ACTIVE_ROLES_SELECT = {
  where: { revokedAt: null },
  orderBy: { assignedAt: 'asc' },
  select: {
    assignedAt: true,
    role: {
      select: {
        code: true,
        name: true,
        permissions: { select: { permission: { select: { code: true } } } },
      },
    },
  },
} as const satisfies Prisma.PlatformAdminUser$rolesArgs;

type AdminRow = Prisma.PlatformAdminUserGetPayload<{
  select: typeof ADMIN_SUMMARY_SELECT & {
    roles: typeof ACTIVE_ROLES_SELECT;
  };
}>;

/** Bentuk API untuk satu penugasan role aktif. */
export interface AdminRoleView {
  roleCode: string;
  roleName: string;
  assignedAt: Date;
}

function activeRolesOf(row: AdminRow): AdminRoleView[] {
  return row.roles.map((assignment) => ({
    roleCode: assignment.role.code,
    roleName: assignment.role.name,
    assignedAt: assignment.assignedAt,
  }));
}

function effectivePermissionsOf(row: AdminRow): string[] {
  const codes = new Set<string>();
  for (const assignment of row.roles) {
    for (const { permission } of assignment.role.permissions) codes.add(permission.code);
  }
  return [...codes].sort();
}

/**
 * Direktori Admin Platform (`GET /platform-admin/admins[/:adminId]`).
 *
 * Design notes:
 * - Pembacaan dilindungi permission `platform.roles.read` di guard, lalu setiap
 *   halaman/permintaan ditulis ke audit append-only di transaksi yang sama —
 *   siapa yang melihat daftar kewenangan admin ikut tercatat, konsisten dengan
 *   direktori tenant.
 * - Tabel `platform_*` global tanpa RLS, sehingga tidak memerlukan konteks
 *   `app.platform_admin`; tidak ada operasi tulis di service ini.
 * - Yang diekspos hanya identitas minimal (email, status, jejak MFA/login) dan
 *   penugasan role aktif; password hash, secret TOTP, sesi, dan kode pemulihan
 *   tidak pernah ikut dalam respons.
 */
@Injectable()
export class PlatformAdminDirectoryService {
  constructor(private readonly prisma: PrismaService) {}

  async listAdmins(query: PlatformAdminDirectoryQueryDto, context: DirectoryContext) {
    const search = query.q?.trim();
    const where: Prisma.PlatformAdminUserWhereInput = {
      ...(search ? { email: { contains: search, mode: 'insensitive' as const } } : {}),
    };

    const { rows, total } = await this.prisma.withRetryableTransaction(async (tx) => {
      const [rows, total] = await Promise.all([
        tx.platformAdminUser.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
          select: { ...ADMIN_SUMMARY_SELECT, roles: ACTIVE_ROLES_SELECT },
        }),
        tx.platformAdminUser.count({ where }),
      ]);
      await recordPlatformAudit(tx, {
        actorAdminId: context.adminId,
        action: 'PLATFORM_ADMIN_DIRECTORY_VIEWED',
        targetType: 'platform_admin_directory',
        correlationId: context.correlationId,
        metadata: {
          page: query.page,
          pageSize: query.pageSize,
          // Query pencarian tidak disimpan mentah (bisa memuat alamat email).
          hasSearch: Boolean(search),
          returned: rows.length,
          total,
        },
      });
      return { rows, total };
    });

    return {
      data: rows.map((row) => ({
        id: row.id,
        email: row.email,
        status: row.status,
        mfaEnrolledAt: row.mfaEnrolledAt,
        lastLoginAt: row.lastLoginAt,
        createdAt: row.createdAt,
        roles: activeRolesOf(row),
      })),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  /**
   * Detail satu admin: identitas minimal, penugasan role aktif, dan permission
   * efektif yang diturunkan dari role aktif tersebut. Percobaan yang gagal (id
   * tidak valid/tidak ada) diaudit `outcome: FAILED` — sama seperti ringkasan
   * tenant, pencarian id sembarangan tetap meninggalkan jejak.
   */
  async getAdmin(adminId: string, context: DirectoryContext) {
    const validId = UUID_PATTERN.test(adminId);
    const admin = await this.prisma.withRetryableTransaction(async (tx) => {
      const found = validId
        ? await tx.platformAdminUser.findUnique({
            where: { id: adminId },
            select: { ...ADMIN_SUMMARY_SELECT, roles: ACTIVE_ROLES_SELECT },
          })
        : null;
      await recordPlatformAudit(tx, {
        actorAdminId: context.adminId,
        action: 'PLATFORM_ADMIN_DETAIL_VIEWED',
        targetType: 'platform_admin_user',
        targetId: adminId,
        outcome: found ? 'SUCCESS' : 'FAILED',
        correlationId: context.correlationId,
        metadata: { found: Boolean(found), validId },
      });
      return found;
    });

    if (!validId) throw new ApiError(ErrorCode.VALIDATION_ERROR, 'ID admin harus UUID.');
    if (!admin) throw new ApiError(ErrorCode.NOT_FOUND, 'Admin Platform tidak ditemukan.');

    return {
      data: {
        id: admin.id,
        email: admin.email,
        status: admin.status,
        mfaEnrolledAt: admin.mfaEnrolledAt,
        lastLoginAt: admin.lastLoginAt,
        createdAt: admin.createdAt,
        roles: activeRolesOf(admin),
        permissions: effectivePermissionsOf(admin),
      },
    };
  }
}
