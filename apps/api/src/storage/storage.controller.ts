import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { StorageService } from './storage.service.js';
import { RequestDownloadUrlDto, RequestUploadUrlDto, StorageUploadCategory } from './storage.dto.js';
import { TenantService } from '../tenant/tenant.service.js';
import { SessionGuard, CsrfGuard } from '../auth/auth.guards.js';
import { SubscriptionGuard } from '../subscriptions/subscription.guard.js';
import { BlockInRestrictedMode } from '../subscriptions/subscription.decorator.js';
import { ApiError, ErrorCode } from '../common/errors.js';
import type { SessionInfo } from '../auth/auth.service.js';

interface AuthedRequest extends Request {
  session?: SessionInfo;
}

const INSPECTION_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]);

@ApiTags('storage')
@Controller('tenants/:tenantId/storage')
@UseGuards(SessionGuard)
export class StorageController {
  constructor(
    private readonly storageService: StorageService,
    private readonly tenantService: TenantService,
  ) {}

  @Post('upload-url')
  @HttpCode(200)
  @BlockInRestrictedMode()
  @UseGuards(CsrfGuard, SubscriptionGuard)
  @ApiOperation({ summary: 'Minta presigned URL upload terisolasi untuk tenant di R2' })
  async requestUploadUrl(
    @Param('tenantId') tenantId: string,
    @Body() body: RequestUploadUrlDto,
    @Req() req: AuthedRequest,
  ) {
    const actorUserId = this.uid(req);
    // Verifikasi akses membership tenant: OWNER, MANAGER, STAFF
    await this.tenantService.requireMembership(tenantId, actorUserId, [
      'OWNER',
      'MANAGER',
      'STAFF',
    ]);

    if (
      body.category === StorageUploadCategory.INSPECTIONS &&
      !INSPECTION_MIME_TYPES.has(body.contentType)
    ) {
      throw new ApiError(
        ErrorCode.VALIDATION_ERROR,
        'Lampiran inspeksi hanya JPEG, PNG, WebP, atau PDF.',
      );
    }

    const result = await this.storageService.createTenantUploadUrl(
      tenantId,
      body.category,
      body.filename,
      body.contentType,
    );

    return { data: result };
  }

  @Get('download-url')
  @ApiOperation({ summary: 'Minta presigned URL unduh berumur pendek untuk objek tenant' })
  async requestDownloadUrl(
    @Param('tenantId') tenantId: string,
    @Query() query: RequestDownloadUrlDto,
    @Req() req: AuthedRequest,
  ) {
    await this.tenantService.requireMembership(tenantId, this.uid(req), [
      'OWNER',
      'MANAGER',
      'STAFF',
      'CASHIER',
    ]);

    // Objek tenant lain tidak boleh bisa ditandatangani, meski kuncinya ditebak.
    if (!query.objectKey.startsWith(`tenants/${tenantId}/`)) {
      throw new ApiError(
        ErrorCode.VALIDATION_ERROR,
        'objectKey harus berada di namespace tenant aktif.',
      );
    }

    return {
      data: {
        objectKey: query.objectKey,
        downloadUrl: await this.storageService.createDownloadUrl(query.objectKey),
        expiresInSeconds: 300,
      },
    };
  }

  private uid(req: AuthedRequest): string {
    if (!req.session) {
      throw new ApiError(ErrorCode.UNAUTHENTICATED, 'Autentikasi diperlukan.');
    }
    return req.session.userId;
  }
}
