"use client";

/**
 * Simulator nominal denda kerusakan untuk layar pengaturan.
 *
 * Hitungan ini hanya perkiraan dari nilai formulir: server tetap menghitung
 * ulang usulan saat inspeksi dibuat dan menyalin kebijakan ke snapshot. Aturan
 * di sini mengikuti `apps/api/src/returns/damage-fee.ts` — nominal kategori
 * yang tersimpan menggantikan nominal umum sepenuhnya (termasuk Rp0), plafon
 * memotong total, dan saklar denda mati berarti tanpa usulan.
 */

export type DamageSimulationSeverity = "MINOR" | "MODERATE" | "SEVERE";

export const DAMAGE_SIMULATION_SEVERITIES: readonly DamageSimulationSeverity[] = [
  "MINOR",
  "MODERATE",
  "SEVERE",
];

export const DAMAGE_SIMULATION_SEVERITY_LABEL: Record<DamageSimulationSeverity, string> = {
  MINOR: "Ringan",
  MODERATE: "Sedang",
  SEVERE: "Parah",
};

export interface DamageFeeAmounts {
  minor: string;
  moderate: string;
  severe: string;
}

export interface DamageFeeSimulationInput {
  enabled: boolean;
  severity: DamageSimulationSeverity;
  quantity: number;
  /** Kosong berarti memakai nominal umum. */
  categoryId: string;
  amounts: DamageFeeAmounts;
  maxAmount: string;
  /** Nominal tersimpan per kategori (hanya kategori yang punya baris). */
  categoryAmounts: Record<string, DamageFeeAmounts>;
}

export interface DamageFeeSimulation {
  /** Sumber nominal yang dipakai: override kategori atau nominal umum. */
  source: "CATEGORY" | "GENERAL";
  /** Nominal per tingkat kondisi yang berlaku untuk pilihan saat ini. */
  amounts: Record<DamageSimulationSeverity, string>;
  rate: string;
  rawAmount: string | null;
  amount: string | null;
  capped: boolean;
  maxAmount: string | null;
  /**
   * Alasan usulan kosong, agar UI bisa menjelaskannya: saklar mati, jumlah item
   * kosong, atau nominal berlaku Rp0 (umum maupun override kategori).
   */
  notice: "DISABLED" | "NO_QUANTITY" | "ZERO" | null;
}

function toBigInt(value: string | null | undefined): bigint {
  const digits = (value ?? "").replace(/\D/g, "");
  return digits ? BigInt(digits) : 0n;
}

function amountFor(amounts: DamageFeeAmounts, severity: DamageSimulationSeverity): string {
  if (severity === "MINOR") return amounts.minor;
  if (severity === "MODERATE") return amounts.moderate;
  return amounts.severe;
}

export function simulateDamageFee(input: DamageFeeSimulationInput): DamageFeeSimulation {
  const override = input.categoryId ? input.categoryAmounts[input.categoryId] : undefined;
  const effective = override ?? input.amounts;
  const amounts: Record<DamageSimulationSeverity, string> = {
    MINOR: amountFor(effective, "MINOR"),
    MODERATE: amountFor(effective, "MODERATE"),
    SEVERE: amountFor(effective, "SEVERE"),
  };
  const max = toBigInt(input.maxAmount);
  const quantity = Number.isFinite(input.quantity) && input.quantity > 0 ? BigInt(Math.trunc(input.quantity)) : 0n;
  const rate = toBigInt(amounts[input.severity]);
  const base = {
    source: override ? ("CATEGORY" as const) : ("GENERAL" as const),
    amounts,
    rate: rate.toString(),
    rawAmount: null,
    amount: null,
    capped: false,
    maxAmount: max > 0n ? max.toString() : null,
  };

  if (!input.enabled) return { ...base, notice: "DISABLED" };
  if (quantity <= 0n) return { ...base, notice: "NO_QUANTITY" };
  const raw = rate * quantity;
  // Denda Rp0 tidak perlu ditawarkan, sama seperti computeDamageFee di server.
  if (raw <= 0n) return { ...base, notice: "ZERO" };
  const capped = max > 0n && raw > max;
  return {
    ...base,
    rawAmount: raw.toString(),
    amount: (capped ? max : raw).toString(),
    capped,
    notice: null,
  };
}
