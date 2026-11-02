import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { PaymentSettingsService } from './payment-settings.service.js';
import { UpdatePaymentMethodsDto } from './payment-settings.dto.js';
import { SessionGuard, CsrfGuard } from '../auth/auth.guards.js';
import { ApiError, ErrorCode } from '../common/errors.js';
import type { SessionInfo } from '../auth/auth.service.js';

/**
 * Pengaturan metode pembayaran per tenant.
 *
 * Kontrak Notion menyebut `/tenant-settings/payment-methods`; implementasi
 * memakai konvensi resource tenant yang dipakai seluruh API:
 *   GET /api/v1/tenants/:tenantId/payment-methods
 *   PUT /api/v1/tenants/:tenantId/payment-methods
 *
 * Matriks 3 konteks × 3 metode. Membaca memerlukan `payment.read`;
 * mengubah memerlukan `settings.payment_methods.manage` (OWNER selalu boleh).
 */
interface AuthedRequest extends Request {
  session?: SessionInfo;
}

@ApiTags('tenant-settings')
@Controller('tenants/:tenantId/payment-methods')
@UseGuards(SessionGuard)
export class PaymentSettingsController {
  constructor(private readonly paymentSettings: PaymentSettingsService) {}

  @Get()
  @ApiOperation({ summary: 'Matriks metode pembayaran aktif per konteks transaksi' })
  async list(
    @Param('tenantId') tenantId: string,
    @Req() req: AuthedRequest,
  ) {
    return { data: await this.paymentSettings.list(tenantId, this.uid(req)) };
  }

  @Put()
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @ApiOperation({ summary: 'Ubah matriks metode pembayaran (minimal satu aktif per konteks)' })
  async update(
    @Param('tenantId') tenantId: string,
    @Body() body: UpdatePaymentMethodsDto,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.paymentSettings.update(tenantId, body, {
        actorUserId: this.uid(req),
        correlationId: req.correlationId,
      }),
    };
  }

  private uid(req: AuthedRequest): string {
    if (!req.session) throw new ApiError(ErrorCode.UNAUTHENTICATED, 'Autentikasi diperlukan.');
    return req.session.userId;
  }
}
