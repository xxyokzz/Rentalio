import { IsArray, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Isi konfigurasi divalidasi oleh allowlist `validateCatalogConfig`
 * (komponen + properti), bukan oleh class-validator, supaya pesan error bisa
 * menyebut path properti yang tepat (`blocks[2].config.spacing`). Karena itu
 * field di sini hanya memastikan bentuk kasarnya: theme/branding objek,
 * blocks array.
 */
export class SaveCatalogConfigDto {
  @IsOptional()
  @IsObject()
  theme?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  branding?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  blocks?: Array<Record<string, unknown>>;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  templateKey?: string;
}

/** Validasi tanpa menyimpan — dipakai editor untuk "cek sebelum publish". */
export class ValidateCatalogConfigDto extends SaveCatalogConfigDto {}
