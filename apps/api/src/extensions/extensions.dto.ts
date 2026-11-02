import {
  IsBoolean,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * DTO perpanjangan sewa — ADR-001 §8 + Notion 04.
 *
 * Client hanya mengirim tanggal akhir baru; periode sebelumnya, biaya, dan
 * daftar konflik dihitung server. Override konflik Opsi B memerlukan alasan
 * dan konfirmasi risiko eksplisit pada command terpisah.
 */
export class RequestExtensionDto {
  /** Tanggal akhir baru; harus setelah akhir sewa saat ini. */
  @IsISO8601()
  requestedEndAt!: string;

  /** Catatan permintaan (opsional, disimpan di audit). */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ApproveExtensionDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class RejectExtensionDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

/**
 * Command override konflik Opsi B. `riskConfirmed` harus true; nilai false
 * sengaja sampai ke service agar ditolak 422 (bukan 400 validasi skema).
 */
export class OverrideExtensionConflictDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;

  @IsBoolean()
  riskConfirmed!: boolean;
}

/**
 * Command menandai tugas konflik selesai. Catatan wajib agar alasan
 * penyelesaian (mis. unit pengganti sudah disiapkan) tercatat di audit.
 * Flag `hasOpenConflict` dihitung ulang server, bukan dikirim client.
 */
export class ResolveExtensionConflictDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  resolutionNote!: string;
}

/**
 * Filter antrean permintaan perpanjangan lintas order. Default hanya
 * `PENDING_APPROVAL` agar halaman staf menampilkan yang menunggu keputusan;
 * `ALL` dipakai untuk riwayat singkat di daftar yang sama.
 */
export class ExtensionQueueQueryDto {
  @IsOptional()
  @IsIn(['PENDING_APPROVAL', 'ALL'])
  status?: 'PENDING_APPROVAL' | 'ALL';
}

/** Filter status untuk ringkasan konflik operasional. */
export class ConflictOverviewQueryDto {
  @IsOptional()
  @IsIn(['OPEN', 'RESOLVED', 'ALL'])
  status?: 'OPEN' | 'RESOLVED' | 'ALL';
}
