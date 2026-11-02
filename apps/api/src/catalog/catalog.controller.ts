import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CatalogService } from './catalog.service.js';
import {
  CreateAssetDto,
  CreateCategoryDto,
  CreateMaintenanceDto,
  CreateProductDto,
  UpdateAssetDto,
  UpdateCategoryDto,
  UpdateProductDto,
  UpsertRateDto,
} from './catalog.dto.js';
import { SessionGuard, CsrfGuard } from '../auth/auth.guards.js';
import { BlockInRestrictedMode } from '../subscriptions/subscription.decorator.js';
import { SubscriptionGuard } from '../subscriptions/subscription.guard.js';
import { ApiError, ErrorCode } from '../common/errors.js';
import type { SessionInfo } from '../auth/auth.service.js';

/**
 * Catalog & Inventory endpoints — Notion 04 "Inventaris dan ketersediaan":
 *   GET    /tenants/:tenantId/categories
 *   POST   /tenants/:tenantId/categories
 *   PATCH  /tenants/:tenantId/categories/:id
 *   DELETE /tenants/:tenantId/categories/:id
 *
 *   GET    /tenants/:tenantId/products
 *   POST   /tenants/:tenantId/products
 *   GET    /tenants/:tenantId/products/:id
 *   PATCH  /tenants/:tenantId/products/:id
 *   DELETE /tenants/:tenantId/products/:id
 *
 *   GET    /tenants/:tenantId/products/:id/rates
 *   POST   /tenants/:tenantId/products/:id/rates   (upsert)
 *
 *   GET    /tenants/:tenantId/products/:id/assets
 *   POST   /tenants/:tenantId/products/:id/assets
 *   PATCH  /tenants/:tenantId/assets/:assetId
 *
 *   GET    /tenants/:tenantId/assets/:assetId/maintenance
 *   POST   /tenants/:tenantId/assets/:assetId/maintenance
 *
 * Semua endpoint memerlukan sesi aktif. Mutasi memerlukan CSRF token.
 */
interface AuthedRequest extends Request {
  session?: SessionInfo;
}

