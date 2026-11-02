import { Injectable } from '@nestjs/common';
import type { Prisma } from '@rentalio/database';
import { PrismaService } from '../prisma/prisma.service.js';

export interface AuditEventInput {
  tenantId?: string | null;
  actorUserId?: string | null;
  action: string;
  domain: string;
  entityType?: string;
  entityId?: string;
  fromState?: string;
  toState?: string;
  reason?: string;
  correlationId: string;
  metadata?: Record<string, unknown>;
}

/**
 * Audit log append-only. Dilarang menyimpan OTP, token reset, cookie,
 * password, atau secret provider (dokumen 10, keputusan final #15).
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(event: AuditEventInput, tx?: Prisma.TransactionClient): Promise<void> {
    const client = tx ?? this.prisma.client;
    await client.auditLog.create({
      data: {
        tenantId: event.tenantId ?? null,
        actorUserId: event.actorUserId ?? null,
        action: event.action,
        domain: event.domain,
        entityType: event.entityType,
        entityId: event.entityId,
        fromState: event.fromState,
        toState: event.toState,
        reason: event.reason,
        correlationId: event.correlationId,
        metadata: event.metadata ? (event.metadata as Prisma.InputJsonValue) : undefined,
      },
    });
  }
}
