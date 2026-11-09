import { cache } from "react";
import {
  isPlatformHost,
  normalizeHostHeader,
  slugFromLocalhost,
  slugFromPlatformSubdomain,
} from "@/shared/config/hosts";
import type { components } from "./types.generated";

/**
 * Resolusi host publik server-side.
 *
 * Hanya tiga bentuk host yang dilayani:
 * - host platform (`rentalio.my.id`, `localhost`) → beranda/login platform;
 * - subdomain tenant (`{slug}.rentalio.my.id`, `{slug}.localhost`) → tenant yang
 *   **wajib terdaftar dan ACTIVE** di database;
 * - hostname kustom terverifikasi (`tenant_domains`) → tenant pemilik domain.
 *
 * Subdomain acak tidak lagi diperlakukan sebagai tenant: slug diverifikasi ke
 * API, dan bila tidak ada hasil, halaman dijawab 404. Pemeriksaan ini sengaja
 * gagal-tertutup — kegagalan API tidak pernah jatuh ke tebakan slug.
 */

const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? "http://localhost:3000";

export interface ResolvedPublicTenant {
  slug: string;
  name?: string;
  /** Hostname kustom yang dipakai, null bila lewat subdomain platform. */
  customHost: string | null;
}

/** Hasil resolusi host beserta alasannya, supaya halaman bisa memilih 404. */
export type TenantHostResolution =
  | { kind: "platform" }
  | { kind: "tenant"; tenant: ResolvedPublicTenant }
  | { kind: "unknown-tenant"; host: string };

function parsePublicTenant(payload: unknown): ResolvedPublicTenant | null {
  const tenant = (payload as { data?: { tenant?: components["schemas"]["PublicTenantResponse"] } })
    ?.data?.tenant;
  if (!tenant?.slug) return null;
  return { slug: tenant.slug, name: tenant.name, customHost: null };
}

async function fetchPublicTenant(path: string): Promise<ResolvedPublicTenant | null> {
  try {
    const response = await fetch(`${API_INTERNAL_URL}${path}`, {
      // Tenant bisa dinonaktifkan kapan saja: jangan sajikan hasil lama.
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    return parsePublicTenant(await response.json());
  } catch {
    // Backend tidak terjangkau: jangan jatuh ke tenant lain/tebakan slug.
    return null;
  }
}

/**
 * Identitas publik tenant dari slug subdomain platform.
 *
 * Dipakai rute web yang perlu memastikan slug benar-benar terdaftar sebelum
 * mengalihkan atau menautkan ke subdomain tenant.
 */
export const fetchPublicTenantBySlug = cache(
  async (slug: string): Promise<ResolvedPublicTenant | null> =>
    fetchPublicTenant(`/api/v1/public/tenants/${encodeURIComponent(slug)}`),
);

async function lookupCustomHost(host: string): Promise<ResolvedPublicTenant | null> {
  const tenant = await fetchPublicTenant(
    `/api/v1/public/resolve-host?host=${encodeURIComponent(host)}`,
  );
  return tenant ? { ...tenant, customHost: host } : null;
}

/**
 * `cache()` menduplikasi panggilan antara `generateMetadata` dan komponen
 * halaman pada request yang sama, sehingga API hanya dipanggil sekali.
 */
export const resolveTenantHost = cache(
  async (rawHost: string | null | undefined): Promise<TenantHostResolution> => {
    const host = normalizeHostHeader(rawHost);
    if (!host) return { kind: "platform" };

    // `{slug}.localhost` hanya ada di pengembangan lokal; tidak ada database
    // tenant untuk diperiksa, jadi slug dev dipakai apa adanya.
    const localSlug = slugFromLocalhost(host);
    if (localSlug) return { kind: "tenant", tenant: { slug: localSlug, customHost: null } };

    const platformSlug = slugFromPlatformSubdomain(host);
    if (platformSlug) {
      const tenant = await fetchPublicTenantBySlug(platformSlug);
      return tenant ? { kind: "tenant", tenant } : { kind: "unknown-tenant", host };
    }

    if (isPlatformHost(host)) return { kind: "platform" };

    const customTenant = await lookupCustomHost(host);
    return customTenant
      ? { kind: "tenant", tenant: customTenant }
      : { kind: "unknown-tenant", host };
  },
);
