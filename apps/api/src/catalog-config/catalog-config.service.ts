import { Injectable } from '@nestjs/common';
import { Prisma } from '@rentalio/database';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { TenantService } from '../tenant/tenant.service.js';
import { ApiError, ErrorCode } from '../common/errors.js';
import {
  CATALOG_SCHEMA_VERSION,
  MAX_CONFIG_BYTES,
  catalogBlockCatalog,
  validateCatalogConfig,
} from './catalog-config.schema.js';
import {
  CATALOG_TEMPLATES,
  DEFAULT_CATALOG_THEME,
  catalogTemplateSummaries,
  defaultCatalogBlocks,
  findCatalogTemplate,
} from './catalog-config.templates.js';
import type { SaveCatalogConfigDto } from './catalog-config.dto.js';

type Ctx = { actorUserId: string; correlationId: string };
type ConfigRow = Prisma.CatalogConfigVersionGetPayload<Record<string, never>>;

const READ_PERMISSION = 'catalog.read';
const MANAGE_PERMISSION = 'catalog.write';
const DEFAULT_TEMPLATE_KEY = 'klasik-hangat';
const VERSION_PAGE_SIZE = 50;

/**
 * Konfigurasi presentasi katalog per tenant (Notion 06 WEB-07).
 *
 * Alur: DRAF (privat, satu per tenant) → PUBLISH (versi live dibaca katalog
 * publik) → versi lama diarsipkan tetapi tetap tersimpan sehingga ROLLBACK
 * mengembalikan snapshot lama tanpa menimpa histori.
 *
 * Yang dijaga modul ini:
 * - Hanya presentasi. Tidak ada harga, stok, ketersediaan, booking,
 *   pembayaran, permission, atau entitlement di dalam konfigurasi.
 * - Setiap simpan/publish divalidasi allowlist komponen+properti; konfigurasi
 *   tidak valid ditolak (400) dan tidak pernah tersimpan.
 * - Publish juga memvalidasi ulang konfigurasi tersimpan (defensif) supaya
 *   data lama yang tidak lagi sesuai skema tidak pernah tayang.
 * - Semua query berjalan di bawah tenant context (RLS fail-closed).
 */
