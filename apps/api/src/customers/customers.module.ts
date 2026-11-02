import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { CustomersService } from './customers.service.js';
import { CustomersController } from './customers.controller.js';

@Module({
  imports: [PrismaModule, AuditModule, AuthModule, TenantModule],
  controllers: [CustomersController],
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}
