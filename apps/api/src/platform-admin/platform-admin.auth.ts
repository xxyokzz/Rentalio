import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  createParamDecorator,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiError, ErrorCode } from '../common/errors.js';
import { PlatformAdminService } from './platform-admin.service.js';

/**
 * Cookie dan header khusus Admin Platform.
 *
 * Sengaja memakai nama cookie berbeda dari `rentalio_session`: sesi tenant dan
 * sesi admin adalah dua dunia terpisah. Cookie ditetapkan host-only untuk
 * origin admin, sehingga cookie tenant tidak pernah menjadi bukti identitas
 * admin dan sebaliknya.
 */
export const PLATFORM_ADMIN_COOKIE = 'rentalio_platform_admin';
export const PLATFORM_ADMIN_CSRF_HEADER = 'x-platform-admin-csrf';
export const PLATFORM_ADMIN_PERMISSION_KEY = 'platformAdminPermission';

export interface PlatformAdminPrincipal {
  id: string;
  email: string;
  sessionId: string;
  permissions: string[];
  roles: string[];
  reauthenticatedAt: Date | null;
}

declare module 'express-serve-static-core' {
  interface Request {
    platformAdmin?: PlatformAdminPrincipal;
  }
}

/** Tandai operasi dengan permission Admin Platform yang wajib dimiliki. */
export const RequirePlatformPermission = (permission: string) =>
  SetMetadata(PLATFORM_ADMIN_PERMISSION_KEY, permission);

export const CurrentPlatformAdmin = createParamDecorator(
  (_data: unknown, context: ExecutionContext): PlatformAdminPrincipal => {
    const principal = context.switchToHttp().getRequest<Request>().platformAdmin;
    if (!principal) throw new ApiError(ErrorCode.UNAUTHENTICATED, 'Sesi Admin Platform diperlukan.');
    return principal;
  },
);

/**
 * Resolusi sesi admin dari cookie host-only lalu tegakkan keberadaannya.
 * Middleware tidak dipakai karena guard ini hanya berlaku pada rute admin,
 * bukan seluruh aplikasi.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(private readonly admin: PlatformAdminService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    if (!req.platformAdmin) {
      const token = (req.cookies as Record<string, string> | undefined)?.[PLATFORM_ADMIN_COOKIE];
      req.platformAdmin = (await this.admin.resolveSession(token)) ?? undefined;
    }
    if (!req.platformAdmin) {
      throw new ApiError(ErrorCode.UNAUTHENTICATED, 'Sesi Admin Platform diperlukan.');
    }
    return true;
  }
}

/**
 * RBAC deny-by-default: permission wajib dideklarasikan pada handler dan harus
 * dimiliki principal. Permission dimuat dari assignment/registry di database,
 * bukan dari hostname, header, atau klaim yang dikirim klien.
 */
@Injectable()
export class PlatformPermissionGuard implements CanActivate {
  constructor(private readonly admin: PlatformAdminService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const permission = this.admin.requiredPermission(context.getHandler(), context.getClass());
    if (!permission) {
      throw new ApiError(ErrorCode.PERMISSION_DENIED, 'Izin Admin Platform tidak diberikan.');
    }
    if (!req.platformAdmin?.permissions.includes(permission)) {
      throw new ApiError(ErrorCode.PERMISSION_DENIED, 'Izin Admin Platform tidak diberikan.');
    }
    return true;
  }
}

/**
 * CSRF untuk mutasi berbasis cookie admin: Origin harus persis sama dengan
 * origin Admin Platform yang dikonfigurasi (bukan sekadar ada di allowlist
 * CORS), dan token harus cocok dengan hash terikat sesi.
 */
@Injectable()
export class PlatformAdminCsrfGuard implements CanActivate {
  constructor(private readonly admin: PlatformAdminService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const principal = req.platformAdmin;
    if (!principal) {
      throw new ApiError(ErrorCode.UNAUTHENTICATED, 'Sesi Admin Platform diperlukan.');
    }
    const origin = req.header('origin');
    if (!origin || origin !== this.admin.adminOrigin) {
      throw new ApiError(ErrorCode.CSRF_VALIDATION_FAILED, 'Origin Admin Platform tidak diizinkan.');
    }
    const token = req.header(PLATFORM_ADMIN_CSRF_HEADER);
    if (!token || !(await this.admin.validateCsrf(principal.sessionId, token))) {
      throw new ApiError(ErrorCode.CSRF_VALIDATION_FAILED, 'Token CSRF Admin Platform tidak valid.');
    }
    return true;
  }
}
