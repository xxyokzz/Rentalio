/**
 * Format Rupiah terpusat (Notion 09 §6).
 *
 * Nilai uang dari API adalah integer rupiah utuh berbentuk string. Jangan
 * memakai float atau menulis format manual di komponen.
 */
const idrFormatter = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
  minimumFractionDigits: 0,
});

/**
 * "1250000" → "Rp 1.250.000". Nilai kosong/tidak valid → "—".
 * Spasi tak-putus dari Intl dinormalkan agar tampilan & pencarian teks stabil
 * di semua browser/ICU.
 */
export function formatIDR(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const numeric = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(numeric)) return "—";
  return idrFormatter.format(numeric).replace(/\u00a0/g, " ");
}

/** Nilai uang untuk input teks: tanpa simbol, tanpa pemisah ribuan. */
export function toIDRInput(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  const numeric = typeof value === "number" ? value : Number.parseInt(value, 10);
  return Number.isFinite(numeric) ? String(numeric) : "";
}

/**
 * Parse input pengguna menjadi integer rupiah utuh. Mengembalikan null bila
 * bukan bilangan bulat non-negatif. Titik/spasi pemisah ribuan diabaikan,
 * koma desimal ditolak karena rupiah utuh tidak memakai pecahan.
 */
export function parseIDRInput(input: string): number | null {
  const cleaned = input.trim().replace(/^Rp\s*/i, "").replace(/[.\s]/g, "");
  if (!/^\d+$/.test(cleaned)) return null;
  const parsed = Number.parseInt(cleaned, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Jumlah hari sewa, minimal 1, dibulatkan ke atas untuk periode parsial. */
export function rentalDays(startAt: string, endAt: string): number {
  const start = new Date(startAt).getTime();
  const end = new Date(endAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return Math.ceil((end - start) / (24 * 60 * 60 * 1000));
}
