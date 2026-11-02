import { Injectable } from '@nestjs/common';
import type { Prisma } from '@rentalio/database';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { TenantService } from '../tenant/tenant.service.js';
import { ApiError, ErrorCode } from '../common/errors.js';
import {
  ALLOWED_PLACEHOLDERS,
  SAMPLE_VALUES,
  getDefaultTemplate,
} from './whatsapp-templates.defaults.js';
import type {
  CreateWhatsAppTemplateDto,
  DuplicateWhatsAppTemplateDto,
  ListWhatsAppTemplatesQueryDto,
  PreviewWhatsAppTemplateDto,
  UpdateWhatsAppTemplateDto,
} from './whatsapp-templates.dto.js';

type Ctx = { actorUserId: string; correlationId: string };
type TemplateRow = Prisma.WhatsAppTemplateGetPayload<Record<string, never>>;
type VersionRow = Prisma.WhatsAppTemplateVersionGetPayload<Record<string, never>>;

const READ_PERMISSION = 'payment.read';
const MANAGE_PERMISSION = 'settings.whatsapp_templates.manage';
const VERSION_LIMIT = 20;

/**
 * Template WhatsApp per tenant × konteks × metode × tujuan.
 *
 * - Hanya menghasilkan teks click-to-chat; server tidak mengirim pesan.
 * - Placeholder divalidasi terhadap allowlist resmi. Placeholder tak dikenal
 *   ditolak, bukan diganti `undefined`.
 * - Setiap perubahan body membuat versi baru; histori tidak ditimpa.
 * - Semua query berjalan di bawah tenant context (RLS fail-closed).
 */
