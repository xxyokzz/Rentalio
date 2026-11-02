import { z } from "zod";

/**
 * Validasi klien hanya membantu UX; backend tetap wajib memvalidasi
 * (Notion 09 — stack). Pesan error memakai bahasa Indonesia yang dapat
 * ditindaklanjuti.
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const emailSchema = z
  .string()
  .trim()
  .min(1, "Email wajib diisi.")
  .max(254, "Email terlalu panjang.")
  .refine((value) => EMAIL_PATTERN.test(value), "Format email tidak valid.")
  .transform((value) => value.toLowerCase());

export const passwordSchema = z
  .string()
  .min(12, "Password minimal 12 karakter.")
  .max(128, "Password maksimal 128 karakter.");

/**
 * Slug subdomain: huruf kecil, angka, tanda hubung di tengah. Reserved words
 * dicek agar tidak bertabrakan dengan host aplikasi/admin.
 */
const RESERVED_SLUGS = new Set([
  "admin",
  "api",
  "app",
  "www",
  "mail",
  "support",
  "help",
  "static",
  "cdn",
  "assets",
  "rentalio",
  "katalog",
  "login",
  "register",
  "dashboard",
  "status",
  "docs",
  "blog",
  "test",
  "staging",
]);

export const slugSchema = z
  .string()
  .trim()
  .min(3, "Slug minimal 3 karakter.")
  .max(40, "Slug maksimal 40 karakter.")
  .transform((value) => value.toLowerCase())
  .refine((value) => SLUG_PATTERN.test(value), "Gunakan huruf a–z, angka, dan tanda hubung di tengah.")
  .refine((value) => !RESERVED_SLUGS.has(value), "Slug ini tidak tersedia, pilih yang lain.");

export const tenantNameSchema = z
  .string()
  .trim()
  .min(2, "Nama usaha minimal 2 karakter.")
  .max(80, "Nama usaha maksimal 80 karakter.");

/** Nama pemilik saat registrasi (dokumen 04); batas mengikuti RegisterDto backend. */
export const ownerNameSchema = z
  .string()
  .trim()
  .min(2, "Nama pemilik minimal 2 karakter.")
  .max(120, "Nama pemilik maksimal 120 karakter.");

export const otpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, "Kode OTP terdiri dari 6 digit angka.");

export const reasonSchema = z
  .string()
  .trim()
  .min(3, "Alasan wajib diisi minimal 3 karakter.")
  .max(500, "Alasan maksimal 500 karakter.");

export const idrAmountSchema = z
  .string()
  .trim()
  .regex(/^\d+$/, "Nominal harus bilangan bulat rupiah tanpa pecahan.")
  .refine((value) => Number.parseInt(value, 10) > 0, "Nominal harus lebih dari 0.");

/** True bila input hanya berisi digit (rupiah utuh tanpa pemisah/pecahan). */
export function isIntegerAmount(input: string): boolean {
  return /^\d+$/.test(input.trim());
}

export function firstError(result: { success: boolean; error?: { issues: Array<{ message: string }> } }): string | null {
  if (result.success) return null;
  return result.error?.issues[0]?.message ?? "Data tidak valid.";
}

/** Ubah nama usaha menjadi usulan slug yang bisa diedit. */
export function suggestSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
