/**
 * Label subdomain yang dimiliki platform, sehingga tidak boleh dipakai tenant.
 *
 * Daftar ini harus selaras dengan `RESERVED_SUBDOMAINS` di
 * `apps/web/src/shared/config/hosts.ts`: label di sana tidak pernah dianggap
 * subdomain tenant oleh web. Bila tenant bisa mendaftarkan label yang sama
 * (mis. `app` atau `api`), subdomain tenant tersebut tidak akan pernah
 * terjangkau dan alamat platform bisa tertutupi.
 */
const RESERVED = [
  'www',
  'app',
  'api',
  'admin',
  'docs',
  'status',
  'mail',
  'portal',
  'support',
  'billing',
  'assets',
  'static',
  'cdn',
  'staging',
  'preview',
] as const;

export const RESERVED_TENANT_SLUGS: ReadonlySet<string> = new Set(RESERVED);

/** `true` bila slug dipakai platform sendiri (bukan kandidat subdomain tenant). */
export function isReservedTenantSlug(slug: string): boolean {
  return RESERVED_TENANT_SLUGS.has(slug.trim().toLowerCase());
}
