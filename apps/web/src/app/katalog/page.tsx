import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { CatalogPage } from "@/features/catalog/catalog-page";
import { resolveTenantHost } from "@/shared/api/public-tenant";
import { PublicShell } from "@/shared/layout/public-shell";

export const metadata: Metadata = { title: "Katalog" };

/**
 * Katalog publik hanya hidup di host tenant.
 *
 * - subdomain tenant terdaftar / `{slug}.localhost` / domain kustom terverifikasi
 *   → katalog tenant tersebut;
 * - subdomain tak terdaftar → 404;
 * - domain platform (`rentalio.my.id/katalog`) → 404. Katalog tidak boleh
 *   disajikan di path platform, termasuk lewat form tebak-slug: tautan katalog
 *   selalu berbentuk `{slug}.rentalio.my.id/katalog`.
 *
 * Tidak ada lagi slug default atau form tebak-slug di domain platform.
 */
export default async function Page() {
  const headerList = await headers();
  const resolution = await resolveTenantHost(headerList.get("host"));
  if (resolution.kind !== "tenant") notFound();

  return (
    <PublicShell>
      <CatalogPage slug={resolution.tenant.slug} />
    </PublicShell>
  );
}
