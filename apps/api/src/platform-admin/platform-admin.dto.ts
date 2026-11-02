import { Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PLATFORM_AUDIT_ACTIONS } from './platform-admin.audit.js';

/**
 * DTO Admin Platform. Semua properti berbentuk class agar ValidationPipe
 * (whitelist + forbidNonWhitelisted) benar-benar aktif: properti tak dikenal
 * atau field wajib yang hilang dijawab 400, bukan 500.
 */

export class PlatformAdminLoginDto {
  @IsEmail()
  email!: string;

  /** Password tidak diberi batas minimum di login agar tidak membocorkan info. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  password!: string;
}

export class PlatformAdminMfaDto {
  /** Token challenge dari langkah password (sekali pakai, 5 menit). */
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  challengeToken!: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'Kode MFA harus 6 digit.' })
  code!: string;
}

export class PlatformAdminRecoveryDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  challengeToken!: string;

  /** Kode pemulihan sekali pakai (format XXXXXXXXXX-XXXXXXXXXX). */
  @IsString()
  @Length(21, 21, { message: 'Kode pemulihan tidak valid.' })
  @Matches(/^[A-Fa-f0-9]{10}-[A-Fa-f0-9]{10}$/, { message: 'Kode pemulihan tidak valid.' })
  recoveryCode!: string;
}

/** Status tenant yang boleh difilter (sumber: enum TenantStatus di schema). */
export const PLATFORM_TENANT_STATUSES = [
  'PENDING_ACTIVATION',
  'ACTIVE',
  'SUSPENDED',
  'CLOSED',
] as const;

export class PlatformTenantDirectoryQueryDto {
  @IsOptional()
  @IsIn(PLATFORM_TENANT_STATUSES)
  status?: (typeof PLATFORM_TENANT_STATUSES)[number];

  /** Pencarian nama atau slug tenant (case-insensitive). */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;
}

/** Filter direktori Admin Platform: pencarian email + paginasi. */
export class PlatformAdminDirectoryQueryDto {
  /** Pencarian email admin (case-insensitive). */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;
}

/** Filter audit viewer: aktor, aksi, dan rentang waktu (semua opsional). */
export class PlatformAuditQueryDto {
  @IsOptional()
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, {
    message: 'actorAdminId harus UUID.',
  })
  actorAdminId?: string;

  @IsOptional()
  @IsIn(PLATFORM_AUDIT_ACTIONS)
  action?: (typeof PLATFORM_AUDIT_ACTIONS)[number];

  /** Batas bawah waktu (inklusif), ISO 8601. */
  @IsOptional()
  @IsISO8601()
  from?: string;

  /** Batas atas waktu (inklusif), ISO 8601. */
  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;
}

/** Alasan wajib untuk aksi status tenant — tercatat di audit, bukan hanya UI. */
export class PlatformTenantStatusChangeDto {
  @IsString()
  @MinLength(10, { message: 'Alasan minimal 10 karakter.' })
  @MaxLength(500)
  reason!: string;
}

/**
 * Penugasan/pencabutan role Admin Platform. `roleCode` adalah kode di tabel
 * `platform_roles` (bukan id) dan `reason` wajib — sama seperti aksi status
 * tenant, alasan disimpan pada audit, bukan hanya divalidasi di UI.
 */
export class PlatformRoleAssignmentDto {
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  @Matches(/^[A-Z][A-Z0-9_]*$/, {
    message: 'Kode role hanya huruf kapital, angka, dan underscore.',
  })
  roleCode!: string;

  @IsString()
  @MinLength(10, { message: 'Alasan minimal 10 karakter.' })
  @MaxLength(500)
  reason!: string;
}

/**
 * Penyelesaian tagihan langganan QRIS dari Admin Platform.
 *
 * QRIS dinamis tidak punya callback pembayaran, jadi operator menandai tagihan
 * lunas secara manual setelah memverifikasi dana masuk. `reason` wajib diisi
 * (mis. id mutasi bank) agar tindakan ini selalu punya jejak audit.
 */
export class PlatformSubscriptionInvoiceSettleDto {
  /** Nominal yang diterima (IDR utuh). Bila kosong, dipakai nilai tagihan. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  paidAmount?: number;

  /** Metode/channel pembayaran yang tercatat, mis. `QRIS` atau `BCA`. */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  channel?: string;

  /** Referensi pembayaran (id mutasi/berita transfer) — wajib, masuk audit. */
  @IsString()
  @MinLength(10, { message: 'Alasan minimal 10 karakter.' })
  @MaxLength(500)
  reason!: string;
}

export class PlatformAdminBootstrapDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(128)
  password!: string;
}
