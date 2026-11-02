import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  Equals,
  IsArray,
  IsBoolean,
  IsEmail,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/**
 * DTO alur penyewa publik (Notion 14):
 * - katalog publik tanpa akun;
 * - booking tamu dengan persetujuan ketentuan sewa;
 * - portal pesanan berbasis token acak.
 *
 * Harga, ketersediaan, dan status selalu dihitung server. Client tidak pernah
 * mengirim nominal atau tenantId.
 */

export class PublicHostQueryDto {
  /** Hostname publik dari header Host (tanpa skema dan path). */
  @IsString()
  @MaxLength(253)
  host!: string;
}

export class PublicAvailabilityQueryDto {
  @IsUUID()
  productId!: string;

  @IsISO8601()
  startAt!: string;

  @IsISO8601()
  endAt!: string;
}

export class PublicBookingItemDto {
  @IsUUID()
  productId!: string;

  @IsInt()
  @Min(1)
  @Max(1000)
  quantity!: number;
}

export class PublicGuestDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  /** Minimal salah satu dari phone/email wajib diisi (divalidasi service). */
  @IsOptional()
  @IsString()
  @Matches(/^[+0-9][0-9\s().-]{6,24}$/, {
    message: 'Nomor kontak tidak valid.',
  })
  phone?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;
}

export class PublicBookingTermsDto {
  @IsBoolean()
  @Equals(true, { message: 'Ketentuan sewa harus disetujui.' })
  accepted!: boolean;

  @IsString()
  @MinLength(1)
  @MaxLength(40)
  version!: string;
}

/**
 * Pengajuan perpanjangan dari portal tamu. Hanya tanggal akhir baru dan
 * catatan; biaya, periode sebelumnya, dan konflik selalu dihitung server.
 */
export class PortalExtensionRequestDto {
  @IsISO8601()
  requestedEndAt!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class CreatePublicBookingDto {
  @IsISO8601()
  startAt!: string;

  @IsISO8601()
  endAt!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => PublicBookingItemDto)
  items!: PublicBookingItemDto[];

  @ValidateNested()
  @Type(() => PublicGuestDto)
  guest!: PublicGuestDto;

  @ValidateNested()
  @Type(() => PublicBookingTermsDto)
  terms!: PublicBookingTermsDto;
}
