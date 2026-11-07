import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';
import {
  REAUTH_WINDOW_MS,
  PlatformRecentAuthGuard,
  type PlatformAdminPrincipal,
} from '../../src/platform-admin/platform-admin.auth.js';
import { PlatformAdminController } from '../../src/platform-admin/platform-admin.controller.js';
import type { PlatformAdminService } from '../../src/platform-admin/platform-admin.service.js';
import type { PlatformTenantDirectoryService } from '../../src/platform-admin/platform-directory.service.js';
import type { PlatformAdminDirectoryService } from '../../src/platform-admin/platform-admin-directory.service.js';
import type { PlatformAuditService } from '../../src/platform-admin/platform-audit.service.js';
import type { PlatformRoleAssignmentService } from '../../src/platform-admin/platform-roles.service.js';
import type { PlatformBillingService } from '../../src/platform-admin/platform-billing.service.js';
import type { PlatformCronService } from '../../src/platform-admin/platform-cron.service.js';
import type { AppConfig } from '../../src/config/env.validation.js';
import { ApiError, ErrorCode } from '../../src/common/errors.js';

/**
 * Re-authentication diuji tanpa database: yang dibuktikan adalah aturan jendela
 * waktu pada guard, penerusan parameter rute `POST /platform-admin/auth/reauth`,
 * dan pemasangan guard pada tindakan berisiko. Ketiganya mudah hilang tanpa
 * sengaja saat controller diubah, jadi dikunci di sini.
 */

/** Nest menyimpan daftar guard pada metadata `__guards__` milik handler. */
const GUARDS_METADATA = '__guards__';

const ADMIN_ORIGIN = 'http://localhost:3002';

const RISKY_HANDLERS = [
  'suspendTenant',
  'reactivateTenant',
  'settleSubscriptionInvoice',
  'assignRole',
  'revokeRole',
] as const;

const READ_ONLY_HANDLERS = ['listTenants', 'getTenant', 'current'] as const;

function principal(overrides: Partial<PlatformAdminPrincipal> = {}): PlatformAdminPrincipal {
  return {
    id: '10000000-0000-4000-8000-000000000001',
    email: 'admin@rentalio.my.id',
    sessionId: '10000000-0000-4000-8000-000000000002',
    permissions: ['platform.subscriptions.settle'],
    roles: ['PLATFORM_SUPER_ADMIN'],
    reauthenticatedAt: new Date(),
    ...overrides,
  };
}

