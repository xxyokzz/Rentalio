import type { Metadata } from "next";
import { CatalogPage } from "@/features/catalog/catalog-page";
import { PublicShell } from "@/shared/layout/public-shell";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  return {
    title: `Katalog ${slug}`,
    description: `Katalog sewa publik ${slug}: produk, tarif, dan pengajuan booking tanpa akun.`,
    alternates: { canonical: `/t/${slug}/katalog` },
  };
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return (
    <PublicShell>
      <CatalogPage slug={slug} />
    </PublicShell>
  );
}
