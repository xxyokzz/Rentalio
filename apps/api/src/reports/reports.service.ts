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
  /** Batas umur yang dianggap menua; dipakai juga oleh badge notifikasi web. */
  static readonly RECEIVABLE_AGING = { invoiceDays: 14, penaltyDays: 7 } as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantService: TenantService,
  ) {}

  /**
   * Piutang dan denda yang belum lunas, dikelompokkan menurut umur.
   *
   * Satu baris pesanan bisa memuat sewa dan beberapa denda; pembayaran tidak
   * dialokasikan per baris oleh ledger, jadi umur memakai tanggal pesanan dan
   * denda yang masih RECORDED pada pesanan yang masih bersaldo.
   */
  async receivableAging(tenantId: string, actorUserId: string) {
    await this.tenantService.requirePermission(tenantId, actorUserId, 'report.read');

    const now = new Date();
    const { invoiceDays, penaltyDays } = ReportsService.RECEIVABLE_AGING;
    const dayMs = 86_400_000;
    const ageDays = (at: Date) => Math.max(0, Math.floor((now.getTime() - at.getTime()) / dayMs));

    return this.prisma.withTenant(tenantId, async (tx) => {
      const orders = await tx.rentalOrder.findMany({
        where: { tenantId, status: { not: 'CANCELLED' } },
        select: {
          id: true,
          createdAt: true,
          totalAmount: true,
          payments: { where: { status: 'RECORDED' }, select: { amount: true } },
          penalties: {
            where: { status: 'RECORDED' },
            select: { amount: true, createdAt: true },
          },
        },
      });

      const buckets = [
        { key: '0-7', orders: 0, amount: 0n },
        { key: '8-14', orders: 0, amount: 0n },
        { key: '15-30', orders: 0, amount: 0n },
        { key: '31+', orders: 0, amount: 0n },
      ];
      let outstandingOrders = 0;
      let outstandingAmount = 0n;
      let overdueOrders = 0;
      let overdueAmount = 0n;
      let oldestInvoiceDays = 0;
      let penaltyOrders = 0;
      let penaltyAmount = 0n;
      let agedPenaltyOrders = 0;
      let agedPenaltyAmount = 0n;
      let oldestPenaltyDays = 0;
      // Satu pesanan bisa menua sekaligus punya denda menua; badge hanya boleh
      // menghitungnya sekali.
      const alertedOrders = new Set<string>();

      for (const order of orders) {
        const paid = order.payments.reduce((sum, payment) => sum + payment.amount, 0n);
        const penaltyTotal = order.penalties.reduce((sum, penalty) => sum + penalty.amount, 0n);
        const due = order.totalAmount + penaltyTotal - paid;
        if (due <= 0n) continue;

        const age = ageDays(order.createdAt);
        outstandingOrders += 1;
        outstandingAmount += due;
        oldestInvoiceDays = Math.max(oldestInvoiceDays, age);

        const bucket =
          age <= 7 ? buckets[0] : age <= 14 ? buckets[1] : age <= 30 ? buckets[2] : buckets[3];
        bucket.orders += 1;
        bucket.amount += due;

        if (age > invoiceDays) {
          overdueOrders += 1;
          overdueAmount += due;
          alertedOrders.add(order.id);
        }

        if (penaltyTotal > 0n) {
          penaltyOrders += 1;
          penaltyAmount += penaltyTotal;
          const oldestPenaltyAge = Math.max(
            ...order.penalties.map((penalty) => ageDays(penalty.createdAt)),
          );
          oldestPenaltyDays = Math.max(oldestPenaltyDays, oldestPenaltyAge);
          if (oldestPenaltyAge > penaltyDays) {
            agedPenaltyOrders += 1;
            agedPenaltyAmount += penaltyTotal;
            alertedOrders.add(order.id);
          }
        }
      }

      return {
        asOf: now.toISOString(),
        thresholds: { invoiceDays, penaltyDays },
        outstanding: {
          orders: outstandingOrders,
          amount: outstandingAmount.toString(),
          overdueOrders,
          overdueAmount: overdueAmount.toString(),
          oldestDays: oldestInvoiceDays,
        },
        penalties: {
          orders: penaltyOrders,
          amount: penaltyAmount.toString(),
          agedOrders: agedPenaltyOrders,
          agedAmount: agedPenaltyAmount.toString(),
          oldestDays: oldestPenaltyDays,
        },
        buckets: buckets.map((bucket) => ({ ...bucket, amount: bucket.amount.toString() })),
        // Angka badge: satu pesanan dihitung sekali walau tagihan dan dendanya
        // sama-sama menua.
        alertCount: alertedOrders.size,
      };
    });
  }

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
        voidedPenalties,
        inspectionGroups,
        itemGroups,
        topProducts,
      ] = await Promise.all([
        tx.orderPenalty.aggregate({
          where: { tenantId, status: 'RECORDED', ...(createdAt ? { createdAt } : {}) },
          _count: { _all: true },
          _sum: { amount: true },
        }),
        tx.orderPenalty.count({
          where: { tenantId, status: 'VOIDED', ...(createdAt ? { createdAt } : {}) },
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
        DISPUTED: 0,
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

      // Nama produk diambil terpisah: `inspection_items` hanya menyimpan id.
      const productIds = topProducts.map((row) => row.productId);
      const products = productIds.length
        ? await tx.product.findMany({
            where: { tenantId, id: { in: productIds } },
            select: { id: true, name: true },
          })
        : [];
      const productNames = new Map(products.map((product) => [product.id, product.name]));

      return {
        range: {
          from: from ? from.toISOString() : null,
          to: to ? to.toISOString() : null,
        },
        penalties: {
          count: penaltyAggregate._count._all,
          totalAmount: (penaltyAggregate._sum.amount ?? 0n).toString(),
          voidedCount: voidedPenalties,
        },
        inspections,
        severity,
        topProducts: topProducts.map((row) => ({
          productId: row.productId,
          productName: productNames.get(row.productId) ?? null,
          lines: row._count._all,
          quantity: row._sum.quantity ?? 0,
          suggestedAmount: (row._sum.suggestedAmount ?? 0n).toString(),
        })),
      };
    });
  }
}
