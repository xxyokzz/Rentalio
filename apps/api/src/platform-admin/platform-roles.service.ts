import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { ApiError, ErrorCode } from '../common/errors.js';
import {
  recordPlatformAudit,
  type PlatformAuditAction,
} from './platform-admin.audit.js';

/**
 * UUID generik (tanpa memaksa versi tertentu) — dipakai untuk menolak id yang
 * jelas bukan UUID sebelum menyentuh kolom `uuid` PostgreSQL, agar input
 * sembarang menjadi 400, bukan error driver 500.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MIN_REASON_LENGTH = 10;

/**
 * Role super admin: sumber kebenaran proteksi anti-lockout. Dibaca dari kode
 * role yang sama dengan seed, dan pengecekan hanya dilakukan bila role yang
 * disentuh memang role ini — role lain tidak terpengaruh.
 */
const SUPER_ADMIN_ROLE_CODE = 'PLATFORM_SUPER_ADMIN';

export type PlatformRoleAction = 'ASSIGN' | 'REVOKE';

const ROLE_ACTION_AUDIT: Record<PlatformRoleAction, PlatformAuditAction> = {
  ASSIGN: 'PLATFORM_ADMIN_ROLE_ASSIGNED',
  REVOKE: 'PLATFORM_ADMIN_ROLE_REVOKED',
};

type RoleContext = { adminId: string; correlationId: string };

export interface AssignmentSnapshot {
  adminUserId: string;
  roleCode: string;
  assignedAt: Date;
  revokedAt: Date | null;
}

/**
 * Hasil transaksi: sukses membawa baris assignment terbaru, kegagalan membawa
 * sebab spesifik supaya pesan error dan metadata audit tetap konsisten.
 */
type RoleChangeResult =
  | { assignment: AssignmentSnapshot }
  | { error: 'INVALID_ID' }
  | { error: 'NOT_FOUND'; subject: 'admin' | 'role' | 'assignment' }
  | { error: 'INVALID_STATE' }
  | { error: 'BUSINESS_RULE'; rule: 'SELF_ASSIGNMENT' | 'LAST_SUPER_ADMIN' };

/**
 * Penugasan role Admin Platform (`platform_admin_roles`).
 *
 * Design notes:
 * - Tabel ini global (tanpa RLS), jadi tidak perlu konteks `app.platform_admin`
 *   — otorisasi sudah ditegakkan guard permission sebelum service dipanggil.
 * - Mutasi dan audit berada di SATU transaksi: percobaan yang ditolak (admin
 *   hilang, role tak dikenal, sudah ditugaskan/dicabut, balapan) tetap
 *   meninggalkan baris audit `FAILED` beserta alasannya.
 * - Unique constraint `(adminUserId, roleId)` membuat assign ulang setelah
 *   revoke harus MENGHIDUPKAN kembali baris yang sama (revokedAt → null),
 *   bukan membuat baris duplikat. Pembaruan selalu memuat kondisi sumber di
 *   `WHERE` (kunci optimistik) sehingga dua admin yang menekan tombol
 *   bersamaan tidak menghasilkan dua transisi sah.
 * - Proteksi anti-lockout di dalam transaksi yang sama: (1) admin tidak boleh
 *   menugaskan role ke diri sendiri (mencegah eskalasi privilese mandiri), dan
 *   (2) penugasan `PLATFORM_SUPER_ADMIN` terakhir tidak boleh dicabut
 *   (mencegah platform kehilangan seluruh super admin). Keduanya ditolak
 *   `422 BUSINESS_RULE_VIOLATION` dan tetap tercatat audit `FAILED`.
 */
@Injectable()
export class PlatformRoleAssignmentService {
  constructor(private readonly prisma: PrismaService) {}

  async assign(
    adminUserId: string,
    roleCode: string,
    reasonInput: string,
    context: RoleContext,
  ): Promise<{ data: AssignmentSnapshot }> {
    return this.changeRole('ASSIGN', adminUserId, roleCode, reasonInput, context);
  }

  async revoke(
    adminUserId: string,
    roleCode: string,
    reasonInput: string,
    context: RoleContext,
  ): Promise<{ data: AssignmentSnapshot }> {
    return this.changeRole('REVOKE', adminUserId, roleCode, reasonInput, context);
  }

