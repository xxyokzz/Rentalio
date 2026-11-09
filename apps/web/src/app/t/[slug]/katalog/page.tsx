import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { isTenantSlug, tenantCatalogUrl } from "@/shared/config/hosts";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  return {
    title: "Katalog",
    // URL kanonik katalog adalah host tenant, bukan path platform.
    alternates: isTenantSlug(slug) ? { canonical: tenantCatalogUrl(slug) } : undefined,
    robots: { index: false, follow: false },
  };
}

/**
 * `/t/{slug}/katalog` tidak lagi menyajikan katalog. Katalog publik hanya hidup
 * di host tenant (`{slug}.rentalio.my.id/katalog`), jadi setiap tautan lama
 * dialihkan ke sana.
 */
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!isTenantSlug(slug)) notFound();
  redirect(tenantCatalogUrl(slug));
}
