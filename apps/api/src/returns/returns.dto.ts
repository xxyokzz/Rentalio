import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * DTO modul Return & Inspection.
 * Acuan: ADR-001 §5 + kontrak docs/openapi.yaml.
 * Semua nilai uang adalah integer IDR rupiah utuh (bukan float).
 */

// ============================================================
// Return
// ============================================================

export class ReturnItemDto {
  @IsUUID()
  productId!: string;

  /** Unit fisik — wajib untuk produk INDIVIDUAL_UNITS, quantity harus 1. */
  @IsOptional()
  @IsUUID()
  assetId?: string;

  @IsInt()
  @Min(1)
  quantity!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  conditionNote?: string;
}

export class CreateReturnDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReturnItemDto)
  items!: ReturnItemDto[];
}

export class CompleteReturnDto {
  /** Waktu aktual barang diterima; default waktu server bila tidak diisi. */
  @IsOptional()
  @IsISO8601()
  receivedAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class CancelReturnDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

// ============================================================
// Inspection
// ============================================================

export class CreateInspectionDto {
  /** Inspeksi dapat dikaitkan ke return record pada order yang sama. */
  @IsOptional()
  @IsUUID()
  returnRecordId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  summary?: string;
}

export class SubmitInspectionDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  summary?: string;

  /** Usulan denda (IDR rupiah utuh). */
  @IsOptional()
  @IsInt()
  @Min(0)
  penaltyAmount?: number;
}

export enum InspectionDecisionDto {
  APPROVE = 'APPROVE',
  REJECT = 'REJECT',
}

export class DecideInspectionDto {
  @IsEnum(InspectionDecisionDto)
  decision!: InspectionDecisionDto;

  /** Denda final; hanya disimpan untuk keputusan APPROVE. */
  @IsOptional()
  @IsInt()
  @Min(0)
  penaltyAmount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  summary?: string;
}
