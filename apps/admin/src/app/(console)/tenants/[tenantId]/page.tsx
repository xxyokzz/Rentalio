import type { Metadata } from "next";
import Link from "next/link";
import { AdminApiError, getAdminSession, getTenant } from "@/shared/api/server";
import { describeApiError } from "@/shared/api/errors";
import type { TenantDetail } from "@/shared/api/types";
import { TENANT_STATUS_LABELS, TENANT_STATUS_TONES } from "@/shared/labels";
import { formatDate, formatDateTime } from "@/shared/format";
import { ErrorPanel } from "@/shared/ui/states";
import { SettleInvoicePanel, TenantStatusPanel } from "@/features/tenants/tenant-actions";

export const metadata: Metadata = { title: "Detail tenant" };
export const dynamic = "force-dynamic";

export default async function TenantDetailPage({
  params,
}: {
  params: Promise<{ tenantId: string }>;
}) {
  const { tenantId } = await params;

  let tenant: TenantDetail | null = null;
  let failure: string | null = null;

  try {
    tenant = await getTenant(tenantId);
  } catch (error) {
    if (error instanceof AdminApiError) failure = describeApiError(error);
    else throw error;
  }

  const session = await getAdminSession();

  return (
    <div className="page">
      <nav className="breadcrumb" aria-label="Remah roti">
        <Link href="/tenants">Tenant</Link>
        <span aria-hidden="true">/</span>
        <span>{tenant ? tenant.name : "Detail"}</span>
      </nav>

      {failure || !tenant ? (
        <ErrorPanel
          title="Tenant tidak dapat dimuat"
          message={failure ?? "Data tenant tidak tersedia."}
        />
      ) : (
        <>
          <header className="page__head">
            <div>
              <h1 className="page__title">{tenant.name}</h1>
              <p className="page__sub">
                <span className="mono">{tenant.slug}</span> · dibuat {formatDate(tenant.createdAt)}
              </p>
            </div>
            <span className={`pill pill--${TENANT_STATUS_TONES[tenant.status]}`}>
              {TENANT_STATUS_LABELS[tenant.status]}
            </span>
          </header>

          <div className="panel">
            <div className="panel__head">
              <h2 className="panel__title">Ringkasan</h2>
            </div>
            <div className="panel__body">
              <dl className="dl">
                <dt>ID tenant</dt>
                <dd className="mono">{tenant.id}</dd>
                <dt>Slug</dt>
                <dd className="mono">{tenant.slug}</dd>
                <dt>Status</dt>
                <dd>{TENANT_STATUS_LABELS[tenant.status]}</dd>
                <dt>Zona waktu</dt>
                <dd className="mono">{tenant.timezone}</dd>
                <dt>Mata uang</dt>
                <dd className="mono">{tenant.currency}</dd>
                <dt>Dibuat</dt>
                <dd>{formatDateTime(tenant.createdAt)}</dd>
                <dt>Terakhir diubah</dt>
                <dd>{formatDateTime(tenant.updatedAt)}</dd>
                <dt>Aktivasi</dt>
                <dd>{formatDateTime(tenant.activatedAt)}</dd>
                <dt>Trial berakhir</dt>
                <dd>{formatDate(tenant.trialEndsAt)}</dd>
              </dl>
            </div>
          </div>

          <TenantStatusPanel
            tenantId={tenant.id}
            status={tenant.status}
            permissions={session?.permissions ?? []}
          />

          <SettleInvoicePanel tenantId={tenant.id} permissions={session?.permissions ?? []} />
        </>
      )}
    </div>
  );
}
