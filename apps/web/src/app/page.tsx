import { Suspense } from "react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { LoginPage } from "@/features/auth/login-page";
import { LandingPage } from "@/features/marketing/landing-page";
import { resolveTenantFromHost } from "@/shared/api/public-tenant";
import { PublicShell } from "@/shared/layout/public-shell";
import { LoadingBlock } from "@/shared/ui/states";

/**
 * Beranda melayani dua peran:
 * - host tenant (subdomain `{slug}.rentalio.my.id`, `{slug}.localhost`, atau domain
 *   kustom) → login toko dengan branding nama toko langsung pada root subdomain;
 * - host platform (`rentalio.my.id` / `localhost`) → landing marketing utama platform.
 */
export async function generateMetadata(): Promise<Metadata> {
  const headerList = await headers();
  const tenant = await resolveTenantFromHost(headerList.get("host"));
  if (tenant) {
    const label = tenant.name ?? tenant.slug;
    return {
      title: `Masuk — ${label}`,
      description: `Portal masuk resmi untuk pemilik dan tim ${label}.`,
    };
  }
  return {
    title: "Rentalio — operasional penyewaan yang rapi",
    description:
      "Kelola booking, ketersediaan, serah-terima, pembayaran manual, deposit, dan pengembalian dalam satu alur kerja yang statusnya terpisah dan bisa diaudit.",
  };
}

export default async function Page() {
  const headerList = await headers();
  const tenant = await resolveTenantFromHost(headerList.get("host"));

  if (tenant) {
    return (
      <Suspense
        fallback={
          <div className="auth-shell">
            <div className="auth-card">
              <LoadingBlock rows={3} />
            </div>
          </div>
        }
      >
        <LoginPage tenantName={tenant.name ?? tenant.slug} slug={tenant.slug} />
      </Suspense>
    );
  }

  return (
    <PublicShell>
      <LandingPage />
    </PublicShell>
  );
}
