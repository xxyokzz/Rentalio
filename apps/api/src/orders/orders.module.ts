import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { PaymentSettingsModule } from '../payment-settings/payment-settings.module.js';
import { WhatsAppTemplatesModule } from '../whatsapp-templates/whatsapp-templates.module.js';
import { OrdersService } from './orders.service.js';
import { OrdersController } from './orders.controller.js';

@Module({
  imports: [
    PrismaModule,
    AuditModule,
    AuthModule,
    TenantModule,
    PaymentSettingsModule,
    WhatsAppTemplatesModule,
  ],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
