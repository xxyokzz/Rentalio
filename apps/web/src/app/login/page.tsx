import { Suspense } from "react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { LoginPage } from "@/features/auth/login-page";
import { resolveTenantFromHost } from "@/shared/api/public-tenant";
import { LoadingBlock } from "@/shared/ui/states";

export async function generateMetadata(): Promise<Metadata> {
  const headerList = await headers();
  const tenant = await resolveTenantFromHost(headerList.get("host"));
  if (tenant) {
    const label = tenant.name ?? tenant.slug;
    return { title: `Masuk — ${label}` };
  }
  return { title: "Masuk" };
}

export default async function Page() {
  const headerList = await headers();
  const tenant = await resolveTenantFromHost(headerList.get("host"));

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
      <LoginPage tenantName={tenant?.name ?? tenant?.slug} slug={tenant?.slug} />
    </Suspense>
  );
}
