import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * DTO modul Reservasi & Ketersediaan.
 * Acuan: ADR-001 §1 (lifecycle reservation) + Notion 04 (kelompok endpoint
 * "Booking, POS, dan sewa" dan "Inventaris dan ketersediaan").
 * Periode memakai ISO 8601; uang dihitung server dari Rate (bukan dari client).
 */

/** Item reservasi: produk + kuantitas untuk periode reservasi induk. */
export class CreateReservationItemDto {
  @IsUUID()
  productId!: string;

  /** Kuantitas yang diminta (> 0; batas atas diverifikasi server terhadap kapasitas). */
  @IsInt()
  @Min(1)
  quantity!: number;
}

export class CreateReservationDto {
  /** Mulai periode sewa (ISO 8601). */
  @IsISO8601()
  startAt!: string;

  /** Akhir periode sewa (ISO 8601, half-open: endAt eksklusif). */
  @IsISO8601()
  endAt!: string;

  /** Pelanggan opsional — harus berada dalam tenant yang sama. */
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CreateReservationItemDto)
  items!: CreateReservationItemDto[];
}

/** Konfirmasi: catatan opsional (dicatat ke audit). */
export class ConfirmReservationDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** Pembatalan: alasan opsional (dicatat ke audit). */
export class CancelReservationDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** Penolakan: alasan opsional (dicatat ke audit). */
export class RejectReservationDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** Query GET /tenants/:tenantId/availability — cek ketersediaan satu produk. */
export class AvailabilityQueryDto {
  @IsUUID()
  productId!: string;

  @IsISO8601()
  startAt!: string;

  @IsISO8601()
  endAt!: string;
}