@Injectable()
export class CatalogConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tenantService: TenantService,
  ) {}

  // ============================================================
  // Baca status editor (draf + versi live)
  // ============================================================

  async getState(tenantId: string, actorUserId: string) {
    await this.tenantService.requirePermission(tenantId, actorUserId, READ_PERMISSION);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const [draft, published] = await Promise.all([
        tx.catalogConfigVersion.findFirst({ where: { tenantId, status: 'DRAFT' } }),
        tx.catalogConfigVersion.findFirst({ where: { tenantId, status: 'PUBLISHED' } }),
      ]);
      return {
        draft: draft ? this.mapVersion(draft, true) : null,
        published: published ? this.mapVersion(published, true) : null,
        // Editor tetap bisa membuka halaman walau belum pernah menyimpan draf.
        defaults: {
          theme: DEFAULT_CATALOG_THEME,
          branding: {},
          blocks: defaultCatalogBlocks(),
          templateKey: DEFAULT_TEMPLATE_KEY,
          schemaVersion: CATALOG_SCHEMA_VERSION,
        },
      };
    });
  }

  async listVersions(tenantId: string, actorUserId: string) {
    await this.tenantService.requirePermission(tenantId, actorUserId, READ_PERMISSION);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.catalogConfigVersion.findMany({
        where: { tenantId },
        orderBy: { version: 'desc' },
        take: VERSION_PAGE_SIZE,
      });
      return { data: rows.map((row) => this.mapVersion(row, false)) };
    });
  }

  async getVersion(tenantId: string, versionId: string, actorUserId: string) {
    await this.tenantService.requirePermission(tenantId, actorUserId, READ_PERMISSION);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const row = await this.findVersion(tx, tenantId, versionId);
      return this.mapVersion(row, true);
    });
  }

  /** Galeri template bawaan (staf dengan akses katalog boleh melihat). */
  async listTemplates(tenantId: string, actorUserId: string) {
    await this.tenantService.requirePermission(tenantId, actorUserId, READ_PERMISSION);
    return {
      data: {
        templates: catalogTemplateSummaries(),
        blocks: catalogBlockCatalog(),
      },
    };
  }

  /** Daftar blok + properti yang diizinkan (allowlist, untuk UI editor). */
  async listBlocks(tenantId: string, actorUserId: string) {
    await this.tenantService.requirePermission(tenantId, actorUserId, READ_PERMISSION);
    return { data: { blocks: catalogBlockCatalog(), schemaVersion: CATALOG_SCHEMA_VERSION } };
  }

  // ============================================================
  // Validasi & simpan draf
  // ============================================================

  /**
   * Validasi tanpa menyimpan. Mengembalikan konfigurasi ternormalisasi bila
   * valid, atau 400 dengan daftar pelanggaran (path + pesan) — bukan error
   * generik, supaya editor bisa menunjuk blok/properti yang salah.
   */
  async validateConfig(tenantId: string, dto: SaveCatalogConfigDto, actorUserId: string) {
    await this.tenantService.requirePermission(tenantId, actorUserId, READ_PERMISSION);
    const result = this.normalize(dto);
    return {
      valid: result.ok,
      schemaVersion: CATALOG_SCHEMA_VERSION,
      issues: result.errors,
      config: result.value ?? null,
    };
  }

  async saveDraft(tenantId: string, dto: SaveCatalogConfigDto, ctx: Ctx) {
    await this.tenantService.requirePermission(tenantId, ctx.actorUserId, MANAGE_PERMISSION);

    const saved = await this.prisma.withTenant(tenantId, async (tx) => {
      await this.lockTenant(tx, tenantId);
      const draft = await this.ensureDraft(tx, tenantId, ctx.actorUserId);
      // Menyimpan perubahan isi tidak menghapus label template yang sedang
      // dipakai; label hanya berubah bila template lain benar-benar diminta.
      const { value, templateKey } = this.normalizeOrThrow(dto, draft.templateKey);
      const updated = await tx.catalogConfigVersion.update({
        where: { tenantId_id: { tenantId, id: draft.id } },
        data: {
          config: value as unknown as Prisma.InputJsonValue,
          schemaVersion: CATALOG_SCHEMA_VERSION,
          templateKey,
        },
      });

      await this.audit.record(
        {
          tenantId,
          actorUserId: ctx.actorUserId,
          action: 'CATALOG_CONFIG_DRAFT_SAVED',
          domain: 'catalog',
          entityType: 'catalog_config_version',
          entityId: updated.id,
          correlationId: ctx.correlationId,
          metadata: {
            version: updated.version,
            templateKey,
            blocks: value.blocks.length,
            bytes: Buffer.byteLength(JSON.stringify(value), 'utf8'),
          },
        },
        tx,
      );

      return updated;
    });

    return this.mapVersion(saved, true);
  }

  // ============================================================
  // Publish & rollback
  // ============================================================

  /**
   * Publish draf sebagai versi live. Versi live sebelumnya diarsipkan (bukan
   * dihapus) dan draf baru otomatis dibuat dari hasil publish supaya editor
   * selalu punya ruang kerja tanpa mengubah yang sudah tayang.
   */
  async publish(tenantId: string, ctx: Ctx) {
    await this.tenantService.requirePermission(tenantId, ctx.actorUserId, MANAGE_PERMISSION);

    const result = await this.prisma.withTenant(tenantId, async (tx) => {
      await this.lockTenant(tx, tenantId);
      const draft = await this.ensureDraft(tx, tenantId, ctx.actorUserId);

      // Defensif: konfigurasi tersimpan wajib masih lolos skema saat tayang.
      const validation = validateCatalogConfig(draft.config);
      if (!validation.ok || !validation.value) {
        throw new ApiError(
          ErrorCode.VALIDATION_ERROR,
          'Konfigurasi draf tidak valid sehingga tidak dapat dipublikasikan.',
          { issues: validation.errors },
        );
      }

      await tx.catalogConfigVersion.updateMany({
        where: { tenantId, status: 'PUBLISHED' },
        data: { status: 'ARCHIVED' },
      });

      const published = await tx.catalogConfigVersion.update({
        where: { tenantId_id: { tenantId, id: draft.id } },
        data: {
          status: 'PUBLISHED',
          publishedAt: new Date(),
          publishedByUserId: ctx.actorUserId,
          schemaVersion: CATALOG_SCHEMA_VERSION,
        },
      });

      const nextDraft = await tx.catalogConfigVersion.create({
        data: {
          tenantId,
          version: published.version + 1,
          status: 'DRAFT',
          schemaVersion: CATALOG_SCHEMA_VERSION,
          templateKey: published.templateKey,
          config: validation.value as unknown as Prisma.InputJsonValue,
          createdByUserId: ctx.actorUserId,
        },
      });

      await this.audit.record(
        {
          tenantId,
          actorUserId: ctx.actorUserId,
          action: 'CATALOG_CONFIG_PUBLISHED',
          domain: 'catalog',
          entityType: 'catalog_config_version',
          entityId: published.id,
          toState: 'PUBLISHED',
          correlationId: ctx.correlationId,
          metadata: {
            version: published.version,
            templateKey: published.templateKey,
            blocks: validation.value.blocks.length,
          },
        },
        tx,
      );

      return { published, draft: nextDraft };
    });

    return {
      published: this.mapVersion(result.published, true),
      draft: this.mapVersion(result.draft, true),
    };
  }

  /**
   * Rollback: salin snapshot versi lama (PUBLISHED/ARCHIVED) ke draf. Halaman
   * publik tidak berubah sampai publish dijalankan lagi, sehingga pemulihan
   * selalu bisa ditinjau dulu.
   */
  async restoreVersion(tenantId: string, versionId: string, ctx: Ctx) {
    await this.tenantService.requirePermission(tenantId, ctx.actorUserId, MANAGE_PERMISSION);

    const draft = await this.prisma.withTenant(tenantId, async (tx) => {
      await this.lockTenant(tx, tenantId);
      const source = await this.findVersion(tx, tenantId, versionId);
      const validation = validateCatalogConfig(source.config);
      if (!validation.ok || !validation.value) {
        throw new ApiError(
          ErrorCode.VALIDATION_ERROR,
          'Versi yang dipulihkan tidak lolos validasi skema saat ini.',
          { issues: validation.errors },
        );
      }

      const target = await this.ensureDraft(tx, tenantId, ctx.actorUserId);
      const updated = await tx.catalogConfigVersion.update({
        where: { tenantId_id: { tenantId, id: target.id } },
        data: {
          config: validation.value as unknown as Prisma.InputJsonValue,
          templateKey: source.templateKey,
          schemaVersion: CATALOG_SCHEMA_VERSION,
        },
      });

      await this.audit.record(
        {
          tenantId,
          actorUserId: ctx.actorUserId,
          action: 'CATALOG_CONFIG_VERSION_RESTORED',
          domain: 'catalog',
          entityType: 'catalog_config_version',
          entityId: updated.id,
          correlationId: ctx.correlationId,
          metadata: {
            restoredFromVersion: source.version,
            restoredFromStatus: source.status,
            draftVersion: updated.version,
          },
        },
        tx,
      );

      return updated;
    });

    return this.mapVersion(draft, true);
  }

  // ============================================================
  // Template bawaan
  // ============================================================

  /**
   * Terapkan template ke draf. Hanya draf yang berubah — versi live tetap
   * sampai publish berikutnya.
   */
  async applyTemplate(tenantId: string, templateKey: string, ctx: Ctx) {
    await this.tenantService.requirePermission(tenantId, ctx.actorUserId, MANAGE_PERMISSION);
    const template = findCatalogTemplate(templateKey);
    if (!template) {
      throw new ApiError(
        ErrorCode.NOT_FOUND,
        'Template tidak ditemukan.',
        { available: CATALOG_TEMPLATES.map((item) => item.key) },
      );
    }

    const validation = validateCatalogConfig({
      theme: template.theme,
      branding: {},
      blocks: template.blocks,
    });
    if (!validation.ok || !validation.value) {
      // Template bawaan diuji terhadap skema, jadi ini kegagalan internal.
      throw new ApiError(
        ErrorCode.INTERNAL_ERROR,
        'Template bawaan tidak lolos validasi skema.',
        { issues: validation.errors },
      );
    }

    const draft = await this.prisma.withTenant(tenantId, async (tx) => {
      await this.lockTenant(tx, tenantId);
      const target = await this.ensureDraft(tx, tenantId, ctx.actorUserId);
      const current = validateCatalogConfig(target.config);
      const branding = current.value?.branding ?? {};

      const updated = await tx.catalogConfigVersion.update({
        where: { tenantId_id: { tenantId, id: target.id } },
        data: {
          // Branding milik tenant tidak ikut ditimpa oleh template.
          config: {
            theme: validation.value!.theme,
            branding,
            blocks: validation.value!.blocks,
          } as unknown as Prisma.InputJsonValue,
          templateKey,
          schemaVersion: CATALOG_SCHEMA_VERSION,
        },
      });

      await this.audit.record(
        {
          tenantId,
          actorUserId: ctx.actorUserId,
          action: 'CATALOG_CONFIG_TEMPLATE_APPLIED',
          domain: 'catalog',
          entityType: 'catalog_config_version',
          entityId: updated.id,
          correlationId: ctx.correlationId,
          metadata: { templateKey, blocks: validation.value!.blocks.length },
        },
        tx,
      );

      return updated;
    });

    return this.mapVersion(draft, true);
  }

  // ============================================================
  // Baca publik (tanpa sesi) — dipakai katalog publik
  // ============================================================

  /**
   * Konfigurasi live untuk katalog publik. Bila tenant belum pernah publish,
   * dipakai konfigurasi default sehingga storefront selalu bisa dirender.
   * Pemanggil bertanggung jawab meresolusi tenant (slug/domain) dan rate limit.
   */
  async readPublished(tenantId: string) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const row = await tx.catalogConfigVersion.findFirst({
        where: { tenantId, status: 'PUBLISHED' },
      });
      if (!row) {
        return {
          isPublished: false,
          version: null,
          publishedAt: null,
          templateKey: DEFAULT_TEMPLATE_KEY,
          schemaVersion: CATALOG_SCHEMA_VERSION,
          config: {
            theme: DEFAULT_CATALOG_THEME,
            branding: {},
            blocks: defaultCatalogBlocks(),
          },
        };
      }
      const validation = validateCatalogConfig(row.config);
      // Data live yang tidak lagi sesuai skema tidak ditayangkan mentah.
      const config = validation.ok && validation.value
        ? validation.value
        : { theme: DEFAULT_CATALOG_THEME, branding: {}, blocks: defaultCatalogBlocks() };
      return {
        isPublished: true,
        version: row.version,
        publishedAt: row.publishedAt,
        templateKey: row.templateKey,
        schemaVersion: row.schemaVersion,
        config,
      };
    });
  }

  // ============================================================
  // Helpers
  // ============================================================

  private normalize(dto: SaveCatalogConfigDto) {
    return validateCatalogConfig({
      theme: dto.theme ?? {},
      branding: dto.branding ?? {},
      blocks: dto.blocks ?? [],
    });
  }

  private normalizeOrThrow(
    dto: SaveCatalogConfigDto,
    fallbackTemplateKey: string = DEFAULT_TEMPLATE_KEY,
  ): {
    value: NonNullable<ReturnType<typeof validateCatalogConfig>['value']>;
    templateKey: string;
  } {
    const templateKey = (dto.templateKey ?? fallbackTemplateKey ?? DEFAULT_TEMPLATE_KEY).trim();
    if (!findCatalogTemplate(templateKey)) {
      throw new ApiError(ErrorCode.NOT_FOUND, 'Template tidak ditemukan.', {
        available: CATALOG_TEMPLATES.map((item) => item.key),
      });
    }
    const result = this.normalize(dto);
    if (!result.ok || !result.value) {
      throw new ApiError(
        ErrorCode.VALIDATION_ERROR,
        'Konfigurasi katalog tidak valid. Periksa blok dan propertinya.',
        { issues: result.errors, maxBytes: MAX_CONFIG_BYTES },
      );
    }
    return { value: result.value, templateKey };
  }

  /** Serialisasi perubahan konfigurasi per tenant (dua request bersamaan). */
  private async lockTenant(tx: Prisma.TransactionClient, tenantId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${tenantId} FOR UPDATE`;
  }

  private async nextVersion(tx: Prisma.TransactionClient, tenantId: string): Promise<number> {
    const aggregate = await tx.catalogConfigVersion.aggregate({
      where: { tenantId },
      _max: { version: true },
    });
    return (aggregate._max.version ?? 0) + 1;
  }

  /**
   * Ambil draf tenant, buat bila belum ada. Versi draf sudah "dipesan"
   * (maks+1) sehingga saat publish nomor versinya tidak bertabrakan.
   */
  private async ensureDraft(
    tx: Prisma.TransactionClient,
    tenantId: string,
    actorUserId: string,
  ): Promise<ConfigRow> {
    const existing = await tx.catalogConfigVersion.findFirst({
      where: { tenantId, status: 'DRAFT' },
    });
    if (existing) return existing;

    const version = await this.nextVersion(tx, tenantId);
    return tx.catalogConfigVersion.create({
      data: {
        tenantId,
        version,
        status: 'DRAFT',
        schemaVersion: CATALOG_SCHEMA_VERSION,
        templateKey: DEFAULT_TEMPLATE_KEY,
        config: {
          theme: DEFAULT_CATALOG_THEME,
          branding: {},
          blocks: defaultCatalogBlocks(),
        } as unknown as Prisma.InputJsonValue,
        createdByUserId: actorUserId,
      },
    });
  }

  private async findVersion(
    tx: Prisma.TransactionClient,
    tenantId: string,
    versionId: string,
  ): Promise<ConfigRow> {
    if (!/^[0-9a-f-]{36}$/i.test(versionId)) {
      throw new ApiError(ErrorCode.NOT_FOUND, 'Versi konfigurasi tidak ditemukan.');
    }
    const row = await tx.catalogConfigVersion.findUnique({
      where: { tenantId_id: { tenantId, id: versionId } },
    });
    if (!row) throw new ApiError(ErrorCode.NOT_FOUND, 'Versi konfigurasi tidak ditemukan.');
    return row;
  }

  private mapVersion(row: ConfigRow, withConfig: boolean) {
    const stored = row.config as unknown as {
      theme?: Record<string, unknown>;
      branding?: Record<string, unknown>;
      blocks?: Array<{ enabled?: boolean }>;
    } | null;
    const blocks = Array.isArray(stored?.blocks) ? stored.blocks : [];
    return {
      id: row.id,
      version: row.version,
      status: row.status,
      schemaVersion: row.schemaVersion,
      templateKey: row.templateKey,
      blockCount: blocks.length,
      enabledBlockCount: blocks.filter((block) => block.enabled !== false).length,
      createdByUserId: row.createdByUserId,
      publishedByUserId: row.publishedByUserId,
      publishedAt: row.publishedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(withConfig
        ? {
            config: {
              theme: stored?.theme ?? {},
              branding: stored?.branding ?? {},
              blocks,
            },
          }
        : {}),
    };
  }
}
