/**
 * Utilitas host publik.
 *
 * Satu aplikasi web melayani beberapa bentuk alamat:
 * - `{slug}.rentalio.my.id` dan `rentalio.my.id` (domain platform),
 * - `{slug}.localhost` untuk pengembangan lokal,
 * - hostname kustom tenant (mis. `sewa-kamera.com`) yang sudah diverifikasi.
 *
 * Modul ini hanya mem-parsing bentuk host; pemetaan hostname kustom → tenant
 * dilakukan server-side lewat API agar sumber kebenaran tetap database
 * (`tenant_domains`), bukan tebakan di browser.
 */

/** Domain platform; subdomain langsung di bawahnya adalah slug tenant. */
export const PLATFORM_ROOT_DOMAIN = (
  process.env.NEXT_PUBLIC_PLATFORM_ROOT_DOMAIN ?? "rentalio.my.id"
)
  .trim()
  .toLowerCase()
  .replace(/^\.+|\.+$/g, "");

/** Label yang dipakai platform sendiri, bukan slug tenant. */
const RESERVED_SUBDOMAINS = new Set([
  "www",
  "app",
  "api",
  "docs",
  "admin",
  "status",
  "mail",
  "portal",
]);

const LABEL = "[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?";
const SLUG_PATTERN = new RegExp(`^${LABEL}$`);

/** Ambil hostname dari header `Host`/`X-Forwarded-Host` tanpa port dan titik akhir. */
export function normalizeHostHeader(value: string | null | undefined): string | null {
  if (!value) return null;
  const first = value.split(",")[0] ?? "";
  const host = first
    .trim()
    .toLowerCase()
    .replace(/:\d{1,5}$/, "")
    .replace(/\.$/, "");
  return host || null;
}

export function isIpAddress(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.startsWith("[");
}

export function isLocalHost(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "127.0.0.1" ||
    host === "[::1]"
  );
}

/** `demo.rentalio.my.id` → `demo`; domain platform sendiri atau label reserved → null. */
export function slugFromPlatformSubdomain(host: string): string | null {
  if (!PLATFORM_ROOT_DOMAIN) return null;
  if (host === PLATFORM_ROOT_DOMAIN) return null;
  if (!host.endsWith(`.${PLATFORM_ROOT_DOMAIN}`)) return null;
  const subdomain = host.slice(0, -(PLATFORM_ROOT_DOMAIN.length + 1));
  if (!subdomain || subdomain.includes(".")) return null;
  if (RESERVED_SUBDOMAINS.has(subdomain)) return null;
  return SLUG_PATTERN.test(subdomain) ? subdomain : null;
}

/** `demo.localhost` → `demo` untuk pengembangan multi-tenant lokal. */
export function slugFromLocalhost(host: string): string | null {
  if (!host.endsWith(".localhost")) return null;
  const subdomain = host.slice(0, -".localhost".length);
  if (!subdomain || subdomain.includes(".")) return null;
  if (RESERVED_SUBDOMAINS.has(subdomain)) return null;
  return SLUG_PATTERN.test(subdomain) ? subdomain : null;
}

/**
 * Host milik platform sendiri (bukan kandidat domain kustom), sehingga tidak
 * perlu lookup ke API.
 */
export function isPlatformHost(host: string): boolean {
  if (isLocalHost(host) || isIpAddress(host)) return true;
  if (!PLATFORM_ROOT_DOMAIN) return false;
  return host === PLATFORM_ROOT_DOMAIN || host.endsWith(`.${PLATFORM_ROOT_DOMAIN}`);
}
