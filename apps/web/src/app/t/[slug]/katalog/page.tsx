import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { isTenantSlug, tenantCatalogUrl } from "@/shared/config/hosts";
import { fetchPublicTenantBySlug } from "@/shared/api/public-tenant";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const tenant = isTenantSlug(slug) ? await fetchPublicTenantBySlug(slug) : null;
  return {
    title: "Katalog",
    // URL kanonik katalog adalah host tenant, bukan path platform.
    alternates: tenant ? { canonical: tenantCatalogUrl(tenant.slug) } : undefined,
    robots: { index: false, follow: false },
  };
}

/**
 * `/t/{slug}/katalog` tidak lagi menyajikan katalog. Katalog publik hanya hidup
 * di host tenant (`{slug}.rentalio.my.id/katalog`), jadi tautan lama dialihkan
 * ke sana — tetapi hanya bila tenant-nya benar-benar terdaftar dan aktif.
 * Slug asing dijawab 404 supaya path platform tidak bisa dipakai menebak atau
 * menyebarkan tautan tenant yang tidak ada.
 */
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!isTenantSlug(slug)) notFound();

  const tenant = await fetchPublicTenantBySlug(slug);
  if (!tenant) notFound();

  redirect(tenantCatalogUrl(tenant.slug));
}
