import { Injectable } from '@nestjs/common';
import type { Prisma } from '@rentalio/database';
import { PrismaService } from '../prisma/prisma.service.js';
import { ApiError, ErrorCode } from '../common/errors.js';
import type { PlatformAuditQueryDto } from './platform-admin.dto.js';

/**
 * Audit viewer Admin Platform (`GET /platform-admin/audit-events`).
 *
 * Catatan desain: membaca log audit TIDAK dicatat sebagai event baru.
 * Setiap pembacaan yang menulis event akan membuat log tumbuh tak terbatas
 * hanya karena dibaca (dan membuka jalan log flooding oleh akun yang justru
 * sedang diawasi). Akses tetap dibatasi permission `platform.audit.read`,
 * sesi admin terverifikasi MFA, serta `Cache-Control: no-store`.
 */
@Injectable()
export class PlatformAuditService {
  constructor(private readonly prisma: PrismaService) {}

  async listEvents(query: PlatformAuditQueryDto) {
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;
    if (from && to && from.getTime() > to.getTime()) {
      throw new ApiError(ErrorCode.VALIDATION_ERROR, '`from` tidak boleh setelah `to`.');
    }

    const where: Prisma.PlatformAuditEventWhereInput = {
      ...(query.actorAdminId ? { actorAdminId: query.actorAdminId } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(from || to
        ? {
            createdAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.client.platformAuditEvent.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          actorAdminId: true,
          action: true,
          targetType: true,
          targetId: true,
          reason: true,
          outcome: true,
          correlationId: true,
          metadata: true,
          createdAt: true,
        },
      }),
      this.prisma.client.platformAuditEvent.count({ where }),
    ]);

    return {
      data: rows,
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }
}
