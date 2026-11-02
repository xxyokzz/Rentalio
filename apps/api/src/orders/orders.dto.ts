import { Type } from 'class-transformer';
import type { PaymentContext } from '@rentalio/database';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
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
} from 'class-validator';

/**
 * DTO modul Order, pembayaran manual, dan ledger deposit.
 * Acuan: ADR-001 §3–§4 + Notion 04 (kontrak command order/payment/deposit).
 *
 * Uang selalu integer rupiah utuh sebagai string (BigInt tidak aman di JSON
 * number); server memvalidasi ulang nominal, saldo, dan transisi status.
 */
const AMOUNT_PATTERN = /^[1-9][0-9]{0,15}$/;
const CURRENCY = ['IDR'] as const;
const PAYMENT_METHODS = ['CASH', 'BANK_TRANSFER', 'QRIS'] as const;
const PAYMENT_CONTEXTS = ['NEW_BOOKING', 'ADD_UNIT', 'EXTENSION'] as const;
const COLLATERAL_TYPES = ['ID_CARD', 'OTHER'] as const;
const ORDER_STATUSES = [
  'CONFIRMED',
  'READY_FOR_HANDOVER',
  'ACTIVE',
  'RETURN_IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
] as const;

/** POST /orders — MVP: konversi reservasi CONFIRMED (tanpa order langsung). */
export class CreateOrderDto {
  @IsUUID()
  reservationId!: string;
}

export class ReadyForHandoverDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class HandoverDto {
  /** Waktu serah-terima aktual; default server time bila tidak diisi. */
  @IsOptional()
  @IsISO8601()
  handoverAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  conditionNotes?: string;

  /** Referensi bukti (foto/berita acara) — disimpan pada audit, bukan file. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  evidenceRefs?: string[];
}

export class CompleteOrderDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  settlementNote?: string;
}

export class RecordPaymentDto {
  @Matches(AMOUNT_PATTERN, { message: 'amount harus integer rupiah utuh > 0 sebagai string' })
  amount!: string;

  @IsIn(CURRENCY)
  currency!: 'IDR';

  @IsIn(PAYMENT_METHODS)
  method!: (typeof PAYMENT_METHODS)[number];

  /** Konteks transaksi; default NEW_BOOKING untuk kompatibilitas klien lama. */
  @IsOptional()
  @IsIn(PAYMENT_CONTEXTS)
  context?: PaymentContext;

  @IsOptional()
  @IsISO8601()
  receivedAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reference?: string;
}

export class VoidPaymentDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

/**
 * Pengajuan refund pembayaran sewa (terpisah dari payment dan deposit).
 * Batas refundable dihitung server dari payment yang direferensikan.
 */
export class RequestRefundDto {
  @IsUUID()
  paymentId!: string;

  @Matches(AMOUNT_PATTERN, { message: 'amount harus integer rupiah utuh > 0 sebagai string' })
  amount!: string;

  @IsIn(CURRENCY)
  currency!: 'IDR';

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reference?: string;
}

export class RefundDecisionDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** MVP offline: hasil proses dicatat staf, bukan status gateway. */
export class RefundResultDto {
  @IsIn(['SUCCEEDED', 'FAILED'])
  status!: 'SUCCEEDED' | 'FAILED';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class DepositReceiptDto {
  @Matches(AMOUNT_PATTERN, { message: 'amount harus integer rupiah utuh > 0 sebagai string' })
  amount!: string;

  @IsIn(CURRENCY)
  currency!: 'IDR';

  @IsOptional()
  @IsIn(PAYMENT_METHODS)
  method?: (typeof PAYMENT_METHODS)[number];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class DepositDeductionDto {
  @Matches(AMOUNT_PATTERN, { message: 'amount harus integer rupiah utuh > 0 sebagai string' })
  amount!: string;

  @IsIn(CURRENCY)
  currency!: 'IDR';

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  conditionNotes?: string;
}

export class DepositDecisionDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class DepositRefundDto {
  @Matches(AMOUNT_PATTERN, { message: 'amount harus integer rupiah utuh > 0 sebagai string' })
  amount!: string;

  @IsIn(CURRENCY)
  currency!: 'IDR';

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reference?: string;
}

export class ReverseDepositMovementDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

/**
 * Jaminan non-uang pada order. Jaminan uang tetap memakai ledger deposit;
 * model ini hanya ID_CARD (jaminan utama) dan OTHER (opsional). `label` untuk
 * OTHER wajib diisi (nama barang/dokumen); untuk ID_CARD server memberi default
 * "KTP" bila kosong.
 */
export class CreateCollateralDto {
  @IsIn(COLLATERAL_TYPES)
  type!: (typeof COLLATERAL_TYPES)[number];

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  label?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  documentNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

/** Pengembalian jaminan: HELD → RETURNED (baris tetap ada sebagai riwayat). */
export class ReturnCollateralDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class ListOrdersQueryDto {
  @IsOptional()
  @IsIn(ORDER_STATUSES)
  status?: (typeof ORDER_STATUSES)[number];

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
