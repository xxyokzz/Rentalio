import type { Prisma } from '@rentalio/database';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * Audit trail Admin Platform (`platform_audit_events`, append-only).
 *
 * Ditulis di transaksi yang sama dengan operasinya bila memungkinkan, sehingga
 * tidak ada akses data admin yang tercatat "setengah". Metadata hanya berisi
 * konteks operasional (filter, jumlah baris) — tidak pernah secret, token,
 * atau isi PII.
 */
export type PlatformAuditClient = Prisma.TransactionClient | PrismaService['client'];

/**
 * Daftar aksi yang dikenal. Konstanta runtime dipakai validator query agar
 * filter audit hanya menerima aksi yang benar-benar ditulis aplikasi.
 */
export const PLATFORM_AUDIT_ACTIONS = [
  'PLATFORM_ADMIN_BOOTSTRAPPED',
  'PLATFORM_ADMIN_LOGIN_FAILED',
  'PLATFORM_ADMIN_MFA_ENROLLMENT_STARTED',
  'PLATFORM_ADMIN_MFA_ENROLLED',
  'PLATFORM_ADMIN_MFA_CHALLENGE_ISSUED',
  'PLATFORM_ADMIN_LOGIN_SUCCEEDED',
  'PLATFORM_ADMIN_RECOVERY_CODE_USED',
  'PLATFORM_ADMIN_LOGOUT',
  'PLATFORM_TENANT_DIRECTORY_VIEWED',
  'PLATFORM_TENANT_SUMMARY_VIEWED',
  'PLATFORM_TENANT_SUSPENDED',
  'PLATFORM_TENANT_REACTIVATED',
  'PLATFORM_ADMIN_ROLE_ASSIGNED',
  'PLATFORM_ADMIN_ROLE_REVOKED',
  'PLATFORM_ADMIN_DIRECTORY_VIEWED',
  'PLATFORM_ADMIN_DETAIL_VIEWED',
  'PLATFORM_SUBSCRIPTION_INVOICE_SETTLED',
] as const;

export type PlatformAuditAction = (typeof PLATFORM_AUDIT_ACTIONS)[number];

export interface PlatformAuditEvent {
  actorAdminId?: string;
  action: PlatformAuditAction;
  targetType?: string;
  targetId?: string;
  reason?: string;
  outcome?: 'SUCCESS' | 'DENIED' | 'FAILED';
  correlationId: string;
  metadata?: Record<string, unknown>;
}

export async function recordPlatformAudit(
  client: PlatformAuditClient,
  event: PlatformAuditEvent,
): Promise<void> {
  await client.platformAuditEvent.create({
    data: {
      actorAdminId: event.actorAdminId,
      action: event.action,
      targetType: event.targetType,
      targetId: event.targetId,
      reason: event.reason,
      outcome: event.outcome ?? 'SUCCESS',
      correlationId: event.correlationId,
      metadata: event.metadata as Prisma.InputJsonValue | undefined,
    },
  });
}
