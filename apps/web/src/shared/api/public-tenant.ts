import { cache } from "react";
import {
  isPlatformHost,
  normalizeHostHeader,
  slugFromLocalhost,
  slugFromPlatformSubdomain,
} from "@/shared/config/hosts";
import type { components } from "./types.generated";

/**
 * Resolusi tenant untuk halaman publik server-side.
 *
 * Urutan: subdomain lokal (`{slug}.localhost`) → subdomain platform
 * (`{slug}.rentalio.my.id`) → domain kustom lewat API. Domain kustom hanya
 * dianggap valid bila server mengembalikan tenant; kegagalan apa pun berarti
 * halaman diperlakukan sebagai host platform biasa (landing/entry katalog),
 * bukan error 500.
 *
 * `cache()` menduplikasi panggilan antara `generateMetadata` dan komponen
 * halaman pada request yang sama, sehingga API hanya dipanggil sekali.
 */

const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? "http://localhost:3000";

export interface ResolvedPublicTenant {
  slug: string;
  name?: string;
  /** Hostname kustom yang dipakai, null bila lewat subdomain platform. */
  customHost: string | null;
}

async function lookupCustomHost(host: string): Promise<ResolvedPublicTenant | null> {
  try {
    const response = await fetch(
      `${API_INTERNAL_URL}/api/v1/public/resolve-host?host=${encodeURIComponent(host)}`,
      {
        // Domain bisa dinonaktifkan kapan saja: jangan sajikan hasil lama.
        cache: "no-store",
        headers: { Accept: "application/json" },
      },
    );
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      data?: { tenant?: components["schemas"]["PublicTenantResponse"] };
    };
    const tenant = payload.data?.tenant;
    if (!tenant?.slug) return null;
    return { slug: tenant.slug, name: tenant.name, customHost: host };
  } catch {
    // Backend tidak terjangkau: jangan jatuh ke tenant lain/tebakan slug.
    return null;
  }
}

export const resolveTenantFromHost = cache(
  async (rawHost: string | null | undefined): Promise<ResolvedPublicTenant | null> => {
    const host = normalizeHostHeader(rawHost);
    if (!host) return null;

    const localSlug = slugFromLocalhost(host);
    if (localSlug) return { slug: localSlug, customHost: null };

    const platformSlug = slugFromPlatformSubdomain(host);
    if (platformSlug) return { slug: platformSlug, customHost: null };

    if (isPlatformHost(host)) return null;

    return lookupCustomHost(host);
  },
);
