import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { WhatsAppTemplatesService } from './whatsapp-templates.service.js';
import {
  CreateWhatsAppTemplateDto,
  DuplicateWhatsAppTemplateDto,
  ListWhatsAppTemplatesQueryDto,
  PreviewWhatsAppTemplateDto,
  UpdateWhatsAppTemplateDto,
} from './whatsapp-templates.dto.js';
import { SessionGuard, CsrfGuard } from '../auth/auth.guards.js';
import { ApiError, ErrorCode } from '../common/errors.js';
import type { SessionInfo } from '../auth/auth.service.js';

/**
 * Template WhatsApp tenant (click-to-chat/prefill, bukan pengiriman otomatis).
 *
 *   GET    /tenants/:tenantId/whatsapp-templates
 *   POST   /tenants/:tenantId/whatsapp-templates
 *   POST   /tenants/:tenantId/whatsapp-templates/preview
 *   GET    /tenants/:tenantId/whatsapp-templates/:templateId
 *   PATCH  /tenants/:tenantId/whatsapp-templates/:templateId
 *   POST   /tenants/:tenantId/whatsapp-templates/:templateId/duplicate
 *   POST   /tenants/:tenantId/whatsapp-templates/:templateId/restore-default
 *
 * Membaca memerlukan `payment.read`; mengubah memerlukan
 * `settings.whatsapp_templates.manage` (OWNER selalu boleh).
 */
interface AuthedRequest extends Request {
  session?: SessionInfo;
}

@ApiTags('tenant-settings')
@Controller('tenants/:tenantId/whatsapp-templates')
@UseGuards(SessionGuard)
export class WhatsAppTemplatesController {
  constructor(private readonly templates: WhatsAppTemplatesService) {}

  @Get()
  @ApiOperation({ summary: 'Daftar template WhatsApp tenant (filter konteks/metode/tujuan/status)' })
  async list(
    @Param('tenantId') tenantId: string,
    @Query() query: ListWhatsAppTemplatesQueryDto,
    @Req() req: AuthedRequest,
  ) {
    return this.templates.list(tenantId, query, this.uid(req));
  }

  @Post()
  @HttpCode(201)
  @UseGuards(CsrfGuard)
  @ApiOperation({ summary: 'Buat template — placeholder divalidasi, versi 1 dibuat' })
  async create(
    @Param('tenantId') tenantId: string,
    @Body() body: CreateWhatsAppTemplateDto,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.templates.create(tenantId, body, this.ctx(req)),
    };
  }

  @Post('preview')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @ApiOperation({ summary: 'Preview template dengan nilai contoh/override (tidak mengirim pesan)' })
  async preview(
    @Param('tenantId') tenantId: string,
    @Body() body: PreviewWhatsAppTemplateDto,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.templates.preview(tenantId, body, this.uid(req)),
    };
  }

  @Get(':templateId')
  @ApiOperation({ summary: 'Detail template + histori versi terbaru' })
  async get(
    @Param('tenantId') tenantId: string,
    @Param('templateId') templateId: string,
    @Req() req: AuthedRequest,
  ) {
    return { data: await this.templates.get(tenantId, templateId, this.uid(req)) };
  }

  @Patch(':templateId')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @ApiOperation({ summary: 'Ubah nama/body/status — body baru membuat versi baru' })
  async update(
    @Param('tenantId') tenantId: string,
    @Param('templateId') templateId: string,
    @Body() body: UpdateWhatsAppTemplateDto,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.templates.update(tenantId, templateId, body, this.ctx(req)),
    };
  }

  @Post(':templateId/duplicate')
  @HttpCode(201)
  @UseGuards(CsrfGuard)
  @ApiOperation({
    summary: 'Gandakan template ke kombinasi konteks/metode/tujuan lain — versi 1',
  })
  async duplicate(
    @Param('tenantId') tenantId: string,
    @Param('templateId') templateId: string,
    @Body() body: DuplicateWhatsAppTemplateDto,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.templates.duplicate(tenantId, templateId, body, this.ctx(req)),
    };
  }

  @Post(':templateId/restore-default')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @ApiOperation({ summary: 'Pulihkan template ke bawaan (versi baru, histori tetap)' })
  async restoreDefault(
    @Param('tenantId') tenantId: string,
    @Param('templateId') templateId: string,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.templates.restoreDefault(tenantId, templateId, this.ctx(req)),
    };
  }

  private uid(req: AuthedRequest): string {
    if (!req.session) throw new ApiError(ErrorCode.UNAUTHENTICATED, 'Autentikasi diperlukan.');
    return req.session.userId;
  }

  private ctx(req: AuthedRequest) {
    return { actorUserId: this.uid(req), correlationId: req.correlationId };
  }
}
