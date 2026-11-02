import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { SubscriptionPolicyService, RESTRICTED_MESSAGE } from './subscription-policy.service.js';
import { BLOCK_IN_RESTRICTED_MODE } from './subscription.decorator.js';
import { TenantService } from '../tenant/tenant.service.js';
import { ApiError, ErrorCode } from '../common/errors.js';

/**
 * Guard restricted mode — dijalankan setelah SessionGuard/CsrfGuard pada
 * handler yang ditandai `@BlockInRestrictedMode()`.
 *
 * Pemeriksaan membership dilakukan lebih dulu agar aktor tanpa akses tenant
 * tetap menerima 403 yang sama seperti sebelumnya, bukan informasi status
 * langganan tenant lain. Policy sendiri dievaluasi dari data server-side.
 */
@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly policy: SubscriptionPolicyService,
    private readonly tenantService: TenantService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const blocked = this.reflector.getAllAndOverride<boolean>(BLOCK_IN_RESTRICTED_MODE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!blocked) return true;

    const req = context
      .switchToHttp()
      .getRequest<Request & { session?: { userId: string } }>();
    const rawTenantId = req.params?.tenantId;
    const tenantId = Array.isArray(rawTenantId) ? rawTenantId[0] : rawTenantId;
    // Route tenant-scoped selalu membawa tenantId; route lain tidak terkena
    // aturan ini sampai resolver tenant publik tersedia.
    if (!tenantId) return true;

    if (!req.session) {
      throw new ApiError(ErrorCode.UNAUTHENTICATED, 'Autentikasi diperlukan.');
    }

    await this.tenantService.requireMembership(tenantId, req.session.userId, [
      'OWNER',
      'MANAGER',
      'STAFF',
      'CASHIER',
    ]);

    const entitlement = await this.policy.evaluate(tenantId);
    if (!entitlement) {
      throw new ApiError(ErrorCode.NOT_FOUND, 'Tenant tidak ditemukan.');
    }
    if (entitlement.restricted) {
      throw new ApiError(ErrorCode.TENANT_RESTRICTED, RESTRICTED_MESSAGE);
    }
    return true;
  }
}