@ApiTags('catalog')
@Controller('tenants/:tenantId')
@UseGuards(SessionGuard)
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  // ------------------------------------------------------------------
  // Categories
  // ------------------------------------------------------------------

  @Get('categories')
  @ApiOperation({ summary: 'Daftar kategori tenant' })
  async listCategories(
    @Param('tenantId') tenantId: string,
    @Req() req: AuthedRequest,
  ) {
    return { data: await this.catalogService.listCategories(tenantId, this.uid(req)) };
  }

  @Post('categories')
  @HttpCode(201)
  @BlockInRestrictedMode()
  @UseGuards(CsrfGuard, SubscriptionGuard)
  @ApiOperation({ summary: 'Buat kategori baru (OWNER/MANAGER)' })
  async createCategory(
    @Param('tenantId') tenantId: string,
    @Body() body: CreateCategoryDto,
    @Req() req: AuthedRequest,
  ) {
    const data = await this.catalogService.createCategory(tenantId, body, {
      actorUserId: this.uid(req),
      correlationId: req.correlationId,
    });
    return { data };
  }

  @Patch('categories/:categoryId')
  @HttpCode(200)
  @BlockInRestrictedMode()
  @UseGuards(CsrfGuard, SubscriptionGuard)
  @ApiOperation({ summary: 'Update nama kategori (OWNER/MANAGER)' })
  async updateCategory(
    @Param('tenantId') tenantId: string,
    @Param('categoryId') categoryId: string,
    @Body() body: UpdateCategoryDto,
    @Req() req: AuthedRequest,
  ) {
    const data = await this.catalogService.updateCategory(tenantId, categoryId, body, {
      actorUserId: this.uid(req),
      correlationId: req.correlationId,
    });
    return { data };
  }

  @Delete('categories/:categoryId')
  @HttpCode(204)
  @BlockInRestrictedMode()
  @UseGuards(CsrfGuard, SubscriptionGuard)
  @ApiOperation({ summary: 'Hapus kategori (OWNER/MANAGER) — ditolak jika masih ada produk' })
  async deleteCategory(
    @Param('tenantId') tenantId: string,
    @Param('categoryId') categoryId: string,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    await this.catalogService.deleteCategory(tenantId, categoryId, {
      actorUserId: this.uid(req),
      correlationId: req.correlationId,
    });
  }

  // ------------------------------------------------------------------
  // Products
  // ------------------------------------------------------------------

  @Get('products')
  @ApiOperation({ summary: 'Daftar produk tenant (opsional: filter categoryId, isActive)' })
  @ApiQuery({ name: 'categoryId', required: false })
  @ApiQuery({ name: 'isActive', required: false, type: Boolean })
  async listProducts(
    @Param('tenantId') tenantId: string,
    @Query('categoryId') categoryId?: string,
    @Query('isActive') isActive?: string,
    @Req() req?: AuthedRequest,
  ) {
    const filter = {
      ...(categoryId && { categoryId }),
      ...(isActive !== undefined && { isActive: isActive === 'true' }),
    };
    return { data: await this.catalogService.listProducts(tenantId, this.uid(req!), filter) };
  }

  @Post('products')
  @HttpCode(201)
  @BlockInRestrictedMode()
  @UseGuards(CsrfGuard, SubscriptionGuard)
  @ApiOperation({ summary: 'Buat produk baru (OWNER/MANAGER)' })
  async createProduct(
    @Param('tenantId') tenantId: string,
    @Body() body: CreateProductDto,
    @Req() req: AuthedRequest,
  ) {
    const data = await this.catalogService.createProduct(tenantId, body, {
      actorUserId: this.uid(req),
      correlationId: req.correlationId,
    });
    return { data };
  }

  @Get('products/:productId')
  @ApiOperation({ summary: 'Detail produk beserta tarif dan jumlah asset' })
  async getProduct(
    @Param('tenantId') tenantId: string,
    @Param('productId') productId: string,
    @Req() req: AuthedRequest,
  ) {
    return { data: await this.catalogService.getProduct(tenantId, productId, this.uid(req)) };
  }

  @Patch('products/:productId')
  @HttpCode(200)
  @BlockInRestrictedMode()
  @UseGuards(CsrfGuard, SubscriptionGuard)
  @ApiOperation({ summary: 'Update produk (OWNER/MANAGER). DELETE dilakukan via isActive=false' })
  async updateProduct(
    @Param('tenantId') tenantId: string,
    @Param('productId') productId: string,
    @Body() body: UpdateProductDto,
    @Req() req: AuthedRequest,
  ) {
    const data = await this.catalogService.updateProduct(tenantId, productId, body, {
      actorUserId: this.uid(req),
      correlationId: req.correlationId,
    });
    return { data };
  }

  @Delete('products/:productId')
  @HttpCode(204)
  @BlockInRestrictedMode()
  @UseGuards(CsrfGuard, SubscriptionGuard)
  @ApiOperation({ summary: 'Nonaktifkan produk — soft delete (isActive=false), data historis tetap ada' })
  async deleteProduct(
    @Param('tenantId') tenantId: string,
    @Param('productId') productId: string,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    await this.catalogService.deleteProduct(tenantId, productId, {
      actorUserId: this.uid(req),
      correlationId: req.correlationId,
    });
  }

  // ------------------------------------------------------------------
  // Rates
  // ------------------------------------------------------------------

  @Get('products/:productId/rates')
  @ApiOperation({ summary: 'Ambil tarif sewa produk' })
  async getRate(
    @Param('tenantId') tenantId: string,
    @Param('productId') productId: string,
    @Req() req: AuthedRequest,
  ) {
    return { data: await this.catalogService.getRate(tenantId, productId, this.uid(req)) };
  }

  @Post('products/:productId/rates')
  @HttpCode(200)
  @BlockInRestrictedMode()
  @UseGuards(CsrfGuard, SubscriptionGuard)
  @ApiOperation({ summary: 'Set/update tarif sewa produk (upsert, OWNER/MANAGER). Nilai dalam IDR rupiah utuh.' })
  async upsertRate(
    @Param('tenantId') tenantId: string,
    @Param('productId') productId: string,
    @Body() body: UpsertRateDto,
    @Req() req: AuthedRequest,
  ) {
    const data = await this.catalogService.upsertRate(tenantId, productId, body, {
      actorUserId: this.uid(req),
      correlationId: req.correlationId,
    });
    return { data };
  }

  // ------------------------------------------------------------------
  // Assets (unit fisik individual)
  // ------------------------------------------------------------------

  @Get('products/:productId/assets')
  @ApiOperation({ summary: 'Daftar unit fisik produk (hanya stockMode=INDIVIDUAL_UNITS)' })
  async listAssets(
    @Param('tenantId') tenantId: string,
    @Param('productId') productId: string,
    @Req() req: AuthedRequest,
  ) {
    return { data: await this.catalogService.listAssets(tenantId, productId, this.uid(req)) };
  }

  @Post('products/:productId/assets')
  @HttpCode(201)
  @BlockInRestrictedMode()
  @UseGuards(CsrfGuard, SubscriptionGuard)
  @ApiOperation({ summary: 'Tambah unit fisik ke produk (OWNER/MANAGER, hanya INDIVIDUAL_UNITS)' })
  async createAsset(
    @Param('tenantId') tenantId: string,
    @Param('productId') productId: string,
    @Body() body: CreateAssetDto,
    @Req() req: AuthedRequest,
  ) {
    const data = await this.catalogService.createAsset(tenantId, productId, body, {
      actorUserId: this.uid(req),
      correlationId: req.correlationId,
    });
    return { data };
  }

  @Patch('assets/:assetId')
  @HttpCode(200)
  @BlockInRestrictedMode()
  @UseGuards(CsrfGuard, SubscriptionGuard)
  @ApiOperation({ summary: 'Update status/kondisi unit fisik (OWNER/MANAGER)' })
  async updateAsset(
    @Param('tenantId') tenantId: string,
    @Param('assetId') assetId: string,
    @Body() body: UpdateAssetDto,
    @Req() req: AuthedRequest,
  ) {
    const data = await this.catalogService.updateAsset(tenantId, assetId, body, {
      actorUserId: this.uid(req),
      correlationId: req.correlationId,
    });
    return { data };
  }

  // ------------------------------------------------------------------
  // Asset Maintenance
  // ------------------------------------------------------------------

  @Get('assets/:assetId/maintenance')
  @ApiOperation({ summary: 'Riwayat periode maintenance unit fisik' })
  async listMaintenance(
    @Param('tenantId') tenantId: string,
    @Param('assetId') assetId: string,
    @Req() req: AuthedRequest,
  ) {
    return {
      data: await this.catalogService.listMaintenance(tenantId, assetId, this.uid(req)),
    };
  }

  @Post('assets/:assetId/maintenance')
  @HttpCode(201)
  @BlockInRestrictedMode()
  @UseGuards(CsrfGuard, SubscriptionGuard)
  @ApiOperation({ summary: 'Catat periode maintenance unit (OWNER/MANAGER)' })
  async createMaintenance(
    @Param('tenantId') tenantId: string,
    @Param('assetId') assetId: string,
    @Body() body: CreateMaintenanceDto,
    @Req() req: AuthedRequest,
  ) {
    const data = await this.catalogService.createMaintenance(tenantId, assetId, body, {
      actorUserId: this.uid(req),
      correlationId: req.correlationId,
    });
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
