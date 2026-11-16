import { IsISO8601, IsOptional } from 'class-validator';

/** Filter rentang tanggal laporan; keduanya opsional. */
export class DamageFeeReportQueryDto {
  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;
}
