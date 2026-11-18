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
  IsInt,
  IsUUID,
  IsUrl,
  Min,
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

/** Satuan denda keterlambatan yang dapat dipilih owner. */
export enum LateFeeUnitDto {
  DAY = 'DAY',
  HOUR = 'HOUR',
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

  /** Saklar denda keterlambatan pengembalian. */
  @IsOptional()
  @IsBoolean()
  lateFeeEnabled?: boolean;

  /** Satuan perhitungan denda: per hari atau per jam. */
  @IsOptional()
  @IsEnum(LateFeeUnitDto, { message: 'Satuan denda harus DAY atau HOUR.' })
  lateFeeUnit?: LateFeeUnitDto;

  /** Tarif denda per satuan, IDR rupiah utuh (bukan desimal). */
  @IsOptional()
  @IsInt()
  @Min(0)
  lateFeeRateAmount?: number;

  /** Saklar alur inspeksi kerusakan pasca-return (dokumen 15). */
  @IsOptional()
  @IsBoolean()
  damageInspectionEnabled?: boolean;

  /** Saklar usulan denda kondisi barang. */
  @IsOptional()
  @IsBoolean()
  damageFeeEnabled?: boolean;

  /** Nominal denda untuk kondisi ringan, IDR rupiah utuh. */
  @IsOptional()
  @IsInt()
  @Min(0)
  damageFeeMinorAmount?: number;

  /** Nominal denda untuk kondisi sedang, IDR rupiah utuh. */
  @IsOptional()
  @IsInt()
  @Min(0)
  damageFeeModerateAmount?: number;

  /** Nominal denda untuk kondisi parah, IDR rupiah utuh. */
  @IsOptional()
  @IsInt()
  @Min(0)
  damageFeeSevereAmount?: number;

  /** Plafon usulan denda kondisi per inspeksi; `null` menghapus plafon. */
  @IsOptional()
  @IsInt()
  @Min(1)
  damageFeeMaxAmount?: number | null;

  /** Batas akumulasi denda aktif per order; `null` menghapus batas. */
  @IsOptional()
  @IsInt()
  @Min(1)
  damagePenaltyOrderMaxAmount?: number | null;
}

/** Nominal denda kondisi khusus satu kategori produk. */
export class UpsertDamageFeeCategoryDto {
  @IsUUID()
  categoryId!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  minorAmount?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  moderateAmount?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  severeAmount?: number;
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
