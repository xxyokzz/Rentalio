import type { Metadata } from "next";
import Link from "next/link";
import { AdminApiError, listTenants } from "@/shared/api/server";
import { describeApiError } from "@/shared/api/errors";
import type { Paged, TenantStatus, TenantSummary } from "@/shared/api/types";
import { TENANT_STATUSES, TENANT_STATUS_LABELS, TENANT_STATUS_TONES } from "@/shared/labels";
import { formatDate } from "@/shared/format";
import { Pagination } from "@/shared/ui/pagination";
import { EmptyState, ErrorPanel } from "@/shared/ui/states";

export const metadata: Metadata = { title: "Tenant" };
export const dynamic = "force-dynamic";

interface Search {
  q?: string;
  status?: string;
  page?: string;
}

function parseStatus(value: string | undefined): TenantStatus | undefined {
  return TENANT_STATUSES.find((status) => status === value);
}

export default async function TenantsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const q = params.q?.trim() ?? "";
  const status = parseStatus(params.status);
  const page = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);

  let result: Paged<TenantSummary> | null = null;
  let failure: string | null = null;

  try {
    result = await listTenants({ q: q || undefined, status, page });
  } catch (error) {
    if (error instanceof AdminApiError) failure = describeApiError(error);
    else throw error;
  }

  const query: Record<string, string> = {};
  if (q) query.q = q;
  if (status) query.status = status;

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">Direktori tenant</h1>
          <p className="page__sub">
            Metadata minimum: identitas bisnis dan status operasional. Setiap halaman yang dibuka
            tercatat pada audit platform.
          </p>
        </div>
        {result ? <p className="subtle">{result.total} tenant</p> : null}
      </header>

      <div className="panel">
        <div className="panel__body">
          <form className="toolbar" action="/tenants" method="get">
            <div className="field">
              <label className="label" htmlFor="q">
                Cari nama atau slug
              </label>
              <input
                className="input"
                id="q"
                name="q"
                type="search"
                defaultValue={q}
                maxLength={100}
                placeholder="mis. rentalio"
              />
            </div>
            <div className="field field--narrow">
              <label className="label" htmlFor="status">
                Status
              </label>
              <select className="select" id="status" name="status" defaultValue={status ?? ""}>
                <option value="">Semua status</option>
                {TENANT_STATUSES.map((item) => (
                  <option key={item} value={item}>
                    {TENANT_STATUS_LABELS[item]}
                  </option>
                ))}
              </select>
            </div>
            <button className="btn btn--primary" type="submit">
              Terapkan
            </button>
            <Link className="btn btn--ghost" href="/tenants">
              Reset
            </Link>
          </form>
        </div>
      </div>

      {failure ? (
        <ErrorPanel title="Direktori tidak dapat dimuat" message={failure} />
      ) : result ? (
        <div className="panel">
          <div className="panel__body panel__body--flush">
            {result.data.length === 0 ? (
              <EmptyState title="Tidak ada tenant yang cocok">
                <p className="subtle">Ubah kata kunci atau filter status, lalu terapkan kembali.</p>
              </EmptyState>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Tenant</th>
                      <th scope="col">Status</th>
                      <th scope="col">Trial berakhir</th>
                      <th scope="col">Dibuat</th>
                      <th scope="col">ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.data.map((tenant) => (
                      <tr key={tenant.id}>
                        <td>
                          <Link className="table__primary" href={`/tenants/${tenant.id}`}>
                            {tenant.name}
                          </Link>
                          <div className="subtle mono">{tenant.slug}</div>
                        </td>
                        <td>
                          <span className={`pill pill--${TENANT_STATUS_TONES[tenant.status]}`}>
                            {TENANT_STATUS_LABELS[tenant.status]}
                          </span>
                        </td>
                        <td>{formatDate(tenant.trialEndsAt)}</td>
                        <td>{formatDate(tenant.createdAt)}</td>
                        <td className="mono subtle">{tenant.id}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <Pagination
              page={result.page}
              pageSize={result.pageSize}
              total={result.total}
              basePath="/tenants"
              query={query}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
