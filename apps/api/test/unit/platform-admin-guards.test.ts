import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  PLATFORM_ADMIN_CSRF_HEADER,
  PLATFORM_ADMIN_PERMISSION_KEY,
  PlatformAdminCsrfGuard,
  PlatformAdminGuard,
  PlatformPermissionGuard,
  type PlatformAdminPrincipal,
} from '../../src/platform-admin/platform-admin.auth.js';
import type { PlatformAdminService } from '../../src/platform-admin/platform-admin.service.js';
import { ApiError, ErrorCode } from '../../src/common/errors.js';

/**
 * Guard diuji tanpa database: yang dibuktikan di sini adalah aturan
 * deny-by-default dan penolakan Origin/token CSRF, bukan query Prisma.
 */

const ADMIN_ORIGIN = 'http://localhost:3002';

const principal: PlatformAdminPrincipal = {
  id: '10000000-0000-4000-8000-000000000001',
  email: 'admin@rentalio.my.id',
  sessionId: '10000000-0000-4000-8000-000000000002',
  permissions: ['platform.tenants.list'],
  roles: ['PLATFORM_SUPPORT'],
  reauthenticatedAt: null,
};

function httpContext(request: Record<string, unknown>, handler = () => undefined): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => class TestController {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

/** Service pengganti: hanya bagian yang dipakai guard. */
function stubService(overrides: Partial<Record<string, unknown>> = {}): PlatformAdminService {
  return {
    adminOrigin: ADMIN_ORIGIN,
    // Membaca metadata yang sama seperti Reflector, tanpa perlu instance Nest.
    requiredPermission: (handler: object) =>
      Reflect.getMetadata(PLATFORM_ADMIN_PERMISSION_KEY, handler) as string | undefined,
    validateCsrf: async () => true,
    resolveSession: async () => null,
    ...overrides,
  } as unknown as PlatformAdminService;
}

/** Guard permission bersifat sinkron; ambil kode error tanpa melempar ke test. */
function codeFrom(fn: () => boolean): ErrorCode | null {
  try {
    fn();
    return null;
  } catch (error) {
    if (error instanceof ApiError) return error.code;
    throw error;
  }
}

describe('PlatformPermissionGuard (RBAC deny-by-default)', () => {
  it('menolak handler tanpa deklarasi permission walau principal punya banyak izin', () => {
    const guard = new PlatformPermissionGuard(stubService());
    const ctx = httpContext({ platformAdmin: principal });
    expect(codeFrom(() => guard.canActivate(ctx))).toBe(ErrorCode.PERMISSION_DENIED);
  });

  it('menolak principal tanpa permission yang diminta', () => {
    const handler = () => undefined;
    Reflect.defineMetadata(PLATFORM_ADMIN_PERMISSION_KEY, 'platform.tenants.suspend', handler);
    const guard = new PlatformPermissionGuard(stubService());
    expect(
      codeFrom(() => guard.canActivate(httpContext({ platformAdmin: principal }, handler))),
    ).toBe(ErrorCode.PERMISSION_DENIED);
  });

  it('mengizinkan principal yang memang memiliki permission tersebut', () => {
    const handler = () => undefined;
    Reflect.defineMetadata(PLATFORM_ADMIN_PERMISSION_KEY, 'platform.tenants.list', handler);
    const guard = new PlatformPermissionGuard(stubService());
    expect(guard.canActivate(httpContext({ platformAdmin: principal }, handler))).toBe(true);
  });

  it('menolak request tanpa sesi admin', () => {
    const handler = () => undefined;
    Reflect.defineMetadata(PLATFORM_ADMIN_PERMISSION_KEY, 'platform.tenants.list', handler);
    const guard = new PlatformPermissionGuard(stubService());
    expect(codeFrom(() => guard.canActivate(httpContext({}, handler)))).toBe(
      ErrorCode.PERMISSION_DENIED,
    );
  });
});

describe('PlatformAdminGuard', () => {
  it('menolak request tanpa cookie admin', async () => {
    const guard = new PlatformAdminGuard(stubService());
    await expect(guard.canActivate(httpContext({ cookies: {} }))).rejects.toMatchObject({
      code: ErrorCode.UNAUTHENTICATED,
    });
  });

  it('menerima sesi yang berhasil diresolusi dari cookie', async () => {
    const guard = new PlatformAdminGuard(
      stubService({ resolveSession: async () => principal }),
    );
    const request: Record<string, unknown> = { cookies: { rentalio_platform_admin: 'token' } };
    await expect(guard.canActivate(httpContext(request))).resolves.toBe(true);
    expect(request.platformAdmin).toEqual(principal);
  });
});

describe('PlatformAdminCsrfGuard', () => {
  const csrfContext = (origin?: string, token?: string) =>
    httpContext({
      platformAdmin: principal,
      header: (name: string) =>
        name === 'origin' ? origin : name === PLATFORM_ADMIN_CSRF_HEADER ? token : undefined,
    });

  it('menolak Origin yang bukan origin Admin Platform', async () => {
    const guard = new PlatformAdminCsrfGuard(stubService());
    await expect(guard.canActivate(csrfContext('https://tenant.example.com', 'abc'))).rejects.toMatchObject(
      { code: ErrorCode.CSRF_VALIDATION_FAILED },
    );
  });

  it('menolak request tanpa Origin (bukan sekadar allowlist CORS)', async () => {
    const guard = new PlatformAdminCsrfGuard(stubService());
    await expect(guard.canActivate(csrfContext(undefined, 'abc'))).rejects.toMatchObject({
      code: ErrorCode.CSRF_VALIDATION_FAILED,
    });
  });

  it('menolak token CSRF yang tidak valid', async () => {
    const guard = new PlatformAdminCsrfGuard(stubService({ validateCsrf: async () => false }));
    await expect(guard.canActivate(csrfContext(ADMIN_ORIGIN, 'salah'))).rejects.toMatchObject({
      code: ErrorCode.CSRF_VALIDATION_FAILED,
    });
  });

  it('menerima Origin + token yang valid', async () => {
    const guard = new PlatformAdminCsrfGuard(stubService());
    await expect(guard.canActivate(csrfContext(ADMIN_ORIGIN, 'abc'))).resolves.toBe(true);
  });
});
