import { Injectable } from '@nestjs/common';
import type { Prisma } from '@rentalio/database';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenantService } from '../tenant/tenant.service.js';
import { ApiError, ErrorCode } from '../common/errors.js';
import { DAMAGE_SEVERITIES, type DamageSeverity } from '../returns/damage-fee.js';
import type { DamageFeeReportQueryDto } from './reports.dto.js';

/**
 * Laporan operasional denda kerusakan.
 *
 * Sumber angka: `order_penalties` (denda yang benar-benar ditagihkan),
 * `inspections` (keputusan), dan `inspection_items` (tingkat kerusakan).
 * Usulan yang belum disetujui tidak masuk total tagihan — hanya laporan usulan.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantService: TenantService,
  ) {}

  async damageFees(tenantId: string, actorUserId: string, query: DamageFeeReportQueryDto) {
    await this.tenantService.requirePermission(tenantId, actorUserId, 'report.read');

    const from = query.from ? new Date(query.from) : null;
    const to = query.to ? new Date(query.to) : null;
    if (from && to && from > to) {
      throw new ApiError(ErrorCode.VALIDATION_ERROR, 'Rentang tanggal terbalik.');
    }
    const createdAt: Prisma.DateTimeFilter | undefined =
      from || to ? { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } : undefined;

    return this.prisma.withTenant(tenantId, async (tx) => {
      const [
        penaltyAggregate,
        inspectionGroups,
        itemGroups,
        topProducts,
      ] = await Promise.all([
        tx.orderPenalty.aggregate({
          where: { tenantId, ...(createdAt ? { createdAt } : {}) },
          _count: { _all: true },
          _sum: { amount: true },
        }),
        tx.inspection.groupBy({
          by: ['status'],
          where: { tenantId, ...(createdAt ? { createdAt } : {}) },
          _count: { _all: true },
        }),
        tx.inspectionItem.groupBy({
          by: ['severity'],
          where: { tenantId, ...(createdAt ? { createdAt } : {}) },
          _count: { _all: true },
          _sum: { suggestedAmount: true, quantity: true },
        }),
        tx.inspectionItem.groupBy({
          by: ['productId'],
          where: { tenantId, ...(createdAt ? { createdAt } : {}) },
          _count: { _all: true },
          _sum: { suggestedAmount: true, quantity: true },
          orderBy: { _sum: { suggestedAmount: 'desc' } },
          take: 5,
        }),
      ]);

      const inspections: Record<string, number> = {
        DRAFT: 0,
        SUBMITTED: 0,
        APPROVED: 0,
        REJECTED: 0,
      };
      for (const group of inspectionGroups) {
        inspections[group.status] = group._count._all;
      }

      const severity: Record<DamageSeverity, { lines: number; quantity: number; suggestedAmount: string }> = {
        MINOR: { lines: 0, quantity: 0, suggestedAmount: '0' },
        MODERATE: { lines: 0, quantity: 0, suggestedAmount: '0' },
        SEVERE: { lines: 0, quantity: 0, suggestedAmount: '0' },
      };
      for (const group of itemGroups) {
        if (!(DAMAGE_SEVERITIES as readonly string[]).includes(group.severity)) continue;
        severity[group.severity as DamageSeverity] = {
          lines: group._count._all,
          quantity: group._sum.quantity ?? 0,
          suggestedAmount: (group._sum.suggestedAmount ?? 0n).toString(),
        };
      }

      return {
        range: {
          from: from ? from.toISOString() : null,
          to: to ? to.toISOString() : null,
        },
        penalties: {
          count: penaltyAggregate._count._all,
          totalAmount: (penaltyAggregate._sum.amount ?? 0n).toString(),
        },
        inspections,
        severity,
        topProducts: topProducts.map((row) => ({
          productId: row.productId,
          lines: row._count._all,
          quantity: row._sum.quantity ?? 0,
          suggestedAmount: (row._sum.suggestedAmount ?? 0n).toString(),
        })),
      };
    });
  }
}
