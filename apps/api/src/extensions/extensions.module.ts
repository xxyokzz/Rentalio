import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { ExtensionsService } from './extensions.service.js';
import { ExtensionsController } from './extensions.controller.js';

@Module({
  imports: [PrismaModule, AuditModule, AuthModule, TenantModule],
  controllers: [ExtensionsController],
  providers: [ExtensionsService],
  exports: [ExtensionsService],
})
export class ExtensionsModule {}
