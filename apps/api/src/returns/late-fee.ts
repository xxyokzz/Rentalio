/**
 * Denda keterlambatan pengembalian.
 *
 * Aturan (disepakati dengan owner lewat pengaturan tenant):
 * - Nominal per satuan diatur owner; satuan bisa hari atau jam.
 * - Saklar mati berarti denda selalu nol, tanpa menghapus konfigurasi.
 * - Keterlambatan dihitung dari selisih `returnedAt` terhadap `endAt` order.
 * - Pembulatan ke atas: telat 1 menit pada satuan jam tetap dihitung 1 jam,
 *   supaya tidak ada keterlambatan yang lolos tanpa denda.
 * - Denda bukan tagihan order: nilainya menjadi usulan pada inspeksi dan tetap
 *   harus diputuskan petugas berizin.
 */

export type LateFeeUnit = 'DAY' | 'HOUR';

export const LATE_FEE_UNIT_MS: Record<LateFeeUnit, number> = {
  DAY: 24 * 60 * 60 * 1000,
  HOUR: 60 * 60 * 1000,
};

export interface LateFeePolicy {
  enabled: boolean;
  unit: LateFeeUnit;
  /** Tarif per satuan dalam IDR rupiah utuh. */
  rateAmount: bigint;
}

export interface LateFeeView {
  enabled: boolean;
  unit: LateFeeUnit;
  rateAmount: string;
  dueAt: string | null;
  returnedAt: string | null;
  overdueMs: number;
  units: number;
  amount: string;
}

export function computeLateFee(
  policy: LateFeePolicy,
  dueAt: Date | null,
  returnedAt: Date | null,
): LateFeeView {
  const base: LateFeeView = {
    enabled: policy.enabled,
    unit: policy.unit,
    rateAmount: policy.rateAmount.toString(),
    dueAt: dueAt ? dueAt.toISOString() : null,
    returnedAt: returnedAt ? returnedAt.toISOString() : null,
    overdueMs: 0,
    units: 0,
    amount: '0',
  };

  // Denda belum bisa dihitung sebelum barang benar-benar diterima.
  if (!policy.enabled || !dueAt || !returnedAt || policy.rateAmount <= 0n) return base;

  const overdueMs = returnedAt.getTime() - dueAt.getTime();
  if (!Number.isFinite(overdueMs) || overdueMs <= 0) return base;

  const units = Math.ceil(overdueMs / LATE_FEE_UNIT_MS[policy.unit]);
  return {
    ...base,
    overdueMs,
    units,
    amount: (BigInt(units) * policy.rateAmount).toString(),
  };
}
