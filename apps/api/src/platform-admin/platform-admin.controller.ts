import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  CurrentPlatformAdmin,
  PLATFORM_ADMIN_COOKIE,
  PlatformAdminCsrfGuard,
  PlatformAdminGuard,
  PlatformPermissionGuard,
  PlatformRecentAuthGuard,
  RequirePlatformPermission,
  type PlatformAdminPrincipal,
} from './platform-admin.auth.js';
import {
  PlatformAdminDirectoryQueryDto,
  PlatformAdminLoginDto,
  PlatformAdminMfaDto,
  PlatformAdminReauthDto,
  PlatformAdminRecoveryDto,
  PlatformAuditQueryDto,
  PlatformCronRunQueryDto,
  PlatformRoleAssignmentDto,
  PlatformSubscriptionInvoiceSettleDto,
  PlatformTenantDirectoryQueryDto,
  PlatformTenantStatusChangeDto,
} from './platform-admin.dto.js';
import { PlatformAdminService, type AdminSessionIssued } from './platform-admin.service.js';
import { PlatformAdminDirectoryService } from './platform-admin-directory.service.js';
import { PlatformTenantDirectoryService } from './platform-directory.service.js';
import { PlatformAuditService } from './platform-audit.service.js';
import { PlatformRoleAssignmentService } from './platform-roles.service.js';
import { PlatformBillingService } from './platform-billing.service.js';
import { PlatformCronService } from './platform-cron.service.js';
import type { AppConfig } from '../config/env.validation.js';

/**
 * Kontrak Admin Platform (identitas terpisah dari tenant):
 * POST   /platform-admin/auth/login      password → challenge MFA
 * POST   /platform-admin/auth/mfa        challenge + TOTP → sesi
 * POST   /platform-admin/auth/recovery   challenge + recovery code → sesi
 * POST   /platform-admin/auth/reauth     password + TOTP → segarkan re-auth sesi
 * GET    /platform-admin/session         principal + permission efektif
 * GET    /platform-admin/csrf            terbitkan token CSRF sesi
 * GET    /platform-admin/tenants         direktori tenant (metadata minimum)
 * GET    /platform-admin/tenants/:id     ringkasan satu tenant (read_summary)
 * POST   /platform-admin/tenants/:id/suspend     suspend + alasan
 * POST   /platform-admin/tenants/:id/reactivate  reactivate + alasan
 * GET    /platform-admin/cron-runs              riwayat cron + status job (dashboard.read)
 * GET    /platform-admin/audit-events             audit viewer (aktor/aksi/waktu)
 * GET    /platform-admin/admins                daftar admin + role aktif (roles.read)
 * GET    /platform-admin/admins/:adminId       detail admin + role aktif (roles.read)
 * POST   /platform-admin/admins/:id/roles/assign   tugaskan role (roles.assign)
 * POST   /platform-admin/admins/:id/roles/revoke   cabut role (roles.revoke)
 * DELETE /platform-admin/session         logout (wajib CSRF + Origin admin)
 *
 * Cookie `rentalio_platform_admin` HttpOnly, host-only, SameSite=Lax. Browser
 * mencapai API ini melalui proxy same-origin milik aplikasi admin, sehingga
 * cookie tidak pernah terkirim ke origin tenant.
 */
@ApiTags('Platform Admin')
@Controller('platform-admin')
export class PlatformAdminController {
  constructor(
    private readonly admin: PlatformAdminService,
    private readonly directory: PlatformTenantDirectoryService,
    private readonly adminDirectory: PlatformAdminDirectoryService,
    private readonly audit: PlatformAuditService,
    private readonly roleAssignments: PlatformRoleAssignmentService,
    private readonly billing: PlatformBillingService,
    private readonly cron: PlatformCronService,
    @Inject('APP_CONFIG') private readonly config: AppConfig,
  ) {}

