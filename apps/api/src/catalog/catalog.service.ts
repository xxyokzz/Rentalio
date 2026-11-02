import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { TenantService } from '../tenant/tenant.service.js';
import { ApiError, ErrorCode } from '../common/errors.js';
import type {
  CreateCategoryDto,
  UpdateCategoryDto,
  CreateProductDto,
  UpdateProductDto,
  UpsertRateDto,
  CreateAssetDto,
  UpdateAssetDto,
  CreateMaintenanceDto,
} from './catalog.dto.js';

@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tenantService: TenantService,
  ) {}

  // ============================================================
  // Categories
  // ============================================================

  async listCategories(tenantId: string, actorUserId: string) {
    await this.tenantService.requireMembership(tenantId, actorUserId, [
      'OWNER', 'MANAGER', 'STAFF', 'CASHIER',
    ]);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.category.findMany({
        where: { tenantId },
        orderBy: { name: 'asc' },
      });
      return rows.map((c) => ({ id: c.id, name: c.name, createdAt: c.createdAt }));
    });
  }

  async createCategory(
    tenantId: string,
    dto: CreateCategoryDto,
    ctx: { actorUserId: string; correlationId: string },
  ) {
    await this.tenantService.requireMembership(tenantId, ctx.actorUserId, ['OWNER', 'MANAGER']);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const category = await tx.category.create({
        data: { tenantId, name: dto.name.trim() },
      });
      await this.audit.record(
        {
          tenantId,
          actorUserId: ctx.actorUserId,
          action: 'CATEGORY_CREATED',
          domain: 'catalog',
          entityType: 'category',
          entityId: category.id,
          correlationId: ctx.correlationId,
        },
        tx,
      );
      return { id: category.id, name: category.name };
    });
  }

  async updateCategory(
    tenantId: string,
    categoryId: string,
    dto: UpdateCategoryDto,
    ctx: { actorUserId: string; correlationId: string },
  ) {
    await this.tenantService.requireMembership(tenantId, ctx.actorUserId, ['OWNER', 'MANAGER']);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const existing = await tx.category.findUnique({
        where: { tenantId_id: { tenantId, id: categoryId } },
      });
      if (!existing) throw new ApiError(ErrorCode.NOT_FOUND, 'Kategori tidak ditemukan.');
      const updated = await tx.category.update({
        where: { id: categoryId },
        data: { ...(dto.name && { name: dto.name.trim() }) },
      });
      await this.audit.record(
        {
          tenantId,
          actorUserId: ctx.actorUserId,
          action: 'CATEGORY_UPDATED',
          domain: 'catalog',
          entityType: 'category',
          entityId: categoryId,
          correlationId: ctx.correlationId,
        },
        tx,
      );
      return { id: updated.id, name: updated.name };
    });
  }

  async deleteCategory(
    tenantId: string,
    categoryId: string,
    ctx: { actorUserId: string; correlationId: string },
  ) {
    await this.tenantService.requireMembership(tenantId, ctx.actorUserId, ['OWNER', 'MANAGER']);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const existing = await tx.category.findUnique({
        where: { tenantId_id: { tenantId, id: categoryId } },
      });
      if (!existing) throw new ApiError(ErrorCode.NOT_FOUND, 'Kategori tidak ditemukan.');
      const productsCount = await tx.product.count({ where: { tenantId, categoryId } });
      if (productsCount > 0) {
        throw new ApiError(
          ErrorCode.BUSINESS_RULE_VIOLATION,
          'Kategori memiliki produk aktif. Pindahkan atau hapus produk terlebih dahulu.',
        );
      }
      await tx.category.delete({ where: { id: categoryId } });
      await this.audit.record(
        {
          tenantId,
          actorUserId: ctx.actorUserId,
          action: 'CATEGORY_DELETED',
          domain: 'catalog',
          entityType: 'category',
          entityId: categoryId,
          correlationId: ctx.correlationId,
        },
        tx,
      );
    });
  }

  // ============================================================
  // Products
  // ============================================================

  async listProducts(tenantId: string, actorUserId: string, filter?: { categoryId?: string; isActive?: boolean }) {
    await this.tenantService.requireMembership(tenantId, actorUserId, [
      'OWNER', 'MANAGER', 'STAFF', 'CASHIER',
    ]);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.product.findMany({
        where: {
          tenantId,
          ...(filter?.categoryId && { categoryId: filter.categoryId }),
          ...(filter?.isActive !== undefined && { isActive: filter.isActive }),
        },
        include: { rates: true },
        orderBy: { name: 'asc' },
      });
      return rows.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        categoryId: p.categoryId,
        stockMode: p.stockMode,
        capacity: p.capacity,
        isActive: p.isActive,
        rate: p.rates[0]
          ? {
              perDayAmount: p.rates[0].perDayAmount.toString(),
              perWeekAmount: p.rates[0].perWeekAmount?.toString() ?? null,
              perMonthAmount: p.rates[0].perMonthAmount?.toString() ?? null,
            }
          : null,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      }));
    });
  }

  async getProduct(tenantId: string, productId: string, actorUserId: string) {
    await this.tenantService.requireMembership(tenantId, actorUserId, [
      'OWNER', 'MANAGER', 'STAFF', 'CASHIER',
    ]);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const p = await tx.product.findUnique({
        where: { tenantId_id: { tenantId, id: productId } },
        include: { rates: true, assets: true },
      });
      if (!p) throw new ApiError(ErrorCode.NOT_FOUND, 'Produk tidak ditemukan.');
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        categoryId: p.categoryId,
        stockMode: p.stockMode,
        capacity: p.capacity,
        isActive: p.isActive,
        rate: p.rates[0]
          ? {
              perDayAmount: p.rates[0].perDayAmount.toString(),
              perWeekAmount: p.rates[0].perWeekAmount?.toString() ?? null,
              perMonthAmount: p.rates[0].perMonthAmount?.toString() ?? null,
            }
          : null,
        assetCount: p.assets.length,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      };
    });
  }

  async createProduct(
    tenantId: string,
    dto: CreateProductDto,
    ctx: { actorUserId: string; correlationId: string },
  ) {
    await this.tenantService.requireMembership(tenantId, ctx.actorUserId, ['OWNER', 'MANAGER']);
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (dto.categoryId) {
        const cat = await tx.category.findUnique({
          where: { tenantId_id: { tenantId, id: dto.categoryId } },
        });
        if (!cat) throw new ApiError(ErrorCode.NOT_FOUND, 'Kategori tidak ditemukan.');
      }
      const product = await tx.product.create({
        data: {
          tenantId,
          name: dto.name.trim(),
          description: dto.description?.trim() ?? null,
          categoryId: dto.categoryId ?? null,
          stockMode: dto.stockMode ?? 'QUANTITY',
          capacity: dto.capacity ?? 0,
          isActive: dto.isActive ?? true,
        },
      });
      await this.audit.record(
        {
          tenantId,
          actorUserId: ctx.actorUserId,
          action: 'PRODUCT_CREATED',
          domain: 'catalog',
          entityType: 'product',
          entityId: product.id,
          correlationId: ctx.correlationId,
        },
        tx,
      );
      return { id: product.id, name: product.name };
    });
  }

  async updateProduct(
    tenantId: string,
    productId: string,
    dto: UpdateProductDto,
    ctx: { actorUserId: string; correlationId: string },
  ) {
    await this.tenantService.requireMembership(tenantId, ctx.actorUserId, ['OWNER', 'MANAGER']);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const existing = await tx.product.findUnique({
        where: { tenantId_id: { tenantId, id: productId } },
      });
      if (!existing) throw new ApiError(ErrorCode.NOT_FOUND, 'Produk tidak ditemukan.');
      if (dto.categoryId) {
        const cat = await tx.category.findUnique({
          where: { tenantId_id: { tenantId, id: dto.categoryId } },
        });
        if (!cat) throw new ApiError(ErrorCode.NOT_FOUND, 'Kategori tidak ditemukan.');
      }
      const updated = await tx.product.update({
        where: { id: productId },
        data: {
          ...(dto.name && { name: dto.name.trim() }),
          ...(dto.description !== undefined && { description: dto.description?.trim() ?? null }),
          ...(dto.categoryId !== undefined && { categoryId: dto.categoryId }),
          ...(dto.capacity !== undefined && { capacity: dto.capacity }),
          ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        },
      });
      await this.audit.record(
        {
          tenantId,
          actorUserId: ctx.actorUserId,
          action: 'PRODUCT_UPDATED',
          domain: 'catalog',
          entityType: 'product',
          entityId: productId,
          correlationId: ctx.correlationId,
          metadata: { changes: dto },
        },
        tx,
      );
      return { id: updated.id, name: updated.name, isActive: updated.isActive };
    });
  }

  async deleteProduct(
    tenantId: string,
    productId: string,
    ctx: { actorUserId: string; correlationId: string },
  ) {
    await this.tenantService.requireMembership(tenantId, ctx.actorUserId, ['OWNER', 'MANAGER']);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const existing = await tx.product.findUnique({
        where: { tenantId_id: { tenantId, id: productId } },
      });
      if (!existing) throw new ApiError(ErrorCode.NOT_FOUND, 'Produk tidak ditemukan.');
      // Soft delete: set isActive = false; jangan hard delete karena referensi order historis.
      await tx.product.update({ where: { id: productId }, data: { isActive: false } });
      await this.audit.record(
        {
          tenantId,
          actorUserId: ctx.actorUserId,
          action: 'PRODUCT_DEACTIVATED',
          domain: 'catalog',
          entityType: 'product',
          entityId: productId,
          fromState: 'ACTIVE',
          toState: 'INACTIVE',
          correlationId: ctx.correlationId,
        },
        tx,
      );
    });
  }

  // ============================================================
  // Rates (harga sewa — upsert: satu rate per produk per tenant)
  // ============================================================

  async getRate(tenantId: string, productId: string, actorUserId: string) {
    await this.tenantService.requireMembership(tenantId, actorUserId, [
      'OWNER', 'MANAGER', 'STAFF', 'CASHIER',
    ]);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rate = await tx.rate.findUnique({
        where: { tenantId_productId: { tenantId, productId } },
      });
      if (!rate) throw new ApiError(ErrorCode.NOT_FOUND, 'Tarif belum ditetapkan untuk produk ini.');
      return {
        productId,
        perDayAmount: rate.perDayAmount.toString(),
        perWeekAmount: rate.perWeekAmount?.toString() ?? null,
        perMonthAmount: rate.perMonthAmount?.toString() ?? null,
        updatedAt: rate.updatedAt,
      };
    });
  }

  async upsertRate(
    tenantId: string,
    productId: string,
    dto: UpsertRateDto,
    ctx: { actorUserId: string; correlationId: string },
  ) {
    await this.tenantService.requireMembership(tenantId, ctx.actorUserId, ['OWNER', 'MANAGER']);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const product = await tx.product.findUnique({
        where: { tenantId_id: { tenantId, id: productId } },
      });
      if (!product) throw new ApiError(ErrorCode.NOT_FOUND, 'Produk tidak ditemukan.');
      // Simpan sebagai BigInt (IDR rupiah utuh).
      const rate = await tx.rate.upsert({
        where: { tenantId_productId: { tenantId, productId } },
        create: {
          tenantId,
          productId,
          perDayAmount: BigInt(dto.perDayAmount),
          perWeekAmount: dto.perWeekAmount ? BigInt(dto.perWeekAmount) : null,
          perMonthAmount: dto.perMonthAmount ? BigInt(dto.perMonthAmount) : null,
        },
        update: {
          perDayAmount: BigInt(dto.perDayAmount),
          perWeekAmount: dto.perWeekAmount ? BigInt(dto.perWeekAmount) : null,
          perMonthAmount: dto.perMonthAmount ? BigInt(dto.perMonthAmount) : null,
        },
      });
      await this.audit.record(
        {
          tenantId,
          actorUserId: ctx.actorUserId,
          action: 'RATE_UPSERTED',
          domain: 'catalog',
          entityType: 'rate',
          entityId: rate.id,
          correlationId: ctx.correlationId,
          metadata: { productId, perDayAmount: dto.perDayAmount },
        },
        tx,
      );
      return {
        productId,
        perDayAmount: rate.perDayAmount.toString(),
        perWeekAmount: rate.perWeekAmount?.toString() ?? null,
        perMonthAmount: rate.perMonthAmount?.toString() ?? null,
      };
    });
  }

  // ============================================================
  // Assets (unit fisik individual)
  // ============================================================

  async listAssets(tenantId: string, productId: string, actorUserId: string) {
    await this.tenantService.requireMembership(tenantId, actorUserId, [
      'OWNER', 'MANAGER', 'STAFF', 'CASHIER',
    ]);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const assets = await tx.asset.findMany({
        where: { tenantId, productId },
        orderBy: { code: 'asc' },
      });
      return assets.map((a) => ({
        id: a.id,
        code: a.code,
        status: a.status,
        conditionNote: a.conditionNote,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      }));
    });
  }

  async createAsset(
    tenantId: string,
    productId: string,
    dto: CreateAssetDto,
    ctx: { actorUserId: string; correlationId: string },
  ) {
    await this.tenantService.requireMembership(tenantId, ctx.actorUserId, ['OWNER', 'MANAGER']);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const product = await tx.product.findUnique({
        where: { tenantId_id: { tenantId, id: productId } },
      });
      if (!product) throw new ApiError(ErrorCode.NOT_FOUND, 'Produk tidak ditemukan.');
      if (product.stockMode !== 'INDIVIDUAL_UNITS') {
        throw new ApiError(
          ErrorCode.BUSINESS_RULE_VIOLATION,
          'Asset hanya dapat ditambahkan pada produk dengan stockMode INDIVIDUAL_UNITS.',
        );
      }
      // Cek duplikat kode dalam tenant.
      const existing = await tx.asset.findUnique({
        where: { tenantId_code: { tenantId, code: dto.code.trim() } },
      });
      if (existing) {
        throw new ApiError(ErrorCode.BUSINESS_RULE_VIOLATION, `Kode asset "${dto.code}" sudah digunakan di tenant ini.`);
      }
      const asset = await tx.asset.create({
        data: {
          tenantId,
          productId,
          code: dto.code.trim(),
          status: dto.status ?? 'AVAILABLE',
          conditionNote: dto.conditionNote?.trim() ?? null,
        },
      });
      await this.audit.record(
        {
          tenantId,
          actorUserId: ctx.actorUserId,
          action: 'ASSET_CREATED',
          domain: 'inventory',
          entityType: 'asset',
          entityId: asset.id,
          toState: asset.status,
          correlationId: ctx.correlationId,
        },
        tx,
      );
      return { id: asset.id, code: asset.code, status: asset.status };
    });
  }

  async updateAsset(
    tenantId: string,
    assetId: string,
    dto: UpdateAssetDto,
    ctx: { actorUserId: string; correlationId: string },
  ) {
    await this.tenantService.requireMembership(tenantId, ctx.actorUserId, ['OWNER', 'MANAGER']);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const existing = await tx.asset.findUnique({
        where: { tenantId_id: { tenantId, id: assetId } },
      });
      if (!existing) throw new ApiError(ErrorCode.NOT_FOUND, 'Asset tidak ditemukan.');
      const updated = await tx.asset.update({
        where: { id: assetId },
        data: {
          ...(dto.status && { status: dto.status }),
          ...(dto.conditionNote !== undefined && { conditionNote: dto.conditionNote?.trim() ?? null }),
        },
      });
      await this.audit.record(
        {
          tenantId,
          actorUserId: ctx.actorUserId,
          action: 'ASSET_UPDATED',
          domain: 'inventory',
          entityType: 'asset',
          entityId: assetId,
          fromState: existing.status,
          toState: updated.status,
          correlationId: ctx.correlationId,
          metadata: { changes: dto },
        },
        tx,
      );
      return { id: updated.id, code: updated.code, status: updated.status };
    });
  }

  // ============================================================
  // Asset Maintenance
  // ============================================================

  async listMaintenance(tenantId: string, assetId: string, actorUserId: string) {
    await this.tenantService.requireMembership(tenantId, actorUserId, [
      'OWNER', 'MANAGER', 'STAFF',
    ]);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const asset = await tx.asset.findUnique({
        where: { tenantId_id: { tenantId, id: assetId } },
      });
      if (!asset) throw new ApiError(ErrorCode.NOT_FOUND, 'Asset tidak ditemukan.');
      const rows = await tx.assetMaintenance.findMany({
        where: { tenantId, assetId },
        orderBy: { startAt: 'desc' },
      });
      return rows.map((m) => ({
        id: m.id,
        startAt: m.startAt,
        endAt: m.endAt,
        reason: m.reason,
        createdAt: m.createdAt,
      }));
    });
  }

  async createMaintenance(
    tenantId: string,
    assetId: string,
    dto: CreateMaintenanceDto,
    ctx: { actorUserId: string; correlationId: string },
  ) {
    await this.tenantService.requireMembership(tenantId, ctx.actorUserId, ['OWNER', 'MANAGER']);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const asset = await tx.asset.findUnique({
        where: { tenantId_id: { tenantId, id: assetId } },
      });
      if (!asset) throw new ApiError(ErrorCode.NOT_FOUND, 'Asset tidak ditemukan.');
      const startAt = new Date(dto.startAt);
      const endAt = new Date(dto.endAt);
      if (isNaN(startAt.getTime()) || isNaN(endAt.getTime())) {
        throw new ApiError(ErrorCode.VALIDATION_ERROR, 'Format tanggal tidak valid (gunakan ISO 8601).');
      }
      if (startAt >= endAt) {
        throw new ApiError(ErrorCode.VALIDATION_ERROR, 'startAt harus sebelum endAt.');
      }
      const maintenance = await tx.assetMaintenance.create({
        data: {
          tenantId,
          assetId,
          productId: asset.productId,
          startAt,
          endAt,
          reason: dto.reason?.trim() ?? null,
        },
      });
      await this.audit.record(
        {
          tenantId,
          actorUserId: ctx.actorUserId,
          action: 'ASSET_MAINTENANCE_CREATED',
          domain: 'inventory',
          entityType: 'asset_maintenance',
          entityId: maintenance.id,
          correlationId: ctx.correlationId,
          metadata: { assetId, startAt: dto.startAt, endAt: dto.endAt },
        },
        tx,
      );
      return { id: maintenance.id, startAt, endAt };
    });
  }
}
