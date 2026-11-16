import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { ReportsService } from './reports.service.js';
import { DamageFeeReportQueryDto } from './reports.dto.js';
import { SessionGuard } from '../auth/auth.guards.js';
import { ApiError, ErrorCode } from '../common/errors.js';
import type { SessionInfo } from '../auth/auth.service.js';

interface AuthedRequest extends Request {
  session?: SessionInfo;
}

/**
 * Laporan tenant. Permission `report.read` (OWNER otomatis; MANAGER/STAFF
 * memilikinya secara default). Hanya baca; tidak mengubah data apa pun.
 */
@ApiTags('report')
@Controller('tenants/:tenantId/reports')
@UseGuards(SessionGuard)
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('damage-fees')
  @ApiOperation({ summary: 'Laporan denda kerusakan: tagihan, keputusan, dan tingkat kerusakan' })
  async damageFees(
    @Param('tenantId') tenantId: string,
    @Query() query: DamageFeeReportQueryDto,
    @Req() req: AuthedRequest,
  ) {
    if (!req.session) throw new ApiError(ErrorCode.UNAUTHENTICATED, 'Autentikasi diperlukan.');
    return {
      data: await this.reportsService.damageFees(tenantId, req.session.userId, query),
    };
  }
}
