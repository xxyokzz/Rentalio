import { Injectable } from '@nestjs/common';
import type { Prisma } from '@rentalio/database';
import { PrismaService } from '../prisma/prisma.service.js';
import { ApiError, ErrorCode } from '../common/errors.js';

/**
 * Domain policy subscription — satu-satunya tempat aturan entitlement
 * diterjemahkan (dokumen 10 & 04):
 *
 * - Trial berakhir tepat 72 jam setelah `activatedAt` (server-side).
 * - Renewal gagal: grace 3 hari kalender; setelah grace berakhir → RESTRICTED.
 * - Restricted mode menolak booking/order/POS baru serta perubahan katalog,
 *   harga, dan inventaris. Baca/laporan dan penyelesaian order aktif tetap
 *   diizinkan lewat pengecualian eksplisit di controller.
 *
 * Status efektif dihitung dari tanggal tersimpan, bukan dari jam browser.
 * Baris subscription boleh belum ada (tenant lama / plan belum di-seed),
 * sehingga trial tenant tetap menjadi fallback yang fail-closed.
 */

/** Status efektif yang dipakai guard (status DB + hasil evaluasi tanggal). */
export type EffectiveSubscriptionStatus =
  | 'TRIALING'
  | 'ACTIVE'
  | 'PAST_DUE'
  | 'RESTRICTED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'NONE';

export type SubscriptionEntitlementReason =
  | 'TRIAL'
  | 'ACTIVE_SUBSCRIPTION'
  | 'GRACE_PERIOD'
  | 'TRIAL_EXPIRED'
  | 'GRACE_EXPIRED'
  | 'SUBSCRIPTION_RESTRICTED'
  | 'SUBSCRIPTION_CANCELLED'
  | 'SUBSCRIPTION_EXPIRED'
  | 'NO_ENTITLEMENT';

export interface SubscriptionEntitlement {
  tenantId: string;
  /** Status efektif setelah tanggal trial/grace/period dievaluasi. */
  status: EffectiveSubscriptionStatus;
  restricted: boolean;
  reason: SubscriptionEntitlementReason;
  subscriptionId: string | null;
  trialEndsAt: Date | null;
  graceEndsAt: Date | null;
  periodEnd: Date | null;
}

/** Batas trial awal: 72 jam sejak aktivasi tenant. */
const TRIAL_DURATION_MS = 72 * 3600 * 1000;
/** Grace renewal gagal: 3 hari kalender (dipakai bila graceEndsAt tidak tersimpan). */
const GRACE_DURATION_MS = 3 * 24 * 3600 * 1000;

function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}

