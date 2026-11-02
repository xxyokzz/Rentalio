import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { WhatsAppTemplatesService } from './whatsapp-templates.service.js';
import { WhatsAppMessagesService } from './whatsapp-messages.service.js';
import { WhatsAppTemplatesController } from './whatsapp-templates.controller.js';

@Module({
  imports: [PrismaModule, AuditModule, AuthModule, TenantModule],
  controllers: [WhatsAppTemplatesController],
  providers: [WhatsAppTemplatesService, WhatsAppMessagesService],
  exports: [WhatsAppTemplatesService, WhatsAppMessagesService],
})
export class WhatsAppTemplatesModule {}
