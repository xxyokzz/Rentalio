import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { CatalogConfigService } from './catalog-config.service.js';
import { CatalogConfigController } from './catalog-config.controller.js';

@Module({
  imports: [PrismaModule, AuditModule, AuthModule, TenantModule],
  controllers: [CatalogConfigController],
  providers: [CatalogConfigService],
  exports: [CatalogConfigService],
})
export class CatalogConfigModule {}
