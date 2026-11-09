import { Suspense } from "react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { LoginPage } from "@/features/auth/login-page";
import { resolveTenantHost } from "@/shared/api/public-tenant";
import { LoadingBlock } from "@/shared/ui/states";

export async function generateMetadata(): Promise<Metadata> {
  const headerList = await headers();
  const resolution = await resolveTenantHost(headerList.get("host"));
  if (resolution.kind === "tenant") {
    const label = resolution.tenant.name ?? resolution.tenant.slug;
    return { title: `Masuk — ${label}` };
  }
  return { title: "Masuk" };
}

export default async function Page() {
  const headerList = await headers();
  const resolution = await resolveTenantHost(headerList.get("host"));
  if (resolution.kind === "unknown-tenant") notFound();
  const tenant = resolution.kind === "tenant" ? resolution.tenant : null;

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
