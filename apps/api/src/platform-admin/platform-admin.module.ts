import { Module } from '@nestjs/common';
import { PlatformAdminController } from './platform-admin.controller.js';
import { BillingModule } from '../billing/billing.module.js';
import { PlatformAdminService } from './platform-admin.service.js';
import { PlatformAdminDirectoryService } from './platform-admin-directory.service.js';
import { PlatformTenantDirectoryService } from './platform-directory.service.js';
import { PlatformAuditService } from './platform-audit.service.js';
import { PlatformRoleAssignmentService } from './platform-roles.service.js';
import { PlatformBillingService } from './platform-billing.service.js';
import {
  PlatformAdminCsrfGuard,
  PlatformAdminGuard,
  PlatformPermissionGuard,
} from './platform-admin.auth.js';

/**
 * Admin Platform: identitas, sesi, MFA, dan RBAC terpisah dari tenant.
 * Modul ini tidak mengekspor PrismaService maupun service tenant lain, jadi
 * modul lain tidak dapat memakai jalur admin secara tidak sengaja.
 */
@Module({
  imports: [BillingModule],
  controllers: [PlatformAdminController],
  providers: [
    PlatformAdminService,
    PlatformAdminDirectoryService,
    PlatformTenantDirectoryService,
    PlatformAuditService,
    PlatformRoleAssignmentService,
    PlatformBillingService,
    PlatformAdminGuard,
    PlatformPermissionGuard,
    PlatformAdminCsrfGuard,
  ],
  exports: [PlatformAdminService, PlatformAdminGuard, PlatformPermissionGuard],
})
export class PlatformAdminModule {}
