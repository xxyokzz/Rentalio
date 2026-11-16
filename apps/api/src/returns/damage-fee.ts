/**
 * Denda kerusakan barang (dokumen 15).
 *
 * Aturan (disepakati dengan owner lewat pengaturan tenant):
 * - Nominal diatur owner per tingkat kondisi: ringan, sedang, parah.
 * - Saklar mati berarti usulan selalu kosong, tanpa menghapus nominal tersimpan.
 * - Saklar inspeksi mati menutup alur inspeksi seluruhnya (ditegakkan service).
 * - Konfigurasi disalin ke snapshot saat inspeksi dibuat, jadi perubahan
 *   nominal setelahnya tidak menulis ulang usulan inspeksi yang berjalan.
 * - Plafon (opsional) memotong usulan dan menandainya `capped`, supaya salah
 *   input nominal tidak langsung menjadi tagihan.
 * - Usulan boleh dirinci per item; total usulan = jumlah usulan tiap baris.
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
  /** Plafon total usulan per inspeksi; null/kosong berarti tanpa plafon. */
  maxAmount?: bigint | null;
  /**
   * Nominal khusus per kategori produk, disalin dari konfigurasi tenant saat
   * snapshot dibuat. Kategori yang tidak tercatat memakai `amounts`.
   */
  categories?: Record<string, DamageAmounts>;
}

/** Bentuk JSON yang disimpan pada `inspections.damagePolicySnapshot`. */
export interface DamagePolicySnapshot {
  enabled: boolean;
  amounts: Record<DamageSeverity, string>;
  /** Hanya ditulis bila ada plafon, agar snapshot lama tetap ringkas. */
  maxAmount?: string | null;
  categories?: Record<string, Record<DamageSeverity, string>>;
}

export interface DamageFeeView {
  enabled: boolean;
  severity: DamageSeverity | null;
  label: string | null;
  /** Usulan denda setelah plafon; null bila saklar mati atau nominal nol. */
  amount: string | null;
  /** Usulan sebelum plafon, berguna untuk UI memperingatkan pemotongan. */
  rawAmount: string | null;
  capped: boolean;
  maxAmount: string | null;
  amounts: Record<DamageSeverity, string>;
}

export interface DamageSuggestionLine {
  severity: DamageSeverity;
  quantity: number;
  /** Nominal efektif baris (termasuk override kategori) bila sudah diresolusi. */
  amounts?: DamageAmounts;
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
  const snapshot: DamagePolicySnapshot = {
    enabled: policy.enabled,
    amounts: {
      MINOR: policy.amounts.MINOR.toString(),
      MODERATE: policy.amounts.MODERATE.toString(),
      SEVERE: policy.amounts.SEVERE.toString(),
    },
  };
  if (policy.maxAmount != null) snapshot.maxAmount = policy.maxAmount.toString();
  if (policy.categories && Object.keys(policy.categories).length > 0) {
    snapshot.categories = Object.fromEntries(
      Object.entries(policy.categories).map(([categoryId, amounts]) => [
        categoryId,
        {
          MINOR: amounts.MINOR.toString(),
          MODERATE: amounts.MODERATE.toString(),
          SEVERE: amounts.SEVERE.toString(),
        },
      ]),
    );
  }
  return snapshot;
}

function parseAmount(value: unknown): bigint | null {
  const parsed =
    typeof value === 'string'
      ? BigInt(value)
      : typeof value === 'number'
        ? BigInt(Math.trunc(value))
        : 0n;
  return parsed > 0n ? parsed : null;
}

/**
 * Baca snapshot dari database. Snapshot lama/rusak diperlakukan sebagai
 * kebijakan nonaktif dengan nominal nol — bukan error — supaya inspeksi lama
 * tetap dapat dibaca dan diputuskan.
 */
export function parseDamagePolicy(snapshot: unknown): DamageFeePolicy {
  if (!snapshot || typeof snapshot !== 'object') {
    return { enabled: false, amounts: { ...EMPTY_DAMAGE_AMOUNTS }, maxAmount: null };
  }
  const raw = snapshot as {
    enabled?: unknown;
    amounts?: Record<string, unknown>;
    maxAmount?: unknown;
    categories?: Record<string, Record<string, unknown>>;
  };
  const amounts: DamageAmounts = { ...EMPTY_DAMAGE_AMOUNTS };
  for (const severity of DAMAGE_SEVERITIES) {
    amounts[severity] = parseAmount(raw.amounts?.[severity]) ?? 0n;
  }
  let categories: Record<string, DamageAmounts> | undefined;
  if (raw.categories && typeof raw.categories === 'object') {
    categories = {};
    for (const [categoryId, values] of Object.entries(raw.categories)) {
      categories[categoryId] = {
        MINOR: parseAmount(values?.MINOR) ?? 0n,
        MODERATE: parseAmount(values?.MODERATE) ?? 0n,
        SEVERE: parseAmount(values?.SEVERE) ?? 0n,
      };
    }
  }
  return {
    enabled: raw.enabled === true,
    amounts,
    maxAmount: parseAmount(raw.maxAmount),
    ...(categories ? { categories } : {}),
  };
}

/** Terapkan plafon pada total usulan. */
export function applyDamageCap(
  policy: DamageFeePolicy,
  rawAmount: bigint,
): { amount: bigint; capped: boolean } {
  if (policy.maxAmount != null && rawAmount > policy.maxAmount) {
    return { amount: policy.maxAmount, capped: true };
  }
  return { amount: rawAmount, capped: false };
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
    rawAmount: null,
    capped: false,
    maxAmount: policy.maxAmount == null ? null : policy.maxAmount.toString(),
    amounts,
  };

  // Usulan hanya muncul saat saklar aktif, tingkat kondisi diisi, dan
  // nominalnya lebih dari nol. Denda Rp0 tidak perlu ditawarkan.
  if (!policy.enabled || !severity) return base;
  const raw = policy.amounts[severity];
  if (raw <= 0n) return base;
  const capped = applyDamageCap(policy, raw);
  return {
    ...base,
    amount: capped.amount.toString(),
    rawAmount: raw.toString(),
    capped: capped.capped,
  };
}

/**
 * Total usulan dari baris-baris kerusakan. Baris dengan tingkat kondisi yang
 * nominalnya nol tetap dijumlahkan sebagai nol (bukan diabaikan diam-diam).
 */
export function computeDamageFeeForLines(
  policy: DamageFeePolicy,
  lines: DamageSuggestionLine[],
): { amount: string | null; rawAmount: string | null; capped: boolean } {
  if (!policy.enabled || lines.length === 0) {
    return { amount: null, rawAmount: null, capped: false };
  }
  let raw = 0n;
  for (const line of lines) {
    const quantity = line.quantity > 0 ? BigInt(line.quantity) : 0n;
    const amounts = line.amounts ?? policy.amounts;
    raw += amounts[line.severity] * quantity;
  }
  if (raw <= 0n) return { amount: null, rawAmount: null, capped: false };
  const capped = applyDamageCap(policy, raw);
  return {
    amount: capped.amount.toString(),
    rawAmount: raw.toString(),
    capped: capped.capped,
  };
}

/** Nominal efektif sebuah baris: override kategori di snapshot lalu default. */
export function amountsForCategory(
  policy: DamageFeePolicy,
  categoryId: string | null | undefined,
): DamageAmounts {
  if (categoryId && policy.categories?.[categoryId]) return policy.categories[categoryId];
  return policy.amounts;
}
