import type { Metadata } from "next";
import { headers } from "next/headers";
import { CatalogEntry } from "@/features/catalog/catalog-entry";
import { CatalogPage } from "@/features/catalog/catalog-page";
import { resolveTenantFromHost } from "@/shared/api/public-tenant";
import { PublicShell } from "@/shared/layout/public-shell";
import { PageHeader } from "@/shared/ui/surfaces";

export const metadata: Metadata = { title: "Katalog" };

/**
 * `/katalog` mengikuti host:
 * - subdomain platform / `{slug}.localhost` / domain kustom terverifikasi →
 *   katalog tenant tersebut;
 * - selain itu memakai `NEXT_PUBLIC_DEFAULT_TENANT_SLUG` (mode demo) atau
 *   menampilkan form slug, tanpa menebak tenant.
 */
export default async function Page() {
  const headerList = await headers();
  const tenant = await resolveTenantFromHost(headerList.get("host"));
  const slug =
    tenant?.slug ?? (process.env.NEXT_PUBLIC_DEFAULT_TENANT_SLUG?.trim() || undefined);

  return (
    <PublicShell>
      {slug ? (
        <CatalogPage slug={slug} />
      ) : (
        <div className="public-main">
          <PageHeader
            title="Buka katalog toko"
            subtitle="Katalog publik diakses melalui tautan tenant. Masukkan slug toko untuk melanjutkan."
          />
          <CatalogEntry />
        </div>
      )}
    </PublicShell>
  );
}
