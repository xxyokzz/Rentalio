import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';

@Module({
  imports: [TenantModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