@Injectable()
export class SubscriptionPolicyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Evaluasi entitlement tenant. Mengembalikan `null` bila tenant tidak ada
   * (pemanggil yang memutuskan 404; guard tidak boleh membocorkan tenant lain).
   */
  async evaluate(
    tenantId: string,
    tx?: Prisma.TransactionClient,
    now: Date = new Date(),
  ): Promise<SubscriptionEntitlement | null> {
    const load = async (client: Prisma.TransactionClient) => {
      const tenant = await client.tenant.findUnique({
        where: { id: tenantId },
        select: { id: true, activatedAt: true, trialEndsAt: true },
      });
      if (!tenant) return null;

      const subscription = await client.subscription.findFirst({
        where: { tenantId },
        // Urutan deterministik bila dua baris dibuat pada milidetik yang sama.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });

      return this.compute(tenant, subscription, now);
    };

    if (tx) return load(tx);
    return this.prisma.withTenant(tenantId, load);
  }

  /**
   * Guard untuk command yang menambah komitmen baru (booking/order/POS) atau
   * mengubah katalog/harga/inventaris. Melempar 403 TENANT_RESTRICTED.
   */
  async assertTransactionAllowed(tenantId: string): Promise<SubscriptionEntitlement> {
    const entitlement = await this.evaluate(tenantId);
    if (!entitlement) {
      throw new ApiError(ErrorCode.NOT_FOUND, 'Tenant tidak ditemukan.');
    }
    if (entitlement.restricted) {
      throw new ApiError(ErrorCode.TENANT_RESTRICTED, RESTRICTED_MESSAGE);
    }
    return entitlement;
  }

  /** Murni: hitung status efektif dari tenant + subscription (tanpa I/O). */
  compute(
    tenant: { id: string; activatedAt: Date | null; trialEndsAt: Date | null },
    subscription: {
      id: string;
      status: string;
      trialEndsAt: Date | null;
      periodEnd: Date | null;
      graceStartedAt: Date | null;
      graceEndsAt: Date | null;
    } | null,
    now: Date = new Date(),
  ): SubscriptionEntitlement {
    const base = {
      tenantId: tenant.id,
      subscriptionId: subscription?.id ?? null,
      trialEndsAt: null as Date | null,
      graceEndsAt: null as Date | null,
      periodEnd: subscription?.periodEnd ?? null,
    };

    // Tanpa subscription: trial tenant adalah satu-satunya entitlement.
    if (!subscription) {
      const trialEndsAt =
        tenant.trialEndsAt ??
        (tenant.activatedAt ? addMs(tenant.activatedAt, TRIAL_DURATION_MS) : null);
      if (trialEndsAt && now < trialEndsAt) {
        return { ...base, trialEndsAt, status: 'TRIALING', restricted: false, reason: 'TRIAL' };
      }
      return {
        ...base,
        trialEndsAt,
        status: trialEndsAt ? 'RESTRICTED' : 'NONE',
        restricted: true,
        reason: trialEndsAt ? 'TRIAL_EXPIRED' : 'NO_ENTITLEMENT',
      };
    }

    const trialEndsAt =
      subscription.trialEndsAt ??
      tenant.trialEndsAt ??
      (tenant.activatedAt ? addMs(tenant.activatedAt, TRIAL_DURATION_MS) : null);

    switch (subscription.status) {
      case 'ACTIVE': {
        // Paid period yang sudah lewat tanpa renewal sukses tetap mendapat
        // grace 3 hari (bila billing belum sempat menulis PAST_DUE).
        if (subscription.periodEnd && now >= subscription.periodEnd) {
          const graceEndsAt =
            subscription.graceEndsAt ?? addMs(subscription.periodEnd, GRACE_DURATION_MS);
          if (now < graceEndsAt) {
            return {
              ...base,
              trialEndsAt,
              graceEndsAt,
              status: 'ACTIVE',
              restricted: false,
              reason: 'GRACE_PERIOD',
            };
          }
          return {
            ...base,
            trialEndsAt,
            graceEndsAt,
            status: 'RESTRICTED',
            restricted: true,
            reason: 'GRACE_EXPIRED',
          };
        }
        return {
          ...base,
          trialEndsAt,
          status: 'ACTIVE',
          restricted: false,
          reason: 'ACTIVE_SUBSCRIPTION',
        };
      }

      case 'TRIALING': {
        if (trialEndsAt && now < trialEndsAt) {
          return { ...base, trialEndsAt, status: 'TRIALING', restricted: false, reason: 'TRIAL' };
        }
        return {
          ...base,
          trialEndsAt,
          status: 'RESTRICTED',
          restricted: true,
          reason: trialEndsAt ? 'TRIAL_EXPIRED' : 'NO_ENTITLEMENT',
        };
      }

      case 'PAST_DUE': {
        const fallbackStart = subscription.periodEnd ?? subscription.graceStartedAt;
        const graceEndsAt =
          subscription.graceEndsAt ??
          (fallbackStart ? addMs(fallbackStart, GRACE_DURATION_MS) : null);
        if (graceEndsAt && now < graceEndsAt) {
          return {
            ...base,
            trialEndsAt,
            graceEndsAt,
            status: 'PAST_DUE',
            restricted: false,
            reason: 'GRACE_PERIOD',
          };
        }
        return {
          ...base,
          trialEndsAt,
          graceEndsAt,
          status: 'RESTRICTED',
          restricted: true,
          reason: graceEndsAt ? 'GRACE_EXPIRED' : 'NO_ENTITLEMENT',
        };
      }

      case 'CANCELLED':
        return {
          ...base,
          trialEndsAt,
          status: 'CANCELLED',
          restricted: true,
          reason: 'SUBSCRIPTION_CANCELLED',
        };

      case 'EXPIRED':
        return {
          ...base,
          trialEndsAt,
          status: 'EXPIRED',
          restricted: true,
          reason: 'SUBSCRIPTION_EXPIRED',
        };

      case 'RESTRICTED':
      default:
        return {
          ...base,
          trialEndsAt,
          status: 'RESTRICTED',
          restricted: true,
          reason: 'SUBSCRIPTION_RESTRICTED',
        };
    }
  }
}

export const RESTRICTED_MESSAGE =
  'Langganan tenant tidak aktif. Transaksi baru serta perubahan katalog, harga, dan inventaris dinonaktifkan sampai langganan aktif kembali.';
