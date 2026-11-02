import { Injectable } from '@nestjs/common';
import type { Prisma } from '@rentalio/database';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { TenantService } from '../tenant/tenant.service.js';
import { ApiError, ErrorCode } from '../common/errors.js';
import {
  PAYMENT_CONTEXTS,
  PAYMENT_METHOD_VALUES,
  type UpdatePaymentMethodsDto,
} from './payment-settings.dto.js';

type Ctx = { actorUserId: string; correlationId: string };
type SettingRow = Prisma.TenantPaymentMethodSettingGetPayload<Record<string, never>>;

const MANAGE_PERMISSION = 'settings.payment_methods.manage';

/**
 * Matriks metode pembayaran per tenant × konteks × metode.
 *
 * Baris yang belum ada berarti **aktif** (default). Tenant lama tidak perlu
 * backfill; menonaktifkan metode cukup menulis baris eksplisit. Setiap
 * konteks yang menerima pembayaran wajib menyisakan minimal satu metode
 * aktif — aturan agregat ini diperiksa dalam transaksi yang sama dengan
 * penulisan matriks.
 */
@Injectable()
export class PaymentSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tenantService: TenantService,
  ) {}

  async list(tenantId: string, actorUserId: string) {
    await this.tenantService.requirePermission(tenantId, actorUserId, 'payment.read');
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.tenantPaymentMethodSetting.findMany({ where: { tenantId } });
      return { settings: this.buildMatrix(rows) };
    });
  }

  async update(tenantId: string, dto: UpdatePaymentMethodsDto, ctx: Ctx) {
    await this.tenantService.requirePermission(tenantId, ctx.actorUserId, MANAGE_PERMISSION);

    const seen = new Set<string>();
    for (const entry of dto.settings) {
      const key = `${entry.context}:${entry.method}`;
      if (seen.has(key)) {
        throw new ApiError(
          ErrorCode.VALIDATION_ERROR,
          `Duplikat konfigurasi untuk konteks ${entry.context} dan metode ${entry.method}.`,
        );
      }
      seen.add(key);
    }

    return this.prisma.withTenant(tenantId, async (tx) => {
      // Serialisasi perubahan matriks per tenant: dua PUT paralel tidak boleh
      // sama-sama lolos lalu menyisakan nol metode aktif pada satu konteks.
      await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${tenantId} FOR UPDATE`;
      const currentRows = await tx.tenantPaymentMethodSetting.findMany({ where: { tenantId } });
      const effective = this.buildMatrix(currentRows);

      const changes = new Map(
        effective.map((setting) => [`${setting.context}:${setting.method}`, setting.enabled]),
      );
      for (const entry of dto.settings) {
        changes.set(`${entry.context}:${entry.method}`, entry.enabled);
      }

      // Setiap konteks harus tetap memiliki minimal satu metode aktif.
      for (const context of PAYMENT_CONTEXTS) {
        const anyEnabled = PAYMENT_METHOD_VALUES.some((method) =>
          changes.get(`${context}:${method}`),
        );
        if (!anyEnabled) {
          throw new ApiError(
            ErrorCode.BUSINESS_RULE_VIOLATION,
            `Konteks ${context} harus memiliki minimal satu metode pembayaran aktif.`,
          );
        }
      }

      for (const entry of dto.settings) {
        await tx.tenantPaymentMethodSetting.upsert({
          where: {
            tenantId_context_method: {
              tenantId,
              context: entry.context,
              method: entry.method,
            },
          },
          create: {
            tenantId,
            context: entry.context,
            method: entry.method,
            enabled: entry.enabled,
            updatedByUserId: ctx.actorUserId,
          },
          update: {
            enabled: entry.enabled,
            updatedByUserId: ctx.actorUserId,
          },
        });
      }

      await this.audit.record(
        {
          tenantId,
          actorUserId: ctx.actorUserId,
          action: 'PAYMENT_METHOD_SETTINGS_UPDATED',
          domain: 'payment',
          entityType: 'tenant_payment_method_settings',
          entityId: tenantId,
          correlationId: ctx.correlationId,
          metadata: {
            changes: dto.settings.map((entry) => ({
              context: entry.context,
              method: entry.method,
              enabled: entry.enabled,
            })),
          },
        },
        tx,
      );

      const rows = await tx.tenantPaymentMethodSetting.findMany({ where: { tenantId } });
      return { settings: this.buildMatrix(rows) };
    });
  }

  /**
   * Dipakai command pembayaran di dalam transaksi yang sama. Baris yang belum
   * ada = aktif. Metode nonaktif ditolak walau request langsung ke API.
   */
  async assertMethodEnabled(
    tx: Prisma.TransactionClient,
    tenantId: string,
    context: (typeof PAYMENT_CONTEXTS)[number],
    method: (typeof PAYMENT_METHOD_VALUES)[number],
  ): Promise<void> {
    const row = await tx.tenantPaymentMethodSetting.findUnique({
      where: { tenantId_context_method: { tenantId, context, method } },
    });
    if (row && !row.enabled) {
      throw new ApiError(
        ErrorCode.PAYMENT_METHOD_DISABLED,
        `Metode ${method} tidak aktif untuk konteks ${context}.`,
      );
    }
  }

  private buildMatrix(rows: SettingRow[]) {
    const byKey = new Map(rows.map((row) => [`${row.context}:${row.method}`, row]));
    return PAYMENT_CONTEXTS.flatMap((context) =>
      PAYMENT_METHOD_VALUES.map((method) => {
        const row = byKey.get(`${context}:${method}`);
        return {
          context,
          method,
          enabled: row?.enabled ?? true,
          updatedByUserId: row?.updatedByUserId ?? null,
          updatedAt: row?.updatedAt ?? null,
        };
      }),
    );
  }
}
