import { Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { BillingService } from './billing.service.js';
import { SessionGuard, CsrfGuard } from '../auth/auth.guards.js';
import { ApiError, ErrorCode } from '../common/errors.js';
import type { SessionInfo } from '../auth/auth.service.js';

/**
 * Tagihan langganan tenant → Rentalio.
 *
 *   GET  /tenants/:tenantId/subscription-invoices  → 10 tagihan terbaru
 *   POST /tenants/:tenantId/subscription-invoices  → buat / pakai ulang tagihan PENDING
 *
 * Mengubah status tagihan bukan wewenang aplikasi tenant: QRIS dinamis tidak
 * punya callback, dan status lunas hanya ditetapkan operator platform setelah
 * dana terverifikasi (Admin Platform, `platform.subscriptions.settle`).
 */
interface AuthedRequest extends Request {
  session?: SessionInfo;
}

@ApiTags('billing')
@Controller('tenants/:tenantId/subscription-invoices')
@UseGuards(SessionGuard)
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get()
  @ApiOperation({ summary: 'Riwayat tagihan langganan tenant (terbaru lebih dulu)' })
  async list(@Param('tenantId') tenantId: string, @Req() req: AuthedRequest) {
    return { data: await this.billing.listInvoices(tenantId, this.uid(req)) };
  }

  @Post()
  @HttpCode(201)
  @UseGuards(CsrfGuard)
  @ApiOperation({ summary: 'Buat tagihan langganan (atau pakai ulang tagihan yang masih menunggu)' })
  async create(@Param('tenantId') tenantId: string, @Req() req: AuthedRequest) {
    return {
      data: await this.billing.createInvoice(tenantId, this.uid(req), {
        correlationId: req.correlationId,
      }),
    };
  }

  private uid(req: AuthedRequest): string {
    if (!req.session) throw new ApiError(ErrorCode.UNAUTHENTICATED, 'Autentikasi diperlukan.');
    return req.session.userId;
  }
}