function httpContext(request: Record<string, unknown>): ExecutionContext {
  return {
    getHandler: () => () => undefined,
    getClass: () => class TestController {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

/** Guard re-auth bersifat sinkron; ambil kode error tanpa melempar ke test. */
function codeFrom(fn: () => boolean): ErrorCode | null {
  try {
    fn();
    return null;
  } catch (error) {
    if (error instanceof ApiError) return error.code;
    throw error;
  }
}

function guardsOf(handler: string): unknown[] {
  const target = (PlatformAdminController.prototype as unknown as Record<string, unknown>)[handler];
  return (Reflect.getMetadata(GUARDS_METADATA, target as object) as unknown[] | undefined) ?? [];
}

function controllerWith(reauthenticate: PlatformAdminService['reauthenticate']) {
  return new PlatformAdminController(
    { reauthenticate, adminOrigin: ADMIN_ORIGIN } as unknown as PlatformAdminService,
    {} as unknown as PlatformTenantDirectoryService,
    {} as unknown as PlatformAdminDirectoryService,
    {} as unknown as PlatformAuditService,
    {} as unknown as PlatformRoleAssignmentService,
    {} as unknown as PlatformBillingService,
    {} as unknown as PlatformCronService,
    { COOKIE_SECURE: false } as unknown as AppConfig,
  );
}

describe('PlatformRecentAuthGuard', () => {
  const guard = new PlatformRecentAuthGuard();

  it('menolak request tanpa sesi admin', () => {
    expect(codeFrom(() => guard.canActivate(httpContext({})))).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it('menolak sesi yang belum pernah re-authentication', () => {
    const request = { platformAdmin: principal({ reauthenticatedAt: null }) };
    expect(codeFrom(() => guard.canActivate(httpContext(request)))).toBe(
      ErrorCode.REAUTHENTICATION_REQUIRED,
    );
  });

  it('menolak re-auth yang lebih tua dari jendela 10 menit', () => {
    const request = {
      platformAdmin: principal({ reauthenticatedAt: new Date(Date.now() - REAUTH_WINDOW_MS - 1_000) }),
    };
    expect(codeFrom(() => guard.canActivate(httpContext(request)))).toBe(
      ErrorCode.REAUTHENTICATION_REQUIRED,
    );
  });

  it('menerima re-auth yang masih segar', () => {
    const request = {
      platformAdmin: principal({ reauthenticatedAt: new Date(Date.now() - REAUTH_WINDOW_MS + 30_000) }),
    };
    expect(guard.canActivate(httpContext(request))).toBe(true);
  });

  it('menerima re-auth tepat pada batas jendela', () => {
    const request = {
      platformAdmin: principal({ reauthenticatedAt: new Date(Date.now() - REAUTH_WINDOW_MS) }),
    };
    expect(guard.canActivate(httpContext(request))).toBe(true);
  });
});

describe('POST /platform-admin/auth/reauth', () => {
  it('meneruskan sesi, password, kode, dan IP ke service', async () => {
    const at = new Date('2026-11-07T14:00:00.000Z');
    const reauthenticate = vi.fn().mockResolvedValue({ reauthenticatedAt: at });
    const controller = controllerWith(reauthenticate);
    const admin = principal();

    const result = await controller.reauthenticate(
      { password: 'KataSandi-Uji-2026!', code: '123456' },
      admin,
      { ip: '10.1.2.3' } as Request,
    );

    expect(reauthenticate).toHaveBeenCalledWith(
      admin.sessionId,
      'KataSandi-Uji-2026!',
      '123456',
      '10.1.2.3',
    );
    expect(result).toEqual({ data: { reauthenticatedAt: at } });
  });

  it('memakai penanda IP "unknown" bila request tidak membawa IP', async () => {
    const reauthenticate = vi.fn().mockResolvedValue({ reauthenticatedAt: new Date() });
    const controller = controllerWith(reauthenticate);

    await controller.reauthenticate(
      { password: 'KataSandi-Uji-2026!', code: '123456' },
      principal(),
      {} as Request,
    );

    expect(reauthenticate).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(String), 'unknown');
  });

  it('meneruskan kegagalan kredensial dari service apa adanya', async () => {
    const reauthenticate = vi
      .fn()
      .mockRejectedValue(new ApiError(ErrorCode.INVALID_CREDENTIALS, 'Email atau password salah.'));
    const controller = controllerWith(reauthenticate);

    await expect(
      controller.reauthenticate(
        { password: 'salah', code: '123456' },
        principal(),
        { ip: '10.1.2.3' } as Request,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_CREDENTIALS });
  });

  it('digerbangi CSRF admin, bukan recent-auth (re-auth adalah jalan keluarnya)', () => {
    const guards = guardsOf('reauthenticate');
    expect(guards.length).toBeGreaterThan(0);
    expect(guards).not.toContain(PlatformRecentAuthGuard);
  });
});

describe('pemasangan PlatformRecentAuthGuard pada tindakan berisiko', () => {
  it.each(RISKY_HANDLERS)('mewajibkan re-auth pada %s', (handler) => {
    expect(guardsOf(handler)).toContain(PlatformRecentAuthGuard);
  });

  it.each(READ_ONLY_HANDLERS)('tidak mewajibkan re-auth pada %s', (handler) => {
    expect(guardsOf(handler)).not.toContain(PlatformRecentAuthGuard);
  });
});
