import type { Metadata } from "next";
import Link from "next/link";
import { AdminApiError, listAdmins } from "@/shared/api/server";
import { describeApiError } from "@/shared/api/errors";
import type { Paged, PlatformAdminSummary } from "@/shared/api/types";
import { ADMIN_STATUS_LABELS } from "@/shared/labels";
import { formatDateTime } from "@/shared/format";
import { Pagination } from "@/shared/ui/pagination";
import { EmptyState, ErrorPanel } from "@/shared/ui/states";

export const metadata: Metadata = { title: "Admin & role" };
export const dynamic = "force-dynamic";

interface Search {
  q?: string;
  page?: string;
}

export default async function AdminsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const q = params.q?.trim() ?? "";
  const page = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);

  let result: Paged<PlatformAdminSummary> | null = null;
  let failure: string | null = null;

  try {
    result = await listAdmins({ q: q || undefined, page });
  } catch (error) {
    if (error instanceof AdminApiError) failure = describeApiError(error);
    else throw error;
  }

  const query: Record<string, string> = {};
  if (q) query.q = q;

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">Admin & role</h1>
          <p className="page__sub">
            Identitas minimal dan penugasan role aktif. Password, secret TOTP, sesi, dan kode
            pemulihan tidak pernah ditampilkan.
          </p>
        </div>
        {result ? <p className="subtle">{result.total} admin</p> : null}
      </header>

      <div className="panel">
        <div className="panel__body">
          <form className="toolbar" action="/admins" method="get">
            <div className="field">
              <label className="label" htmlFor="q">
                Cari email admin
              </label>
              <input
                className="input"
                id="q"
                name="q"
                type="search"
                defaultValue={q}
                maxLength={100}
                placeholder="nama@rentalio.my.id"
              />
            </div>
            <button className="btn btn--primary" type="submit">
              Terapkan
            </button>
            <Link className="btn btn--ghost" href="/admins">
              Reset
            </Link>
          </form>
        </div>
      </div>

      {failure ? (
        <ErrorPanel title="Daftar admin tidak dapat dimuat" message={failure} />
      ) : result ? (
        <div className="panel">
          <div className="panel__body panel__body--flush">
            {result.data.length === 0 ? (
              <EmptyState title="Tidak ada admin yang cocok" />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Admin</th>
                      <th scope="col">Status</th>
                      <th scope="col">Role aktif</th>
                      <th scope="col">MFA terdaftar</th>
                      <th scope="col">Login terakhir</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.data.map((admin) => (
                      <tr key={admin.id}>
                        <td>
                          <Link className="table__primary" href={`/admins/${admin.id}`}>
                            {admin.email}
                          </Link>
                          <div className="subtle mono">{admin.id}</div>
                        </td>
                        <td>
                          <span
                            className={
                              admin.status === "ACTIVE" ? "pill pill--active" : "pill pill--closed"
                            }
                          >
                            {ADMIN_STATUS_LABELS[admin.status] ?? admin.status}
                          </span>
                        </td>
                        <td>
                          {admin.roles.length === 0 ? (
                            <span className="subtle">Tanpa role</span>
                          ) : (
                            <div className="chips">
                              {admin.roles.map((role) => (
                                <span className="chip" key={role.roleCode}>
                                  {role.roleCode}
                                </span>
                              ))}
                            </div>
                          )}
                        </td>
                        <td>{formatDateTime(admin.mfaEnrolledAt)}</td>
                        <td>{formatDateTime(admin.lastLoginAt)}</td>
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
              basePath="/admins"
              query={query}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
