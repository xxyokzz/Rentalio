import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  IsPositive,
} from 'class-validator';

/**
 * DTO Catalog & Inventory.
 * Kontrak Notion 04 — kelompok "Inventaris dan ketersediaan".
 */

// ============================================================
// Category
// ============================================================

export class CreateCategoryDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;
}

export class UpdateCategoryDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;
}

// ============================================================
// Product
// ============================================================

/** Mode stok produk: QUANTITY (jumlah) atau INDIVIDUAL_UNITS (unit fisik). */
export enum StockModeDto {
  QUANTITY = 'QUANTITY',
  INDIVIDUAL_UNITS = 'INDIVIDUAL_UNITS',
}

export class CreateProductDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  /** ID kategori (opsional, tenant-scoped). */
  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @IsEnum(StockModeDto)
  stockMode?: StockModeDto;

  /**
   * Kapasitas stok untuk mode QUANTITY.
   * Untuk INDIVIDUAL_UNITS kapasitas = jumlah asset AVAILABLE.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  capacity?: number;

  /** Apakah produk aktif di katalog publik. */
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateProductDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  capacity?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

// ============================================================
// Rate (harga sewa)
// ============================================================

export class UpsertRateDto {
  /**
   * Harga per hari dalam IDR (integer rupiah utuh, bukan float — Notion 03).
   * Disimpan sebagai BigInt di database.
   */
  @IsInt()
  @IsPositive()
  perDayAmount!: number;

  /** Harga per minggu (opsional). */
  @IsOptional()
  @IsInt()
  @IsPositive()
  perWeekAmount?: number;

  /** Harga per bulan (opsional). */
  @IsOptional()
  @IsInt()
  @IsPositive()
  perMonthAmount?: number;
}

// ============================================================
// Asset (unit fisik individual)
// ============================================================

/** Status unit fisik. */
export enum AssetStatusDto {
  AVAILABLE = 'AVAILABLE',
  RESERVED = 'RESERVED',
  MAINTENANCE = 'MAINTENANCE',
  DAMAGED = 'DAMAGED',
  RETIRED = 'RETIRED',
}

export class CreateAssetDto {
  /**
   * Kode unit fisik — unik per tenant (mis: nomor seri, label stiker).
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  code!: string;

  @IsOptional()
  @IsEnum(AssetStatusDto)
  status?: AssetStatusDto;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  conditionNote?: string;
}

export class UpdateAssetDto {
  @IsOptional()
  @IsEnum(AssetStatusDto)
  status?: AssetStatusDto;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  conditionNote?: string;
}

// ============================================================
// Asset Maintenance (periode tidak tersedia)
// ============================================================

export class CreateMaintenanceDto {
  /** Mulai periode tidak tersedia (ISO 8601 UTC). */
  @IsString()
  @IsNotEmpty()
  startAt!: string;

  /** Akhir periode tidak tersedia (ISO 8601 UTC). */
  @IsString()
  @IsNotEmpty()
  endAt!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
