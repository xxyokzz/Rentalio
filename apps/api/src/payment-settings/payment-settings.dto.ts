import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  ValidateNested,
} from 'class-validator';
import type { PaymentContext, PaymentMethod } from '@rentalio/database';

/** Konteks transaksi yang memiliki matriks metode pembayaran sendiri. */
export const PAYMENT_CONTEXTS = ['NEW_BOOKING', 'ADD_UNIT', 'EXTENSION'] as const;
export const PAYMENT_METHOD_VALUES = ['CASH', 'BANK_TRANSFER', 'QRIS'] as const;

export class PaymentMethodSettingDto {
  @IsIn(PAYMENT_CONTEXTS)
  context!: PaymentContext;

  @IsIn(PAYMENT_METHOD_VALUES)
  method!: PaymentMethod;

  @IsBoolean()
  enabled!: boolean;
}

/**
 * PUT matriks pembayaran. Boleh parsial: entri yang tidak dikirim tetap
 * memakai nilai efektif saat ini (default aktif bila belum pernah disimpan).
 * Duplikat konteks+metode ditolak service, bukan diam-diam ditimpa.
 */
export class UpdatePaymentMethodsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(9)
  @ValidateNested({ each: true })
  @Type(() => PaymentMethodSettingDto)
  settings!: PaymentMethodSettingDto[];
}
