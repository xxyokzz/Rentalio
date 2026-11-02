import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { ReturnsService } from './returns.service.js';
import { ReturnsController } from './returns.controller.js';

@Module({
  imports: [PrismaModule, AuditModule, AuthModule, TenantModule],
  controllers: [ReturnsController],
  providers: [ReturnsService],
  exports: [ReturnsService],
})
export class ReturnsModule {}
