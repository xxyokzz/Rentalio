import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { EmailModule } from '../email/email.module.js';
import { TenantService } from './tenant.service.js';
import { TenantController } from './tenant.controller.js';

@Module({
  imports: [ConfigModule, PrismaModule, AuditModule, AuthModule, EmailModule],
  controllers: [TenantController],
  providers: [TenantService],
  exports: [TenantService],
})
export class TenantModule {}
