import {
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { StorageService } from './storage.service.js';
import { RequestUploadUrlDto } from './storage.dto.js';
import { TenantService } from '../tenant/tenant.service.js';
import { SessionGuard, CsrfGuard } from '../auth/auth.guards.js';
import { SubscriptionGuard } from '../subscriptions/subscription.guard.js';
import { BlockInRestrictedMode } from '../subscriptions/subscription.decorator.js';
import { ApiError, ErrorCode } from '../common/errors.js';
import type { SessionInfo } from '../auth/auth.service.js';

interface AuthedRequest extends Request {
  session?: SessionInfo;
}

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

    const result = await this.storageService.createTenantUploadUrl(
      tenantId,
      body.category,
      body.filename,
      body.contentType,
    );

    return { data: result };
  }

  private uid(req: AuthedRequest): string {
    if (!req.session) {
      throw new ApiError(ErrorCode.UNAUTHENTICATED, 'Autentikasi diperlukan.');
    }
    return req.session.userId;
  }
}
