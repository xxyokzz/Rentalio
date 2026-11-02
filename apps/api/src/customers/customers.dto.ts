import { Type } from 'class-transformer';
import {
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * DTO pelanggan (Notion 04 — kelompok "Kontak & pelanggan").
 *
 * Pelanggan selalu tenant-scoped; tenantId berasal dari path + membership,
 * tidak pernah dari body. Email dinormalisasi lowercase dan kontak memakai
 * pola yang sama dengan booking tamu agar data mudah dicocokkan.
 */

export class CreateCustomerDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[+0-9][0-9\s().-]{6,24}$/, {
    message: 'Nomor kontak tidak valid.',
  })
  phone?: string;
}

export class ListCustomersQueryDto {
  /** Pencarian nama/email/nomor (case-insensitive, maksimal 120 karakter). */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