@Injectable()
export class WhatsAppTemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tenantService: TenantService,
  ) {}

  async list(tenantId: string, query: ListWhatsAppTemplatesQueryDto, actorUserId: string) {
    await this.tenantService.requirePermission(tenantId, actorUserId, READ_PERMISSION);
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.whatsAppTemplate.findMany({
        where: {
          tenantId,
          ...(query.context ? { context: query.context } : {}),
          ...(query.paymentMethod ? { paymentMethod: query.paymentMethod } : {}),
          ...(query.purpose ? { purpose: query.purpose } : {}),
          ...(query.status ? { isActive: query.status === 'ACTIVE' } : {}),
        },
        orderBy: [{ context: 'asc' }, { paymentMethod: 'asc' }, { purpose: 'asc' }],
      });
      return { data: rows.map((row) => this.mapTemplate(row)) };
    });
  }

  async get(tenantId: string, templateId: string, actorUserId: string) {
    await this.tenantService.requirePermission(tenantId, actorUserId, READ_PERMISSION);
    return this.prisma.withTenant(tenantId, (tx) => this.loadTemplate(tx, tenantId, templateId));
  }

  async create(tenantId: string, dto: CreateWhatsAppTemplateDto, ctx: Ctx) {
    await this.tenantService.requirePermission(tenantId, ctx.actorUserId, MANAGE_PERMISSION);
    const name = dto.name.trim();
    const body = dto.body.trim();
    this.requireNonEmpty(name, 'name');
    this.requireNonEmpty(body, 'body');
    this.validateBody(body);

    try {
      return await this.prisma.withTenant(tenantId, async (tx) => {
        // Serialisasi create per tenant agar dua request dengan kombinasi sama
        // tidak menghasilkan error 500 dari unique constraint.
        await this.lockTenant(tx, tenantId);
        await this.requireUnusedCombination(
          tx,
          tenantId,
          dto.context,
          dto.paymentMethod,
          dto.purpose,
        );

        const template = await this.insertTemplate(tx, {
          tenantId,
          context: dto.context,
          paymentMethod: dto.paymentMethod,
          purpose: dto.purpose,
          name,
          body,
          isActive: dto.isActive ?? true,
          actorUserId: ctx.actorUserId,
          versionMetadata: { created: true },
          changeReason: 'TEMPLATE_CREATED',
        });

        await this.audit.record(
          {
            tenantId,
            actorUserId: ctx.actorUserId,
            action: 'WHATSAPP_TEMPLATE_CREATED',
            domain: 'notification',
            entityType: 'whatsapp_template',
            entityId: template.id,
            correlationId: ctx.correlationId,
            metadata: {
              context: template.context,
              paymentMethod: template.paymentMethod,
              purpose: template.purpose,
              version: 1,
            },
          },
          tx,
        );

        return this.loadTemplate(tx, tenantId, template.id);
      });
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        throw new ApiError(
          ErrorCode.BUSINESS_RULE_VIOLATION,
          'Template untuk kombinasi konteks, metode, dan tujuan ini sudah ada.',
        );
      }
      throw err;
    }
  }

  /**
   * Gandakan template yang sudah ada ke kombinasi konteks × metode × tujuan
   * lain (dokumen 04: `POST .../whatsapp-templates/:templateId/duplicate`).
   *
   * Salinan dibuat sebagai template baru dengan versi 1 dan body yang sama;
   * template sumber tidak diubah sama sekali. Kombinasi tujuan yang sudah
   * terisi ditolak 422, konsisten dengan `create`.
   */
  async duplicate(
    tenantId: string,
    templateId: string,
    dto: DuplicateWhatsAppTemplateDto,
    ctx: Ctx,
  ) {
    await this.tenantService.requirePermission(tenantId, ctx.actorUserId, MANAGE_PERMISSION);
    const requestedName = dto.name?.trim();
    if (requestedName !== undefined) this.requireNonEmpty(requestedName, 'name');

    try {
      return await this.prisma.withTenant(tenantId, async (tx) => {
        await this.lockTenant(tx, tenantId);
        const source = await tx.whatsAppTemplate.findUnique({
          where: { tenantId_id: { tenantId, id: templateId } },
        });
        if (!source) throw new ApiError(ErrorCode.NOT_FOUND, 'Template tidak ditemukan.');

        // Salinan selalu ditujukan ke kombinasi lain; nama sumber + suffix
        // dipotong pada batas 120 karakter agar tetap valid.
        const name = (requestedName ?? `${source.name} (salinan)`).slice(0, 120);
        const body = source.body;
        this.validateBody(body);

        await this.requireUnusedCombination(
          tx,
          tenantId,
          dto.context,
          dto.paymentMethod,
          dto.purpose,
        );

        const template = await this.insertTemplate(tx, {
          tenantId,
          context: dto.context,
          paymentMethod: dto.paymentMethod,
          purpose: dto.purpose,
          name,
          body,
          isActive: dto.isActive ?? source.isActive,
          actorUserId: ctx.actorUserId,
          versionMetadata: { duplicatedFrom: source.id },
          changeReason: 'TEMPLATE_DUPLICATED',
        });

        await this.audit.record(
          {
            tenantId,
            actorUserId: ctx.actorUserId,
            action: 'WHATSAPP_TEMPLATE_DUPLICATED',
            domain: 'notification',
            entityType: 'whatsapp_template',
            entityId: template.id,
            correlationId: ctx.correlationId,
            metadata: {
              sourceTemplateId: source.id,
              context: template.context,
              paymentMethod: template.paymentMethod,
              purpose: template.purpose,
              version: 1,
            },
          },
          tx,
        );

        return this.loadTemplate(tx, tenantId, template.id);
      });
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        throw new ApiError(
          ErrorCode.BUSINESS_RULE_VIOLATION,
          'Template untuk kombinasi konteks, metode, dan tujuan ini sudah ada.',
        );
      }
      throw err;
    }
  }

  async update(
    tenantId: string,
    templateId: string,
    dto: UpdateWhatsAppTemplateDto,
    ctx: Ctx,
  ) {
    await this.tenantService.requirePermission(tenantId, ctx.actorUserId, MANAGE_PERMISSION);
    if (dto.name !== undefined) this.requireNonEmpty(dto.name.trim(), 'name');
    if (dto.body !== undefined) {
      this.requireNonEmpty(dto.body.trim(), 'body');
      this.validateBody(dto.body.trim());
    }

    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.lockTemplate(tx, tenantId, templateId);
      const current = await tx.whatsAppTemplate.findUnique({
        where: { tenantId_id: { tenantId, id: templateId } },
      });
      if (!current) throw new ApiError(ErrorCode.NOT_FOUND, 'Template tidak ditemukan.');

      const changedFields = Object.entries(dto)
        .filter(([, value]) => value !== undefined)
        .map(([key]) => key);
      if (changedFields.length === 0) {
        return this.loadTemplate(tx, tenantId, templateId);
      }

      const updated = await tx.whatsAppTemplate.update({
        where: { tenantId_id: { tenantId, id: templateId } },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.body !== undefined ? { body: dto.body.trim() } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
          isSystemDefault: false,
          updatedByUserId: ctx.actorUserId,
          currentVersion: { increment: 1 },
        },
      });

      await tx.whatsAppTemplateVersion.create({
        data: {
          tenantId,
          templateId,
          version: updated.currentVersion,
          bodySnapshot: updated.body,
          metadataSnapshot: { changedFields },
          actorId: ctx.actorUserId,
          changeReason: 'TEMPLATE_UPDATED',
        },
      });

      await this.audit.record(
        {
          tenantId,
          actorUserId: ctx.actorUserId,
          action: 'WHATSAPP_TEMPLATE_UPDATED',
          domain: 'notification',
          entityType: 'whatsapp_template',
          entityId: templateId,
          correlationId: ctx.correlationId,
          metadata: { changedFields, version: updated.currentVersion },
        },
        tx,
      );

      return this.loadTemplate(tx, tenantId, templateId);
    });
  }

  async restoreDefault(tenantId: string, templateId: string, ctx: Ctx) {
    await this.tenantService.requirePermission(tenantId, ctx.actorUserId, MANAGE_PERMISSION);

    return this.prisma.withTenant(tenantId, async (tx) => {
      await this.lockTemplate(tx, tenantId, templateId);
      const current = await tx.whatsAppTemplate.findUnique({
        where: { tenantId_id: { tenantId, id: templateId } },
      });
      if (!current) throw new ApiError(ErrorCode.NOT_FOUND, 'Template tidak ditemukan.');

      const fallback = getDefaultTemplate(
        current.context,
        current.paymentMethod,
        current.purpose,
      );
      if (!fallback) {
        throw new ApiError(
          ErrorCode.BUSINESS_RULE_VIOLATION,
          'Tidak ada template bawaan untuk kombinasi konteks, metode, dan tujuan ini.',
        );
      }

      const updated = await tx.whatsAppTemplate.update({
        where: { tenantId_id: { tenantId, id: templateId } },
        data: {
          name: fallback.name,
          body: fallback.body,
          isActive: true,
          isSystemDefault: true,
          defaultTemplateKey: fallback.key,
          updatedByUserId: ctx.actorUserId,
          currentVersion: { increment: 1 },
        },
      });

      await tx.whatsAppTemplateVersion.create({
        data: {
          tenantId,
          templateId,
          version: updated.currentVersion,
          bodySnapshot: updated.body,
          metadataSnapshot: { restored: true, defaultTemplateKey: fallback.key },
          actorId: ctx.actorUserId,
          changeReason: 'RESTORE_DEFAULT',
        },
      });

      await this.audit.record(
        {
          tenantId,
          actorUserId: ctx.actorUserId,
          action: 'WHATSAPP_TEMPLATE_RESTORED',
          domain: 'notification',
          entityType: 'whatsapp_template',
          entityId: templateId,
          correlationId: ctx.correlationId,
          metadata: { version: updated.currentVersion, defaultTemplateKey: fallback.key },
        },
        tx,
      );

      return this.loadTemplate(tx, tenantId, templateId);
    });
  }

  async preview(tenantId: string, dto: PreviewWhatsAppTemplateDto, actorUserId: string) {
    await this.tenantService.requirePermission(tenantId, actorUserId, READ_PERMISSION);
    const body = dto.body.trim();
    this.requireNonEmpty(body, 'body');
    const placeholders = this.validateBody(body);

    const values = dto.values ?? {};
    for (const [key, value] of Object.entries(values)) {
      if (!(ALLOWED_PLACEHOLDERS as readonly string[]).includes(key)) {
        throw new ApiError(
          ErrorCode.VALIDATION_ERROR,
          `Placeholder tidak dikenal: ${key}.`,
        );
      }
      if (typeof value !== 'string') {
        throw new ApiError(
          ErrorCode.VALIDATION_ERROR,
          `Nilai placeholder ${key} harus string.`,
        );
      }
    }

    const merged: Record<string, string> = {
      ...SAMPLE_VALUES,
      ...values,
    };
    const rendered = body.replace(
      /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
      (_match, key: string) => merged[key] ?? '',
    );

    return { body: rendered, placeholders };
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  /**
   * Validasi allowlist placeholder. Selain nama tak dikenal, sisa `{{`/`}}`
   * yang tidak membentuk placeholder valid juga ditolak agar preview tidak
   * menghasilkan teks setengah jadi.
   */
  private validateBody(body: string): string[] {
    const placeholders = [...body.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map(
      (match) => match[1],
    );
    const unknown = [...new Set(placeholders)].filter(
      (name) => !(ALLOWED_PLACEHOLDERS as readonly string[]).includes(name),
    );
    if (unknown.length > 0) {
      throw new ApiError(
        ErrorCode.VALIDATION_ERROR,
        `Placeholder tidak dikenal: ${unknown.join(', ')}. Gunakan placeholder resmi.`,
      );
    }
    const stripped = body.replace(/\{\{\s*[a-zA-Z0-9_]+\s*\}\}/g, '');
    if (stripped.includes('{{') || stripped.includes('}}')) {
      throw new ApiError(
        ErrorCode.VALIDATION_ERROR,
        'Format placeholder tidak valid. Gunakan {{nama_placeholder}}.',
      );
    }
    return [...new Set(placeholders)];
  }

  private requireNonEmpty(value: string, field: string): void {
    if (value.length === 0) {
      throw new ApiError(ErrorCode.VALIDATION_ERROR, `${field} tidak boleh kosong.`);
    }
  }

  /** Kunci unik template per tenant: konteks × metode × tujuan. */
  private async requireUnusedCombination(
    tx: Prisma.TransactionClient,
    tenantId: string,
    context: CreateWhatsAppTemplateDto['context'],
    paymentMethod: CreateWhatsAppTemplateDto['paymentMethod'],
    purpose: CreateWhatsAppTemplateDto['purpose'],
  ): Promise<void> {
    const existing = await tx.whatsAppTemplate.findUnique({
      where: {
        tenantId_context_paymentMethod_purpose: {
          tenantId,
          context,
          paymentMethod,
          purpose,
        },
      },
    });
    if (existing) {
      throw new ApiError(
        ErrorCode.BUSINESS_RULE_VIOLATION,
        'Template untuk kombinasi konteks, metode, dan tujuan ini sudah ada.',
      );
    }
  }

  /** Kunci row tenant — serialisasi create/duplicate dalam satu tenant. */
  private async lockTenant(tx: Prisma.TransactionClient, tenantId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${tenantId} FOR UPDATE`;
  }

  /**
   * Buat template + versi 1 dalam transaksi yang sedang berjalan.
   * Dipakai `create` dan `duplicate` agar kontrak versi/audit tetap satu.
   */
  private async insertTemplate(
    tx: Prisma.TransactionClient,
    params: {
      tenantId: string;
      context: CreateWhatsAppTemplateDto['context'];
      paymentMethod: CreateWhatsAppTemplateDto['paymentMethod'];
      purpose: CreateWhatsAppTemplateDto['purpose'];
      name: string;
      body: string;
      isActive: boolean;
      actorUserId: string;
      versionMetadata: Prisma.InputJsonValue;
      changeReason: string;
    },
  ) {
    const template = await tx.whatsAppTemplate.create({
      data: {
        tenantId: params.tenantId,
        context: params.context,
        paymentMethod: params.paymentMethod,
        purpose: params.purpose,
        name: params.name,
        body: params.body,
        isActive: params.isActive,
        isSystemDefault: false,
        defaultTemplateKey: `${params.context}_${params.paymentMethod}_${params.purpose}`,
        currentVersion: 1,
        createdByUserId: params.actorUserId,
        updatedByUserId: params.actorUserId,
      },
    });
    await tx.whatsAppTemplateVersion.create({
      data: {
        tenantId: params.tenantId,
        templateId: template.id,
        version: 1,
        bodySnapshot: template.body,
        metadataSnapshot: params.versionMetadata,
        actorId: params.actorUserId,
        changeReason: params.changeReason,
      },
    });
    return template;
  }

  private async lockTemplate(
    tx: Prisma.TransactionClient,
    tenantId: string,
    templateId: string,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM whatsapp_templates WHERE "tenantId" = ${tenantId} AND id = ${templateId} FOR UPDATE`;
  }

  private async loadTemplate(
    tx: Prisma.TransactionClient,
    tenantId: string,
    templateId: string,
  ) {
    const row = await tx.whatsAppTemplate.findUnique({
      where: { tenantId_id: { tenantId, id: templateId } },
      include: { versions: { orderBy: { version: 'desc' }, take: VERSION_LIMIT } },
    });
    if (!row) throw new ApiError(ErrorCode.NOT_FOUND, 'Template tidak ditemukan.');
    return {
      ...this.mapTemplate(row),
      versions: row.versions.map((version) => this.mapVersion(version)),
    };
  }

  private mapTemplate(row: TemplateRow) {
    return {
      id: row.id,
      context: row.context,
      paymentMethod: row.paymentMethod,
      purpose: row.purpose,
      name: row.name,
      body: row.body,
      isActive: row.isActive,
      isSystemDefault: row.isSystemDefault,
      defaultTemplateKey: row.defaultTemplateKey,
      currentVersion: row.currentVersion,
      createdByUserId: row.createdByUserId,
      updatedByUserId: row.updatedByUserId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private mapVersion(row: VersionRow) {
    return {
      id: row.id,
      version: row.version,
      bodySnapshot: row.bodySnapshot,
      metadataSnapshot: row.metadataSnapshot,
      actorId: row.actorId,
      changeReason: row.changeReason,
      createdAt: row.createdAt,
    };
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      (err as { code?: string }).code === 'P2002'
    );
  }
}
