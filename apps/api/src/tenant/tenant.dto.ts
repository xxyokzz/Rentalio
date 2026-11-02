import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  IsArray,
  IsEmail,
  IsUrl,
  ValidateIf,
} from 'class-validator';

/**
 * DTO Tenant.
 * Kontrak ADR-001 §8 dan Notion 04 — kelompok endpoint Auth & Tenant.
 */

/** Slug tenant: huruf kecil, angka, dan tanda hubung. */
const SLUG_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export class CreateTenantDto {
  /** Nama bisnis (human-readable). */
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  /**
   * Slug unik tenant, dipakai sebagai subdomain / identifier publik.
   * Format: lowercase, alphanumeric, tanda hubung; min 3, maks 63 karakter.
   */
  @IsString()
  @MinLength(3)
  @MaxLength(63)
  @Matches(SLUG_REGEX, { message: 'Slug hanya boleh huruf kecil, angka, dan tanda hubung.' })
  slug!: string;

  /** Zona waktu IANA default untuk tampilan dan aturan lokal. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;
}

export class UpdateTenantSettingsDto {
  /** Mode booking: MANUAL (perlu approval) atau AUTOMATIC (langsung konfirmasi jika stok tersedia). */
  @IsOptional()
  @IsEnum(['MANUAL', 'AUTOMATIC'])
  bookingMode?: 'MANUAL' | 'AUTOMATIC';

  /**
   * Kebijakan katalog saat stok kosong.
   * CHECK_AVAILABILITY (Opsi A) atau SKIP_AVAILABILITY (Opsi B).
   */
  @IsOptional()
  @IsEnum(['CHECK_AVAILABILITY', 'SKIP_AVAILABILITY'])
  catalogPolicy?: 'CHECK_AVAILABILITY' | 'SKIP_AVAILABILITY';

  /** Toggle fitur perpanjangan sewa oleh penyewa. */
  @IsOptional()
  @IsBoolean()
  rentalExtensionEnabled?: boolean;

  /**
   * Nomor WhatsApp bisnis untuk click-to-chat.
   * String kosong berarti menghapus nilai (bukan nomor tidak valid).
   */
  @IsOptional()
  @ValidateIf((_, value) => value !== '')
  @IsString()
  @MaxLength(24)
  @Matches(/^[+0-9][0-9\s().-]{6,23}$/, {
    message: 'Nomor WhatsApp tidak valid.',
  })
  whatsappNumber?: string;

  /** Instruksi transfer bank tenant; jangan mengarang nomor rekening. */
  @IsOptional()
  @ValidateIf((_, value) => value !== '')
  @IsString()
  @MaxLength(1000)
  bankTransferInstructions?: string;

  /** URL gambar QRIS tenant yang sudah dipublikasikan. */
  @IsOptional()
  @ValidateIf((_, value) => value !== '')
  @IsUrl({ require_protocol: true })
  @MaxLength(2000)
  qrisImageUrl?: string;
}

/** Enum role keanggotaan. */
export enum MembershipRoleDto {
  MANAGER = 'MANAGER',
  STAFF = 'STAFF',
  CASHIER = 'CASHIER',
}

export class InviteMemberDto {
  /** Email karyawan yang diundang (dinormalisasi di backend). */
  @IsEmail()
  email!: string;

  /** Role yang diberikan. OWNER tidak boleh diundang; transfer ownership lewat alur terpisah. */
  @IsEnum(MembershipRoleDto, {
    message: 'Role harus MANAGER, STAFF, atau CASHIER.',
  })
  role!: MembershipRoleDto;

  /** Daftar permission key tambahan di luar preset role. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  permissions?: string[];
}

export class UpdateMemberDto {
  /** Ubah role keanggotaan. Hanya OWNER yang boleh mengubah. */
  @IsOptional()
  @IsEnum(MembershipRoleDto, {
    message: 'Role harus MANAGER, STAFF, atau CASHIER.',
  })
  role?: MembershipRoleDto;

  /** Override permission key spesifik untuk member ini. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  permissions?: string[];

  /** Status keanggotaan: ACTIVE atau REVOKED. */
  @IsOptional()
  @IsEnum(['ACTIVE', 'REVOKED'])
  status?: 'ACTIVE' | 'REVOKED';
}
