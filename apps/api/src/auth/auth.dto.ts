import {
  Equals,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * DTO autentikasi.
 *
 * ValidationPipe NestJS hanya memvalidasi parameter yang metatype-nya sebuah
 * class. Bila `@Body()` bertipe literal object `{ email: string }`, metatype di
 * runtime adalah `Object` dan pipe melewatkannya — sehingga `whitelist` /
 * `forbidNonWhitelisted` tidak memberi efek apa pun dan input malformed jatuh
 * ke 500. Class di bawah membuat validasi benar-benar aktif:
 * properti tak dikenal → 400, field wajib hilang → 400, bukan 500.
 */

/** Password: kontrak 12-128 karakter, tanpa pola campuran wajib, tanpa trim. */
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 128;

/**
 * Identitas versi dokumen legal: token singkat seperti `2026-10-14` atau
 * `v1.2`. Tanpa spasi/ kutip sehingga aman disimpan di kolom teks, dicatat di
 * audit, dan dirender ulang di UI.
 */
const LEGAL_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;

/**
 * Slug tenant: huruf kecil, angka, dan tanda hubung — sengaja identik dengan
 * `CreateTenantDto` (tenant.dto.ts) agar nilai yang dikirim saat registrasi
 * diterima kembali oleh `POST /tenants` tanpa kejutan format.
 */
const SLUG_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export class RegisterDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(PASSWORD_MIN)
  @MaxLength(PASSWORD_MAX)
  password!: string;

  /** Nama pemilik akun (opsional, diisi saat registrasi OWNER; prefill onboarding) */
  @IsString()
  @IsOptional()
  @IsNotEmpty()
  @MaxLength(120)
  ownerName?: string;

  /** Nama tenant (opsional; dipakai sebagai prefill nama toko di onboarding) */
  @IsString()
  @IsOptional()
  @IsNotEmpty()
  @MaxLength(100)
  tenantName?: string;

  /**
   * Slug tenant (opsional; prefill link katalog di onboarding). Hanya format
   * yang divalidasi di sini — keunikan tetap ditegakkan `POST /tenants`
   * (unique `tenants.slug`), jadi slug yang keburu dipakai tenant lain hanya
   * ditolak 409 saat onboarding, bukan saat mendaftar.
   */
  @IsString()
  @IsOptional()
  @MinLength(3)
  @MaxLength(63)
  @Matches(SLUG_REGEX, {
    message: 'Slug hanya boleh huruf kecil, angka, dan tanda hubung.',
  })
  tenantSlug?: string;

  /**
   * Persetujuan dokumen legal (dokumen 04 — "Kontrak pendaftaran OWNER").
   * Wajib `true`: backend menyimpan bukti versi dokumen + waktu penerimaan
   * di server, bukan sekadar status checkbox di UI.
   */
  @Equals(true, {
    message: 'Anda harus menyetujui Syarat Layanan dan Kebijakan Privasi.',
  })
  termsAccepted!: boolean;

  /** Identitas versi Syarat Layanan yang disetujui (dikirim klien, disimpan apa adanya). */
  @IsString()
  @Matches(LEGAL_VERSION_PATTERN, { message: 'Versi Syarat Layanan tidak valid.' })
  termsVersion!: string;

  /** Identitas versi Kebijakan Privasi yang disetujui. */
  @IsString()
  @Matches(LEGAL_VERSION_PATTERN, { message: 'Versi Kebijakan Privasi tidak valid.' })
  privacyVersion!: string;
}

export class VerifyEmailDto {
  @IsEmail()
  email!: string;

  /** Kode OTP tepat 6 digit. */
  @IsString()
  @Matches(/^\d{6}$/, { message: 'Kode harus 6 digit.' })
  code!: string;
}

export class ResendOtpDto {
  @IsEmail()
  email!: string;
}

export class LoginDto {
  @IsEmail()
  email!: string;

  // Login tidak menerapkan panjang minimum: kecocokan diserahkan ke verifikasi
  // password (respons tetap INVALID_CREDENTIALS agar tidak membocorkan info).
  @IsString()
  @IsNotEmpty()
  password!: string;
}

export class RequestPasswordResetDto {
  @IsEmail()
  email!: string;
}

export class AcceptInvitationDto {
  /** Token undangan mentah dari tautan email (sekali pakai). */
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  token!: string;

  /** Wajib bila email belum punya akun; tidak pernah mengubah password akun yang sudah ada. */
  @IsOptional()
  @IsString()
  @MinLength(PASSWORD_MIN)
  @MaxLength(PASSWORD_MAX)
  password?: string;
}

export class CompletePasswordResetDto {
  @IsString()
  @IsNotEmpty()
  token!: string;

  @IsString()
  @MinLength(PASSWORD_MIN)
  @MaxLength(PASSWORD_MAX)
  newPassword!: string;
}
