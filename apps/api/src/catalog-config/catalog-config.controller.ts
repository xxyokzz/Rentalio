import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CatalogConfigService } from './catalog-config.service.js';
import { SaveCatalogConfigDto, ValidateCatalogConfigDto } from './catalog-config.dto.js';
import { SessionGuard, CsrfGuard } from '../auth/auth.guards.js';
import { BlockInRestrictedMode } from '../subscriptions/subscription.decorator.js';
import { SubscriptionGuard } from '../subscriptions/subscription.guard.js';
import { ApiError, ErrorCode } from '../common/errors.js';
import type { SessionInfo } from '../auth/auth.service.js';

interface AuthedRequest extends Request {
  session?: SessionInfo;
}

/**
 * Konfigurasi katalog tenant (Notion 06 WEB-07).
 *
 *   GET    /tenants/:tenantId/catalog-config
 *   PUT    /tenants/:tenantId/catalog-config
 *   POST   /tenants/:tenantId/catalog-config/validate
 *   POST   /tenants/:tenantId/catalog-config/publish
 *   GET    /tenants/:tenantId/catalog-config/versions
 *   GET    /tenants/:tenantId/catalog-config/versions/:versionId
 *   POST   /tenants/:tenantId/catalog-config/versions/:versionId/restore
 *   GET    /tenants/:tenantId/catalog-config/templates
 *   POST   /tenants/:tenantId/catalog-config/templates/:templateKey/apply
 *   GET    /tenants/:tenantId/catalog-config/blocks
 *
 * Membaca memerlukan `catalog.read`; mengubah/menyimpan/menerbitkan
 * memerlukan `catalog.write` (OWNER selalu boleh). Semua mutasi juga diblokir
 * dalam restricted mode (`@BlockInRestrictedMode`) mengikuti kebijakan
 * subscription — baca/laporan tetap terbuka (dokumen 10 & 04). Konfigurasi
 * hanya memuat presentasi — data produk, harga, dan ketersediaan tetap dari
 * domain Rentalio.
 */
@ApiTags('catalog-config')
@Controller('tenants/:tenantId/catalog-config')
@UseGuards(SessionGuard)
export class CatalogConfigController {
  constructor(private readonly catalogConfig: CatalogConfigService) {}

  @Get()
  @ApiOperation({ summary: 'Status editor: draf aktif + versi live + konfigurasi default' })
  async getState(@Param('tenantId') tenantId: string, @Req() req: AuthedRequest) {
    return { data: await this.catalogConfig.getState(tenantId, this.uid(req)) };
  }

  @Put()
  @HttpCode(200)
  @BlockInRestrictedMode()
  @UseGuards(CsrfGuard, SubscriptionGuard)
  @ApiOperation({
    summary: 'Simpan draf (allowlist blok/properti divalidasi; live belum berubah)',
    description: 'Memerlukan `catalog.write`. Diblokir pada restricted mode (403 TENANT_RESTRICTED).',
  })
  async saveDraft(
    @Param('tenantId') tenantId: string,
    @Body() body: SaveCatalogConfigDto,
    @Req() req: AuthedRequest,
  ) {
    return { data: await this.catalogConfig.saveDraft(tenantId, body, this.ctx(req)) };
  }

  @Post('validate')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @ApiOperation({ summary: 'Validasi konfigurasi tanpa menyimpan — mengembalikan daftar pelanggaran' })
  async validate(
    @Param('tenantId') tenantId: string,
    @Body() body: ValidateCatalogConfigDto,
    @Req() req: AuthedRequest,
  ) {
    return { data: await this.catalogConfig.validateConfig(tenantId, body, this.uid(req)) };
  }

  @Post('publish')
  @HttpCode(200)
  @BlockInRestrictedMode()
  @UseGuards(CsrfGuard, SubscriptionGuard)
  @ApiOperation({
    summary: 'Publish draf ke katalog publik; versi lama diarsipkan',
    description: 'Memerlukan `catalog.write`. Diblokir pada restricted mode (403 TENANT_RESTRICTED).',
  })
  async publish(@Param('tenantId') tenantId: string, @Req() req: AuthedRequest) {
    return { data: await this.catalogConfig.publish(tenantId, this.ctx(req)) };
  }

  @Get('versions')
  @ApiOperation({ summary: 'Histori versi konfigurasi (terbaru lebih dulu)' })
  async versions(@Param('tenantId') tenantId: string, @Req() req: AuthedRequest) {
    return this.catalogConfig.listVersions(tenantId, this.uid(req));
  }

  @Get('versions/:versionId')
  @ApiOperation({ summary: 'Detail satu versi konfigurasi termasuk snapshot' })
  async version(
    @Param('tenantId') tenantId: string,
    @Param('versionId') versionId: string,
    @Req() req: AuthedRequest,
  ) {
    return { data: await this.catalogConfig.getVersion(tenantId, versionId, this.uid(req)) };
  }

  @Post('versions/:versionId/restore')
  @HttpCode(200)
  @BlockInRestrictedMode()
  @UseGuards(CsrfGuard, SubscriptionGuard)
  @ApiOperation({
    summary: 'Rollback: salin snapshot versi lama ke draf (live belum berubah)',
    description: 'Memerlukan `catalog.write`. Diblokir pada restricted mode (403 TENANT_RESTRICTED).',
  })
  async restore(
    @Param('tenantId') tenantId: string,
    @Param('versionId') versionId: string,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.catalogConfig.restoreVersion(tenantId, versionId, this.ctx(req)),
    };
  }

  @Get('templates')
  @ApiOperation({ summary: 'Galeri template bawaan + daftar blok & propertinya' })
  async templates(@Param('tenantId') tenantId: string, @Req() req: AuthedRequest) {
    return this.catalogConfig.listTemplates(tenantId, this.uid(req));
  }

  @Post('templates/:templateKey/apply')
  @HttpCode(200)
  @BlockInRestrictedMode()
  @UseGuards(CsrfGuard, SubscriptionGuard)
  @ApiOperation({
    summary: 'Terapkan template bawaan ke draf (branding tenant dipertahankan)',
    description: 'Memerlukan `catalog.write`. Diblokir pada restricted mode (403 TENANT_RESTRICTED).',
  })
  async applyTemplate(
    @Param('tenantId') tenantId: string,
    @Param('templateKey') templateKey: string,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.catalogConfig.applyTemplate(tenantId, templateKey, this.ctx(req)),
    };
  }

  @Get('blocks')
  @ApiOperation({ summary: 'Allowlist blok katalog beserta properti yang diizinkan' })
  async blocks(@Param('tenantId') tenantId: string, @Req() req: AuthedRequest) {
    return this.catalogConfig.listBlocks(tenantId, this.uid(req));
  }

  private uid(req: AuthedRequest): string {
    if (!req.session) throw new ApiError(ErrorCode.UNAUTHENTICATED, 'Autentikasi diperlukan.');
    return req.session.userId;
  }

  private ctx(req: AuthedRequest) {
    return { actorUserId: this.uid(req), correlationId: req.correlationId };
  }
}