  @Post('auth/login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Tahap 1 login admin: verifikasi password lalu terbitkan challenge MFA' })
  async login(@Body() body: PlatformAdminLoginDto, @Req() req: Request) {
    return this.admin.beginLogin(body.email, body.password, req.ip ?? 'unknown');
  }

  @Post('auth/mfa')
  @HttpCode(200)
  @ApiOperation({ summary: 'Tahap 2 login admin: verifikasi TOTP (atau enrollment) lalu buat sesi' })
  async completeMfa(
    @Body() body: PlatformAdminMfaDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.admin.completeMfa(
      body.challengeToken,
      body.code,
      req.ip ?? 'unknown',
    );
    this.applySessionCookie(res, result.session);
    return {
      csrfToken: result.session.csrfToken,
      expiresAt: result.session.expiresAt,
      ...(result.recoveryCodes ? { recoveryCodes: result.recoveryCodes } : {}),
    };
  }

  @Post('auth/recovery')
  @HttpCode(200)
  @ApiOperation({ summary: 'Login admin dengan kode pemulihan sekali pakai' })
  async loginWithRecovery(
    @Body() body: PlatformAdminRecoveryDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.admin.loginWithRecoveryCode(
      body.challengeToken,
      body.recoveryCode,
      req.ip ?? 'unknown',
    );
    this.applySessionCookie(res, session);
    return { csrfToken: session.csrfToken, expiresAt: session.expiresAt };
  }

  @Post('auth/reauth')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UseGuards(PlatformAdminGuard, PlatformAdminCsrfGuard)
  @ApiOperation({
    summary: 'Re-authentication sesi (password + TOTP) untuk tindakan berisiko',
  })
  async reauthenticate(
    @Body() body: PlatformAdminReauthDto,
    @CurrentPlatformAdmin() principal: PlatformAdminPrincipal,
    @Req() req: Request,
  ): Promise<{ data: { reauthenticatedAt: Date } }> {
    const result = await this.admin.reauthenticate(
      principal.sessionId,
      body.password,
      body.code,
      req.ip ?? 'unknown',
    );
    return { data: result };
  }

  @Get('session')
  @UseGuards(PlatformAdminGuard)
  @ApiOperation({ summary: 'Principal admin aktif beserta role dan permission efektif' })
  async current(
    @CurrentPlatformAdmin() principal: PlatformAdminPrincipal,
  ): Promise<{ data: PlatformAdminPrincipal }> {
    return { data: principal };
  }

  @Get('csrf')
  @UseGuards(PlatformAdminGuard)
  @ApiOperation({ summary: 'Terbitkan token CSRF baru untuk sesi admin aktif' })
  async csrf(
    @CurrentPlatformAdmin() principal: PlatformAdminPrincipal,
  ): Promise<{ csrfToken: string }> {
    return { csrfToken: await this.admin.rotateCsrf(principal.sessionId) };
  }

  @Get('tenants')
  @Header('Cache-Control', 'no-store')
  @UseGuards(PlatformAdminGuard, PlatformPermissionGuard)
  @RequirePlatformPermission('platform.tenants.list')
  @ApiOperation({ summary: 'Direktori tenant — metadata minimum, setiap halaman diaudit' })
  async listTenants(
    @Query() query: PlatformTenantDirectoryQueryDto,
    @CurrentPlatformAdmin() principal: PlatformAdminPrincipal,
    @Req() req: Request,
  ) {
    return this.directory.listTenants(query, {
      adminId: principal.id,
      correlationId: req.correlationId ?? 'unknown',
    });
  }

  @Get('tenants/:tenantId')
  @Header('Cache-Control', 'no-store')
  @UseGuards(PlatformAdminGuard, PlatformPermissionGuard)
  @RequirePlatformPermission('platform.tenants.read_summary')
  @ApiOperation({ summary: 'Ringkasan satu tenant — permission read_summary, diaudit' })
  async getTenant(
    @Param('tenantId') tenantId: string,
    @CurrentPlatformAdmin() principal: PlatformAdminPrincipal,
    @Req() req: Request,
  ) {
    return this.directory.getTenant(tenantId, {
      adminId: principal.id,
      correlationId: req.correlationId ?? 'unknown',
    });
  }

  @Post('tenants/:tenantId/suspend')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UseGuards(
    PlatformAdminGuard,
    PlatformPermissionGuard,
    PlatformAdminCsrfGuard,
    PlatformRecentAuthGuard,
  )
  @RequirePlatformPermission('platform.tenants.suspend')
  @ApiOperation({ summary: 'Suspend tenant — wajib alasan, CSRF admin, dan audit' })
  async suspendTenant(
    @Param('tenantId') tenantId: string,
    @Body() body: PlatformTenantStatusChangeDto,
    @CurrentPlatformAdmin() principal: PlatformAdminPrincipal,
    @Req() req: Request,
  ) {
    return this.directory.changeTenantStatus(tenantId, 'SUSPEND', body.reason, {
      adminId: principal.id,
      correlationId: req.correlationId ?? 'unknown',
    });
  }

  @Post('tenants/:tenantId/reactivate')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UseGuards(
    PlatformAdminGuard,
    PlatformPermissionGuard,
    PlatformAdminCsrfGuard,
    PlatformRecentAuthGuard,
  )
  @RequirePlatformPermission('platform.tenants.reactivate')
  @ApiOperation({ summary: 'Reactivate tenant — wajib alasan, CSRF admin, dan audit' })
  async reactivateTenant(
    @Param('tenantId') tenantId: string,
    @Body() body: PlatformTenantStatusChangeDto,
    @CurrentPlatformAdmin() principal: PlatformAdminPrincipal,
    @Req() req: Request,
  ) {
    return this.directory.changeTenantStatus(tenantId, 'REACTIVATE', body.reason, {
      adminId: principal.id,
      correlationId: req.correlationId ?? 'unknown',
    });
  }

  @Get('tenants/:tenantId/subscription-invoices')
  @Header('Cache-Control', 'no-store')
  @UseGuards(PlatformAdminGuard, PlatformPermissionGuard)
  @RequirePlatformPermission('platform.subscriptions.read')
  @ApiOperation({
    summary: 'Daftar tagihan langganan PENDING satu tenant — setiap pembacaan diaudit',
  })
  async listSubscriptionInvoices(
    @Param('tenantId') tenantId: string,
    @CurrentPlatformAdmin() principal: PlatformAdminPrincipal,
    @Req() req: Request,
  ) {
    return this.billing.listPendingInvoices(tenantId, {
      adminId: principal.id,
      correlationId: req.correlationId ?? 'unknown',
    });
  }

  @Post('tenants/:tenantId/subscription-invoices/:invoiceId/settle')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UseGuards(
    PlatformAdminGuard,
    PlatformPermissionGuard,
    PlatformAdminCsrfGuard,
    PlatformRecentAuthGuard,
  )
  @RequirePlatformPermission('platform.subscriptions.settle')
  @ApiOperation({
    summary: 'Tandai tagihan langganan QRIS lunas — wajib referensi, CSRF admin, dan audit',
  })
  async settleSubscriptionInvoice(
    @Param('tenantId') tenantId: string,
    @Param('invoiceId') invoiceId: string,
    @Body() body: PlatformSubscriptionInvoiceSettleDto,
    @CurrentPlatformAdmin() principal: PlatformAdminPrincipal,
    @Req() req: Request,
  ) {
    return this.billing.settleInvoice(
      tenantId,
      invoiceId,
      { paidAmount: body.paidAmount, channel: body.channel, reason: body.reason },
      { adminId: principal.id, correlationId: req.correlationId ?? 'unknown' },
    );
  }

  @Get('cron-runs')
  @Header('Cache-Control', 'no-store')
  @UseGuards(PlatformAdminGuard, PlatformPermissionGuard)
  @RequirePlatformPermission('platform.dashboard.read')
  @ApiOperation({ summary: 'Riwayat eksekusi cron Vercel beserta status setiap job' })
  async listCronRuns(@Query() query: PlatformCronRunQueryDto) {
    return this.cron.listRuns(query);
  }

  @Get('audit-events')
  @Header('Cache-Control', 'no-store')
  @UseGuards(PlatformAdminGuard, PlatformPermissionGuard)
  @RequirePlatformPermission('platform.audit.read')
  @ApiOperation({ summary: 'Audit viewer — filter aktor/aksi/waktu (append-only, read-only)' })
  async listAuditEvents(@Query() query: PlatformAuditQueryDto) {
    return this.audit.listEvents(query);
  }

  @Get('admins')
  @Header('Cache-Control', 'no-store')
  @UseGuards(PlatformAdminGuard, PlatformPermissionGuard)
  @RequirePlatformPermission('platform.roles.read')
  @ApiOperation({ summary: 'Daftar Admin Platform — role aktif per admin, setiap halaman diaudit' })
  async listAdmins(
    @Query() query: PlatformAdminDirectoryQueryDto,
    @CurrentPlatformAdmin() principal: PlatformAdminPrincipal,
    @Req() req: Request,
  ) {
    return this.adminDirectory.listAdmins(query, {
      adminId: principal.id,
      correlationId: req.correlationId ?? 'unknown',
    });
  }

  @Get('admins/:adminId')
  @Header('Cache-Control', 'no-store')
  @UseGuards(PlatformAdminGuard, PlatformPermissionGuard)
  @RequirePlatformPermission('platform.roles.read')
  @ApiOperation({ summary: 'Detail satu admin — role aktif + permission efektif, diaudit' })
  async getAdmin(
    @Param('adminId') adminId: string,
    @CurrentPlatformAdmin() principal: PlatformAdminPrincipal,
    @Req() req: Request,
  ) {
    return this.adminDirectory.getAdmin(adminId, {
      adminId: principal.id,
      correlationId: req.correlationId ?? 'unknown',
    });
  }

  @Post('admins/:adminId/roles/assign')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UseGuards(
    PlatformAdminGuard,
    PlatformPermissionGuard,
    PlatformAdminCsrfGuard,
    PlatformRecentAuthGuard,
  )
  @RequirePlatformPermission('platform.roles.assign')
  @ApiOperation({ summary: 'Tugaskan role Admin Platform — wajib alasan, permission khusus, audit' })
  async assignRole(
    @Param('adminId') adminId: string,
    @Body() body: PlatformRoleAssignmentDto,
    @CurrentPlatformAdmin() principal: PlatformAdminPrincipal,
    @Req() req: Request,
  ) {
    return this.roleAssignments.assign(adminId, body.roleCode, body.reason, {
      adminId: principal.id,
      correlationId: req.correlationId ?? 'unknown',
    });
  }

  @Post('admins/:adminId/roles/revoke')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UseGuards(
    PlatformAdminGuard,
    PlatformPermissionGuard,
    PlatformAdminCsrfGuard,
    PlatformRecentAuthGuard,
  )
  @RequirePlatformPermission('platform.roles.revoke')
  @ApiOperation({ summary: 'Cabut role Admin Platform — wajib alasan, permission terpisah, audit' })
  async revokeRole(
    @Param('adminId') adminId: string,
    @Body() body: PlatformRoleAssignmentDto,
    @CurrentPlatformAdmin() principal: PlatformAdminPrincipal,
    @Req() req: Request,
  ) {
    return this.roleAssignments.revoke(adminId, body.roleCode, body.reason, {
      adminId: principal.id,
      correlationId: req.correlationId ?? 'unknown',
    });
  }

  @Delete('session')
  @HttpCode(204)
  @UseGuards(PlatformAdminGuard, PlatformAdminCsrfGuard)
  @ApiOperation({ summary: 'Logout admin — cabut sesi (wajib CSRF + Origin admin)' })
  async logout(
    @CurrentPlatformAdmin() principal: PlatformAdminPrincipal,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ status: 204 }> {
    await this.admin.logout(principal.sessionId, req.correlationId ?? 'unknown', principal.id);
    res.clearCookie(PLATFORM_ADMIN_COOKIE, { path: '/' });
    return { status: 204 };
  }

  private applySessionCookie(res: Response, session: AdminSessionIssued): void {
    res.cookie(PLATFORM_ADMIN_COOKIE, session.token, {
      httpOnly: true,
      secure: this.config.COOKIE_SECURE,
      sameSite: 'lax',
      path: '/',
      expires: session.expiresAt,
    });
  }
}
