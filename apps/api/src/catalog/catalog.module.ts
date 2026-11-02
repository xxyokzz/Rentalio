import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { CatalogService } from './catalog.service.js';
import { CatalogController } from './catalog.controller.js';

@Module({
  imports: [ConfigModule, PrismaModule, AuditModule, AuthModule, TenantModule],
  controllers: [CatalogController],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
