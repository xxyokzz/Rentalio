import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { ReturnsService } from './returns.service.js';
import {
  CancelReturnDto,
  CompleteReturnDto,
  CreateInspectionDto,
  CreateReturnDto,
  DecideInspectionDto,
  SubmitInspectionDto,
} from './returns.dto.js';
import { SessionGuard, CsrfGuard } from '../auth/auth.guards.js';
import { ApiError, ErrorCode } from '../common/errors.js';
import type { SessionInfo } from '../auth/auth.service.js';

/**
 * Return & Inspection endpoints — ADR-001 §5:
 *   GET    /tenants/:tenantId/orders/:orderId/returns
 *   POST   /tenants/:tenantId/orders/:orderId/returns
 *   GET    /tenants/:tenantId/returns/:returnId
 *   PATCH  /tenants/:tenantId/returns/:returnId/complete
 *   PATCH  /tenants/:tenantId/returns/:returnId/cancel
 *
 *   GET    /tenants/:tenantId/orders/:orderId/inspections
 *   POST   /tenants/:tenantId/orders/:orderId/inspections
 *   GET    /tenants/:tenantId/inspections/:inspectionId
 *   PATCH  /tenants/:tenantId/inspections/:inspectionId/submit
 *   PATCH  /tenants/:tenantId/inspections/:inspectionId/decision
 *
 * Semua endpoint memerlukan sesi aktif; mutasi memerlukan CSRF token.
 */
interface AuthedRequest extends Request {
  session?: SessionInfo;
}

@ApiTags('return-inspection')
@Controller('tenants/:tenantId')
@UseGuards(SessionGuard)
export class ReturnsController {
  constructor(private readonly returnsService: ReturnsService) {}

  // ------------------------------------------------------------------
  // Returns
  // ------------------------------------------------------------------

  @Get('orders/:orderId/returns')
  @ApiOperation({ summary: 'Daftar pengembalian untuk satu order' })
  async listReturns(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.returnsService.listReturns(tenantId, orderId, this.uid(req)),
    };
  }

  @Post('orders/:orderId/returns')
  @HttpCode(201)
  @UseGuards(CsrfGuard)
  @ApiOperation({ summary: 'Catat pengembalian barang (OWNER/MANAGER/STAFF)' })
  async createReturn(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @Body() body: CreateReturnDto,
    @Req() req: AuthedRequest,
  ) {
    const data = await this.returnsService.createReturn(tenantId, orderId, body, {
      actorUserId: this.uid(req),
      correlationId: req.correlationId,
    });
    return { data };
  }

  @Get('returns/:returnId')
  @ApiOperation({ summary: 'Detail pengembalian beserta item' })
  async getReturn(
    @Param('tenantId') tenantId: string,
    @Param('returnId') returnId: string,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.returnsService.getReturn(tenantId, returnId, this.uid(req)),
    };
  }

  @Patch('returns/:returnId/complete')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @ApiOperation({ summary: 'Selesaikan pengembalian — PENDING → COMPLETED' })
  async completeReturn(
    @Param('tenantId') tenantId: string,
    @Param('returnId') returnId: string,
    @Body() body: CompleteReturnDto,
    @Req() req: AuthedRequest,
  ) {
    const data = await this.returnsService.completeReturn(tenantId, returnId, body, {
      actorUserId: this.uid(req),
      correlationId: req.correlationId,
    });
    return { data };
  }

  @Patch('returns/:returnId/cancel')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @ApiOperation({ summary: 'Batalkan pengembalian — PENDING → CANCELLED (OWNER/MANAGER)' })
  async cancelReturn(
    @Param('tenantId') tenantId: string,
    @Param('returnId') returnId: string,
    @Body() body: CancelReturnDto,
    @Req() req: AuthedRequest,
  ) {
    const data = await this.returnsService.cancelReturn(tenantId, returnId, body, {
      actorUserId: this.uid(req),
      correlationId: req.correlationId,
    });
    return { data };
  }

  // ------------------------------------------------------------------
  // Inspections
  // ------------------------------------------------------------------

  @Get('orders/:orderId/inspections')
  @ApiOperation({ summary: 'Daftar inspeksi untuk satu order' })
  async listInspections(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.returnsService.listInspections(tenantId, orderId, this.uid(req)),
    };
  }

  @Post('orders/:orderId/inspections')
  @HttpCode(201)
  @UseGuards(CsrfGuard)
  @ApiOperation({ summary: 'Buat inspeksi kerusakan pasca-return (DRAFT)' })
  async createInspection(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @Body() body: CreateInspectionDto,
    @Req() req: AuthedRequest,
  ) {
    const data = await this.returnsService.createInspection(tenantId, orderId, body, {
      actorUserId: this.uid(req),
      correlationId: req.correlationId,
    });
    return { data };
  }

  @Get('inspections/:inspectionId')
  @ApiOperation({ summary: 'Detail inspeksi beserta lampiran' })
  async getInspection(
    @Param('tenantId') tenantId: string,
    @Param('inspectionId') inspectionId: string,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.returnsService.getInspection(
        tenantId,
        inspectionId,
        this.uid(req),
      ),
    };
  }

  @Patch('inspections/:inspectionId/submit')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @ApiOperation({ summary: 'Ajukan inspeksi — DRAFT → SUBMITTED' })
  async submitInspection(
    @Param('tenantId') tenantId: string,
    @Param('inspectionId') inspectionId: string,
    @Body() body: SubmitInspectionDto,
    @Req() req: AuthedRequest,
  ) {
    const data = await this.returnsService.submitInspection(
      tenantId,
      inspectionId,
      body,
      {
        actorUserId: this.uid(req),
        correlationId: req.correlationId,
      },
    );
    return { data };
  }

  @Patch('inspections/:inspectionId/decision')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @ApiOperation({ summary: 'Putuskan inspeksi — SUBMITTED → APPROVED/REJECTED (OWNER/MANAGER)' })
  async decideInspection(
    @Param('tenantId') tenantId: string,
    @Param('inspectionId') inspectionId: string,
    @Body() body: DecideInspectionDto,
    @Req() req: AuthedRequest,
  ) {
    const data = await this.returnsService.decideInspection(
      tenantId,
      inspectionId,
      body,
      {
        actorUserId: this.uid(req),
        correlationId: req.correlationId,
      },
    );
    return { data };
  }

  // ------------------------------------------------------------------
  // Helper
  // ------------------------------------------------------------------

  private uid(req: AuthedRequest): string {
    if (!req.session) throw new ApiError(ErrorCode.UNAUTHENTICATED, 'Autentikasi diperlukan.');
    return req.session.userId;
  }
}
