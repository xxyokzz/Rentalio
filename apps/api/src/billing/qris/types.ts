/**
 * Tipe payload QRIS/EMVCo.
 *
 * Port dari `verssache/qris-dinamis` (`src/core/types.ts`, MIT).
 * https://github.com/verssache/qris-dinamis
 */

/** Satu elemen TLV (Tag-Length-Value) dari payload QRIS. */
export interface TLV {
  tag: string;
  name: string;
  length: number;
  value: string;
  children?: TLV[];
}

export interface MerchantAccountInfo {
  tag: string;
  globallyUniqueId: string;
  merchantId?: string;
  merchantCriteria?: string;
  fields: TLV[];
}

/** QRIS yang sudah diurai menjadi struktur yang mudah dibaca. */
export interface QRISData {
  version: string;
  method: 'static' | 'dynamic';
  merchantAccountInfo: MerchantAccountInfo[];
  merchantCategoryCode: string;
  currency: string;
  amount?: string;
  tipIndicator?: 'prompt' | 'fixed' | 'percentage';
  tipFixed?: string;
  tipPercentage?: string;
  countryCode: string;
  merchantName: string;
  merchantCity: string;
  postalCode: string;
  additionalData?: TLV[];
  crc: string;
  raw: TLV[];
}

export interface ConvertOptions {
  amount: number;
  fee?: {
    type: 'fixed' | 'percentage';
    value: number;
  };
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}
