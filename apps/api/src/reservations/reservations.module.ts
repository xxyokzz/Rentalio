import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { ReservationsService } from './reservations.service.js';
import { ReservationsController } from './reservations.controller.js';

@Module({
  imports: [PrismaModule, AuditModule, AuthModule, TenantModule],
  controllers: [ReservationsController],
  providers: [ReservationsService],
  exports: [ReservationsService],
})
export class ReservationsModule {}
