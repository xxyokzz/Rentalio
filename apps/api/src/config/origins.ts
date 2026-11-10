/**
 * Pencocokan Origin untuk CORS dan validasi Origin pada guard CSRF.
 *
 * Satu aplikasi Rentalio punya banyak host sah: domain platform
 * (`rentalio.my.id`), subdomain tenant (`demo-sewa.rentalio.my.id`), dan admin.
 * Karena slug tenant dibuat dinamis, allowlist boleh memakai `*` pada bagian
 * host — mis. `https://*.rentalio.my.id`.
 *
 * Wildcard hanya menggantikan satu label subdomain (tanpa titik), dan regex
 * di-anchor penuh sehingga `https://*.rentalio.my.id` tidak cocok dengan
 * `https://rentalio.my.id` maupun `https://evil.example/?x=.rentalio.my.id`.
 */
export function isAllowedOrigin(patterns: readonly string[], origin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  // Tolak origin yang membawa path/query (new URL melonggarkan bentuknya).
  if (parsed.origin !== origin) return false;
  return patterns.some((pattern) => matchesPattern(pattern, origin));
}

function matchesPattern(pattern: string, origin: string): boolean {
  if (!pattern.includes('*')) return pattern === origin;
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^./]+');
  try {
    return new RegExp(`^${escaped}$`).test(origin);
  } catch {
    return false;
  }
}

/** True bila entri allowlist berbentuk origin http(s) yang valid (boleh berwildcard). */
export function isOriginPattern(value: string): boolean {
  return /^https?:\/\/(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i.test(value);
}
