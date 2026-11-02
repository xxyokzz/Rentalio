import {
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import type {
  PaymentContext,
  PaymentMethod,
  WhatsAppTemplatePurpose,
} from '@rentalio/database';
import {
  TEMPLATE_CONTEXTS,
  TEMPLATE_METHODS,
  TEMPLATE_PURPOSES,
} from './whatsapp-templates.defaults.js';

export class ListWhatsAppTemplatesQueryDto {
  @IsOptional()
  @IsIn(TEMPLATE_CONTEXTS)
  context?: PaymentContext;

  @IsOptional()
  @IsIn(TEMPLATE_METHODS)
  paymentMethod?: PaymentMethod;

  @IsOptional()
  @IsIn(TEMPLATE_PURPOSES)
  purpose?: WhatsAppTemplatePurpose;

  @IsOptional()
  @IsIn(['ACTIVE', 'INACTIVE'])
  status?: 'ACTIVE' | 'INACTIVE';
}

export class CreateWhatsAppTemplateDto {
  @IsIn(TEMPLATE_CONTEXTS)
  context!: PaymentContext;

  @IsIn(TEMPLATE_METHODS)
  paymentMethod!: PaymentMethod;

  @IsIn(TEMPLATE_PURPOSES)
  purpose!: WhatsAppTemplatePurpose;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body!: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/**
 * Penggandaan template (dokumen 04 — `POST .../whatsapp-templates/:templateId/duplicate`).
 * Identitas template adalah konteks × metode × tujuan, jadi salinan selalu
 * menuju kombinasi tujuan yang berbeda — kombinasi yang sudah terisi ditolak 422.
 */
export class DuplicateWhatsAppTemplateDto {
  @IsIn(TEMPLATE_CONTEXTS)
  context!: PaymentContext;

  @IsIn(TEMPLATE_METHODS)
  paymentMethod!: PaymentMethod;

  @IsIn(TEMPLATE_PURPOSES)
  purpose!: WhatsAppTemplatePurpose;

  /** Nama salinan; default `"<nama sumber> (salinan)"`. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  /** Status aktif salinan; default mengikuti template sumber. */
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Konteks/metode/tujuan adalah identitas template dan tidak dapat diubah. */
export class UpdateWhatsAppTemplateDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class PreviewWhatsAppTemplateDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body!: string;

  /** Nilai override untuk placeholder; nilai yang tidak diisi memakai contoh. */
  @IsOptional()
  @IsObject()
  values?: Record<string, string>;
}
