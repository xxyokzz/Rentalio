"use client";

import {
  isLocalHost,
  isPlatformApex,
  slugFromPlatformSubdomain,
  tenantOrigin,
} from "@/shared/config/hosts";

/**
 * Aturan domain untuk aplikasi terautentikasi di browser.
 *
 * Aplikasi hanya boleh disajikan di domain tenant pemilik sesi:
 * - `rentalio.my.id/app` → dialihkan ke `{slug}.rentalio.my.id/app`;
 * - `{lain}.rentalio.my.id/app` → dialihkan ke subdomain tenant akun;
 * - `{slug}.rentalio.my.id` → sudah benar;
 * - `{slug}.localhost` dan domain kustom → tidak dialihkan (dev / domain
 *   tenant terverifikasi yang dipetakan server-side).
 *
 * Mengembalikan URL tujuan, atau `null` bila host sekarang sudah tepat.
 */
export function tenantHostRedirect(
  slug: string,
  pathname: string,
  search: string,
): string | null {
  if (typeof window === "undefined") return null;
  const hostname = window.location.hostname;
  if (isLocalHost(hostname)) return null;

  const hostSlug = slugFromPlatformSubdomain(hostname);
  if (hostSlug === slug) return null;

  // Domain kustom terverifikasi tidak bisa dipetakan ke tenant di klien;
  // biarkan server yang memutuskan.
  const isPlatformAddress = hostSlug !== null || isPlatformApex(hostname);
  if (!isPlatformAddress) return null;

  return `${tenantOrigin(slug)}${pathname}${search}`;
}

/** Slug tenant yang sedang dipakai host ini, null untuk domain platform/kustom. */
export function currentTenantSlug(): string | null {
  if (typeof window === "undefined") return null;
  const hostname = window.location.hostname;
  if (isLocalHost(hostname)) return null;
  return slugFromPlatformSubdomain(hostname);
}
