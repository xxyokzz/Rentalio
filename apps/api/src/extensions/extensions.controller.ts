import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { ExtensionsService } from './extensions.service.js';
import {
  ApproveExtensionDto,
  ConflictOverviewQueryDto,
  ExtensionQueueQueryDto,
  OverrideExtensionConflictDto,
  RejectExtensionDto,
  RequestExtensionDto,
  ResolveExtensionConflictDto,
} from './extensions.dto.js';
import { SessionGuard, CsrfGuard } from '../auth/auth.guards.js';
import { BlockInRestrictedMode } from '../subscriptions/subscription.decorator.js';
import { SubscriptionGuard } from '../subscriptions/subscription.guard.js';
import { ApiError, ErrorCode } from '../common/errors.js';
import type { SessionInfo } from '../auth/auth.service.js';

/**
 * Perpanjangan sewa — ADR-001 §8 + Notion 04:
 *   GET  /tenants/:tenantId/orders/:orderId/extensions
 *   POST /tenants/:tenantId/orders/:orderId/extensions
 *   POST /tenants/:tenantId/orders/:orderId/extensions/:extensionId/approve
 *   POST /tenants/:tenantId/orders/:orderId/extensions/:extensionId/reject
 *   POST /tenants/:tenantId/orders/:orderId/extensions/:extensionId/override-conflict
 *   POST .../extensions/:extensionId/conflicts/:conflictId/resolve
 *   GET  /tenants/:tenantId/extensions           (antrean permintaan)
 *   GET  /tenants/:tenantId/extension-conflicts   (ringkasan operasional)
 *
 * Pengajuan tidak mengubah periode. Opsi A selalu memeriksa ketersediaan;
 * Opsi B hanya dapat meneruskan konflik melalui command override eksplisit.
 * Konflik OPEN adalah tugas operasional: command resolve menutupnya dan
 * menghitung ulang flag `hasOpenConflict` milik order/booking terdampak.
 */
interface AuthedRequest extends Request {
  session?: SessionInfo;
}

@ApiTags('extension')
@Controller('tenants/:tenantId')
@UseGuards(SessionGuard)
export class ExtensionsController {
  constructor(private readonly extensionsService: ExtensionsService) {}

  @Get('orders/:orderId/extensions')
  @ApiOperation({ summary: 'Daftar permintaan perpanjangan order' })
  async listExtensions(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.extensionsService.listExtensions(tenantId, orderId, this.uid(req)),
    };
  }

  @Get('extensions')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Antrean permintaan perpanjangan lintas order' })
  async listExtensionQueue(
    @Param('tenantId') tenantId: string,
    @Query() query: ExtensionQueueQueryDto,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.extensionsService.listPendingExtensions(
        tenantId,
        this.uid(req),
        query.status ?? 'PENDING_APPROVAL',
      ),
    };
  }

  @Get('orders/:orderId/extensions/:extensionId')
  @ApiOperation({ summary: 'Detail permintaan perpanjangan + konflik/override' })
  async getExtension(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @Param('extensionId') extensionId: string,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.extensionsService.getExtension(
        tenantId,
        orderId,
        extensionId,
        this.uid(req),
      ),
    };
  }

  @Post('orders/:orderId/extensions')
  @HttpCode(201)
  @BlockInRestrictedMode()
  @UseGuards(CsrfGuard, SubscriptionGuard)
  @ApiOperation({ summary: 'Ajukan perpanjangan (belum mengubah periode/alokasi)' })
  async requestExtension(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @Body() body: RequestExtensionDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.extensionsService.requestExtension(tenantId, orderId, body, {
        actorUserId: this.uid(req),
        correlationId: req.correlationId,
        idempotencyKey: this.validateIdempotencyKey(idempotencyKey),
      }),
    };
  }

  @Post('orders/:orderId/extensions/:extensionId/approve')
  @HttpCode(200)
  @BlockInRestrictedMode()
  @UseGuards(CsrfGuard, SubscriptionGuard)
  @ApiOperation({ summary: 'Setujui perpanjangan + alokasi atomik (409 bila konflik)' })
  async approveExtension(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @Param('extensionId') extensionId: string,
    @Body() body: ApproveExtensionDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.extensionsService.approveExtension(
        tenantId,
        orderId,
        extensionId,
        body,
        {
          actorUserId: this.uid(req),
          correlationId: req.correlationId,
          idempotencyKey: this.validateIdempotencyKey(idempotencyKey),
        },
      ),
    };
  }

  @Post('orders/:orderId/extensions/:extensionId/reject')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @ApiOperation({ summary: 'Tolak perpanjangan dengan alasan' })
  async rejectExtension(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @Param('extensionId') extensionId: string,
    @Body() body: RejectExtensionDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.extensionsService.rejectExtension(
        tenantId,
        orderId,
        extensionId,
        body,
        {
          actorUserId: this.uid(req),
          correlationId: req.correlationId,
          idempotencyKey: this.validateIdempotencyKey(idempotencyKey),
        },
      ),
    };
  }

  @Post('orders/:orderId/extensions/:extensionId/override-conflict')
  @HttpCode(200)
  @BlockInRestrictedMode()
  @UseGuards(CsrfGuard, SubscriptionGuard)
  @ApiOperation({
    summary: 'Setujui perpanjangan Opsi B dengan override konflik (permission khusus + alasan + risiko)',
  })
  async overrideExtensionConflict(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @Param('extensionId') extensionId: string,
    @Body() body: OverrideExtensionConflictDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.extensionsService.overrideExtensionConflict(
        tenantId,
        orderId,
        extensionId,
        body,
        {
          actorUserId: this.uid(req),
          correlationId: req.correlationId,
          idempotencyKey: this.validateIdempotencyKey(idempotencyKey),
        },
      ),
    };
  }

  @Post('orders/:orderId/extensions/:extensionId/conflicts/:conflictId/resolve')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @ApiOperation({
    summary: 'Tandai konflik perpanjangan selesai; hitung ulang flag hasOpenConflict',
  })
  async resolveConflict(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @Param('extensionId') extensionId: string,
    @Param('conflictId') conflictId: string,
    @Body() body: ResolveExtensionConflictDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.extensionsService.resolveConflict(
        tenantId,
        orderId,
        extensionId,
        conflictId,
        body,
        {
          actorUserId: this.uid(req),
          correlationId: req.correlationId,
          idempotencyKey: this.validateIdempotencyKey(idempotencyKey),
        },
      ),
    };
  }

  @Get('extension-conflicts')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Ringkasan order & reservasi ber-flag konflik beserta detailnya',
  })
  async conflictOverview(
    @Param('tenantId') tenantId: string,
    @Query() query: ConflictOverviewQueryDto,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.extensionsService.getConflictOverview(
        tenantId,
        this.uid(req),
        query.status ?? 'OPEN',
      ),
    };
  }

  private uid(req: AuthedRequest): string {
    if (!req.session) {
      throw new ApiError(ErrorCode.UNAUTHENTICATED, 'Autentikasi diperlukan.');
    }
    return req.session.userId;
  }

  private validateIdempotencyKey(key: string | undefined): string | undefined {
    if (key !== undefined && !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
      throw new ApiError(
        ErrorCode.VALIDATION_ERROR,
        'Idempotency-Key harus 8-128 karakter (huruf, angka, titik, garis bawah, titik dua, atau strip).',
      );
    }
    return key;
  }
}