  private async changeRole(
    action: PlatformRoleAction,
    adminUserId: string,
    roleCode: string,
    reasonInput: string,
    context: RoleContext,
  ): Promise<{ data: AssignmentSnapshot }> {
    const reason = reasonInput.trim();
    if (reason.length < MIN_REASON_LENGTH) {
      throw new ApiError(ErrorCode.VALIDATION_ERROR, 'Alasan perubahan role minimal 10 karakter.');
    }

    const validId = UUID_PATTERN.test(adminUserId);
    const auditAction = ROLE_ACTION_AUDIT[action];

    const result: RoleChangeResult = await this.prisma.withRetryableTransaction(async (tx) => {
      const auditFailure = async (
        denial: string,
        extra?: Record<string, unknown>,
      ): Promise<void> => {
        await recordPlatformAudit(tx, {
          actorAdminId: context.adminId,
          action: auditAction,
          targetType: 'platform_admin_user',
          targetId: adminUserId,
          reason,
          outcome: 'FAILED',
          correlationId: context.correlationId,
          metadata: { denial, roleCode, validId, ...extra },
        });
      };

      // 0. Anti-lockout: menugaskan role ke diri sendiri tidak pernah sah,
      //    sekalipun aktor memiliki platform.roles.assign — tanpa ini, seorang
      //    admin dapat menambah privilese kepada dirinya sendiri.
      if (action === 'ASSIGN' && adminUserId === context.adminId) {
        await auditFailure('SELF_ASSIGNMENT');
        return { error: 'BUSINESS_RULE', rule: 'SELF_ASSIGNMENT' } as const;
      }

      // 1. Target admin harus ada (kegagalan diaudit sebagai FAILED).
      const target = validId
        ? await tx.platformAdminUser.findUnique({
            where: { id: adminUserId },
            select: { id: true },
          })
        : null;
      if (!target) {
        if (!validId) {
          await auditFailure('INVALID_ID');
          return { error: 'INVALID_ID' } as const;
        }
        await auditFailure('ADMIN_NOT_FOUND');
        return { error: 'NOT_FOUND', subject: 'admin' } as const;
      }

      // 2. Role diambil dari database — kode tidak pernah diandalkan dari
      //    input selain untuk lookup, sehingga daftar role tetap sumber kebenaran.
      const role = await tx.platformRole.findUnique({
        where: { code: roleCode },
        select: { id: true, code: true },
      });
      if (!role) {
        await auditFailure('ROLE_NOT_FOUND');
        return { error: 'NOT_FOUND', subject: 'role' } as const;
      }

      const assignmentKey = { adminUserId_roleId: { adminUserId, roleId: role.id } };

      if (action === 'ASSIGN') {
        const existing = await tx.platformAdminRole.findUnique({ where: assignmentKey });

        if (existing && !existing.revokedAt) {
          await auditFailure('ALREADY_ASSIGNED');
          return { error: 'INVALID_STATE' } as const;
        }

        if (existing) {
          // Hidupkan kembali baris yang sama (unique constraint mencegah baris kedua).
          const reactivated = await tx.platformAdminRole.updateMany({
            where: { id: existing.id, revokedAt: { not: null } },
            data: { revokedAt: null, assignedAt: new Date(), assignedByAdminId: context.adminId },
          });
          if (reactivated.count !== 1) {
            await auditFailure('CONCURRENT_CHANGE');
            return { error: 'INVALID_STATE' } as const;
          }
        } else {
          // `skipDuplicates` = INSERT ... ON CONFLICT DO NOTHING: balapan dua
          // assign bersamaan tidak mematikan transaksi (P2002), tetapi dihitung
          // sebagai kegagalan yang diaudit.
          const created = await tx.platformAdminRole.createMany({
            data: [{ adminUserId, roleId: role.id, assignedByAdminId: context.adminId }],
            skipDuplicates: true,
          });
          if (created.count !== 1) {
            const concurrent = await tx.platformAdminRole.findUnique({ where: assignmentKey });
            await auditFailure(
              concurrent && !concurrent.revokedAt ? 'ALREADY_ASSIGNED' : 'CONCURRENT_CHANGE',
            );
            return { error: 'INVALID_STATE' } as const;
          }
        }

        const saved = await tx.platformAdminRole.findUniqueOrThrow({ where: assignmentKey });
        await recordPlatformAudit(tx, {
          actorAdminId: context.adminId,
          action: auditAction,
          targetType: 'platform_admin_user',
          targetId: adminUserId,
          reason,
          outcome: 'SUCCESS',
          correlationId: context.correlationId,
          metadata: { roleCode: role.code },
        });
        return {
          assignment: {
            adminUserId,
            roleCode: role.code,
            assignedAt: saved.assignedAt,
            revokedAt: saved.revokedAt,
          },
        } as const;
      }

      // REVOKE — hanya baris yang masih aktif yang boleh dicabut.
      if (role.code === SUPER_ADMIN_ROLE_CODE) {
        // Kunci baris penugasan SUPER_ADMIN yang masih aktif (urut `id` agar
        // urutan penguncian deterministik dan bebas deadlock), lalu hitung.
        // Dua admin yang mencabut SUPER_ADMIN terakhir secara bersamaan
        // diserialisasi oleh lock ini: transaksi kedua melihat hasil commit
        // pertama, sehingga jumlah aktif tidak pernah jatuh ke nol.
        const activeRows = await tx.$queryRaw<{
          adminUserId: string;
        }[]>`
          SELECT "adminUserId" FROM "platform_admin_roles"
          WHERE "roleId" = ${role.id} AND "revokedAt" IS NULL
          ORDER BY "id"
          FOR UPDATE`;
        if (activeRows.length === 1 && activeRows[0]!.adminUserId === adminUserId) {
          await auditFailure('LAST_SUPER_ADMIN');
          return { error: 'BUSINESS_RULE', rule: 'LAST_SUPER_ADMIN' } as const;
        }
      }

      const revoked = await tx.platformAdminRole.updateMany({
        where: { adminUserId, roleId: role.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (revoked.count !== 1) {
        const existing = await tx.platformAdminRole.findUnique({ where: assignmentKey });
        if (!existing) {
          await auditFailure('NOT_ASSIGNED');
          return { error: 'NOT_FOUND', subject: 'assignment' } as const;
        }
        await auditFailure('ALREADY_REVOKED');
        return { error: 'INVALID_STATE' } as const;
      }

      const saved = await tx.platformAdminRole.findUniqueOrThrow({ where: assignmentKey });
      await recordPlatformAudit(tx, {
        actorAdminId: context.adminId,
        action: auditAction,
        targetType: 'platform_admin_user',
        targetId: adminUserId,
        reason,
        outcome: 'SUCCESS',
        correlationId: context.correlationId,
        metadata: { roleCode: role.code },
      });
      return {
        assignment: {
          adminUserId,
          roleCode: role.code,
          assignedAt: saved.assignedAt,
          revokedAt: saved.revokedAt,
        },
      } as const;
    });

    // Error dilemparkan SETELAH transaksi commit: audit kegagalan sudah ikut
    // tersimpan, sama seperti pola aksi status tenant.
    if ('error' in result) {
      if (result.error === 'INVALID_ID') {
        throw new ApiError(ErrorCode.VALIDATION_ERROR, 'ID admin harus UUID.');
      }
      if (result.error === 'INVALID_STATE') {
        throw new ApiError(
          ErrorCode.INVALID_STATE_TRANSITION,
          action === 'ASSIGN'
            ? 'Role sudah ditugaskan ke admin tersebut.'
            : 'Penugasan role sudah dicabut sebelumnya.',
        );
      }
      if (result.error === 'BUSINESS_RULE') {
        throw new ApiError(
          ErrorCode.BUSINESS_RULE_VIOLATION,
          result.rule === 'SELF_ASSIGNMENT'
            ? 'Admin tidak boleh menugaskan role ke diri sendiri.'
            : 'Penugasan SUPER_ADMIN terakhir tidak dapat dicabut.',
        );
      }
      throw new ApiError(
        ErrorCode.NOT_FOUND,
        result.subject === 'admin'
          ? 'Admin Platform tidak ditemukan.'
          : result.subject === 'role'
            ? 'Role Admin Platform tidak ditemukan.'
            : 'Role tidak ditugaskan ke admin tersebut.',
      );
    }

    return { data: result.assignment };
  }
}
