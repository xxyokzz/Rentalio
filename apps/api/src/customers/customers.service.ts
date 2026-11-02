import { Injectable } from '@nestjs/common';
import type { Prisma } from '@rentalio/database';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { TenantService } from '../tenant/tenant.service.js';
import { ApiError, ErrorCode } from '../common/errors.js';
import type { CreateCustomerDto, ListCustomersQueryDto } from './customers.dto.js';

const DEFAULT_LIMIT = 50;

type CustomerRow = Prisma.CustomerGetPayload<Record<string, never>>;

/**
 * Direktori pelanggan tenant (Notion 04 — `GET/POST /tenants/:id/customers`).
 *
 * - Seluruh query berjalan dengan konteks tenant (RLS fail-closed) dan izin
 *   `customer.read` / `customer.write`.
 * - Email dinormalisasi lowercase dan nama di-trim sebelum disimpan.
 * - Email atau nomor yang sudah dipakai pelanggan lain di tenant yang sama
 *   ditolak 422 agar data kontak tidak terpecah menjadi dua baris.
 * - Pelanggan buatan staff selalu `isGuest: false`; pelanggan dari booking
 *   tamu dibuat oleh alur booking dengan `isGuest: true`.
 */
@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tenantService: TenantService,
  ) {}

  async listCustomers(
    tenantId: string,
    query: ListCustomersQueryDto,
    actorUserId: string,
  ) {
    await this.tenantService.requirePermission(tenantId, actorUserId, 'customer.read');
    const limit = query.limit ?? DEFAULT_LIMIT;
    const offset = query.offset ?? 0;
    const q = query.q?.trim();

    return this.prisma.withTenant(tenantId, async (tx) => {
      const where: Prisma.CustomerWhereInput = {
        tenantId,
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: 'insensitive' as const } },
                { email: { contains: q, mode: 'insensitive' as const } },
                { phone: { contains: q } },
              ],
            }
          : {}),
      };

      const [rows, total] = await Promise.all([
        tx.customer.findMany({
          where,
          orderBy: [{ name: 'asc' }, { createdAt: 'asc' }],
          take: limit,
          skip: offset,
        }),
        tx.customer.count({ where }),
      ]);

      return {
        items: rows.map((row) => this.mapCustomer(row)),
        total,
        limit,
        offset,
      };
    });
  }

  async createCustomer(tenantId: string, dto: CreateCustomerDto, ctx: Ctx) {
    await this.tenantService.requirePermission(tenantId, ctx.actorUserId, 'customer.write');
    const name = dto.name.trim();
    if (name.length < 2) {
      throw new ApiError(ErrorCode.VALIDATION_ERROR, 'Nama pelanggan terlalu pendek.');
    }
    const email = dto.email?.trim().toLowerCase() || null;
    const phone = dto.phone?.trim() || null;

    return this.prisma.withTenant(tenantId, async (tx) => {
      if (email || phone) {
        const duplicate = await tx.customer.findFirst({
          where: {
            tenantId,
            OR: [
              ...(email ? [{ email }] : []),
              ...(phone ? [{ phone }] : []),
            ],
          },
          select: { id: true, name: true },
        });
        if (duplicate) {
          throw new ApiError(
            ErrorCode.BUSINESS_RULE_VIOLATION,
            'Pelanggan dengan email atau nomor ini sudah terdaftar.',
            { customerId: duplicate.id, customerName: duplicate.name },
          );
        }
      }

      const customer = await tx.customer.create({
        data: { tenantId, name, email, phone, isGuest: false },
      });

      await this.audit.record(
        {
          tenantId,
          actorUserId: ctx.actorUserId,
          action: 'CUSTOMER_CREATED',
          domain: 'customer',
          entityType: 'customer',
          entityId: customer.id,
          toState: 'ACTIVE',
          correlationId: ctx.correlationId,
          metadata: {
            hasEmail: email !== null,
            hasPhone: phone !== null,
          },
        },
        tx,
      );

      return this.mapCustomer(customer);
    });
  }

  /** Bentuk publik pelanggan; email/nomor hanya untuk member berizin. */
  private mapCustomer(row: CustomerRow) {
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      phone: row.phone,
      isGuest: row.isGuest,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

type Ctx = { actorUserId: string; correlationId: string };
