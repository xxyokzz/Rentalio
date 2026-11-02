import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { PaymentSettingsService } from './payment-settings.service.js';
import { PaymentSettingsController } from './payment-settings.controller.js';

@Module({
  imports: [PrismaModule, AuditModule, AuthModule, TenantModule],
  controllers: [PaymentSettingsController],
  providers: [PaymentSettingsService],
  exports: [PaymentSettingsService],
})
export class PaymentSettingsModule {}
