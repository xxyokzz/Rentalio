/**
 * Denda kerusakan barang (dokumen 15).
 *
 * Aturan (disepakati dengan owner lewat pengaturan tenant):
 * - Nominal diatur owner per tingkat kondisi: ringan, sedang, parah.
 * - Saklar mati berarti usulan selalu kosong, tanpa menghapus nominal tersimpan.
 * - Saklar inspeksi mati menutup alur inspeksi seluruhnya (ditegakkan service).
 * - Konfigurasi disalin ke snapshot saat inspeksi dibuat, jadi perubahan
 *   nominal setelahnya tidak menulis ulang usulan inspeksi yang berjalan.
 * - Nominal adalah IDR rupiah utuh dan hanya berupa USULAN; keputusan final
 *   tetap `penaltyAmount` milik petugas berizin.
 */

export type DamageSeverity = 'MINOR' | 'MODERATE' | 'SEVERE';

export const DAMAGE_SEVERITIES: readonly DamageSeverity[] = [
  'MINOR',
  'MODERATE',
  'SEVERE',
] as const;

/** Label bahasa Indonesia untuk UI dan pesan audit. */
export const DAMAGE_SEVERITY_LABEL: Record<DamageSeverity, string> = {
  MINOR: 'Ringan',
  MODERATE: 'Sedang',
  SEVERE: 'Parah',
};

export type DamageAmounts = Record<DamageSeverity, bigint>;

export interface DamageFeePolicy {
  enabled: boolean;
  /** Nominal per tingkat kondisi dalam IDR rupiah utuh. */
  amounts: DamageAmounts;
}

/** Bentuk JSON yang disimpan pada `inspections.damagePolicySnapshot`. */
export interface DamagePolicySnapshot {
  enabled: boolean;
  amounts: Record<DamageSeverity, string>;
}

export interface DamageFeeView {
  enabled: boolean;
  severity: DamageSeverity | null;
  label: string | null;
  /** Usulan denda; null bila saklar mati, tingkat kondisi kosong, atau nominal nol. */
  amount: string | null;
  amounts: Record<DamageSeverity, string>;
}

export const EMPTY_DAMAGE_AMOUNTS: DamageAmounts = {
  MINOR: 0n,
  MODERATE: 0n,
  SEVERE: 0n,
};

export function isDamageSeverity(value: unknown): value is DamageSeverity {
  return typeof value === 'string' && (DAMAGE_SEVERITIES as readonly string[]).includes(value);
}

export function serializeDamagePolicy(policy: DamageFeePolicy): DamagePolicySnapshot {
  return {
    enabled: policy.enabled,
    amounts: {
      MINOR: policy.amounts.MINOR.toString(),
      MODERATE: policy.amounts.MODERATE.toString(),
      SEVERE: policy.amounts.SEVERE.toString(),
    },
  };
}

/**
 * Baca snapshot dari database. Snapshot lama/rusak diperlakukan sebagai
 * kebijakan nonaktif dengan nominal nol — bukan error — supaya inspeksi lama
 * tetap dapat dibaca dan diputuskan.
 */
export function parseDamagePolicy(snapshot: unknown): DamageFeePolicy {
  if (!snapshot || typeof snapshot !== 'object') {
    return { enabled: false, amounts: { ...EMPTY_DAMAGE_AMOUNTS } };
  }
  const raw = snapshot as { enabled?: unknown; amounts?: Record<string, unknown> };
  const amounts: DamageAmounts = { ...EMPTY_DAMAGE_AMOUNTS };
  for (const severity of DAMAGE_SEVERITIES) {
    const value = raw.amounts?.[severity];
    const parsed = typeof value === 'string' ? BigInt(value) : typeof value === 'number' ? BigInt(Math.trunc(value)) : 0n;
    amounts[severity] = parsed > 0n ? parsed : 0n;
  }
  return { enabled: raw.enabled === true, amounts };
}

export function computeDamageFee(
  policy: DamageFeePolicy,
  severity: DamageSeverity | null | undefined,
): DamageFeeView {
  const amounts: Record<DamageSeverity, string> = {
    MINOR: policy.amounts.MINOR.toString(),
    MODERATE: policy.amounts.MODERATE.toString(),
    SEVERE: policy.amounts.SEVERE.toString(),
  };
  const base: DamageFeeView = {
    enabled: policy.enabled,
    severity: severity ?? null,
    label: severity ? DAMAGE_SEVERITY_LABEL[severity] : null,
    amount: null,
    amounts,
  };

  // Usulan hanya muncul saat saklar aktif, tingkat kondisi diisi, dan
  // nominalnya lebih dari nol. Denda Rp0 tidak perlu ditawarkan.
  if (!policy.enabled || !severity) return base;
  const amount = policy.amounts[severity];
  if (amount <= 0n) return base;
  return { ...base, amount: amount.toString() };
}
