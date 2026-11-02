import type { Metadata } from "next";
import Link from "next/link";
import { AdminApiError, listAuditEvents } from "@/shared/api/server";
import { describeApiError } from "@/shared/api/errors";
import type { AuditEvent, Paged } from "@/shared/api/types";
import { AUDIT_ACTIONS } from "@/shared/labels";
import { formatDateTime, localInputToIso, shortId } from "@/shared/format";
import { Pagination } from "@/shared/ui/pagination";
import { EmptyState, ErrorPanel } from "@/shared/ui/states";

export const metadata: Metadata = { title: "Audit" };
export const dynamic = "force-dynamic";

interface Search {
  actorAdminId?: string;
  action?: string;
  from?: string;
  to?: string;
  page?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function outcomeTone(outcome: AuditEvent["outcome"]): string {
  if (outcome === "SUCCESS") return "active";
  if (outcome === "FAILED") return "suspended";
  return "pending";
}

export default async function AuditPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const actorAdminId =
    params.actorAdminId && UUID_PATTERN.test(params.actorAdminId) ? params.actorAdminId : undefined;
  const action = AUDIT_ACTIONS.find((item) => item === params.action);
  const fromInput = params.from ?? "";
  const toInput = params.to ?? "";
  const from = localInputToIso(fromInput);
  const to = localInputToIso(toInput);
  const page = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);

  let result: Paged<AuditEvent> | null = null;
  let failure: string | null = null;

  try {
    result = await listAuditEvents({
      actorAdminId,
      action,
      from,
      to,
      page,
    });
  } catch (error) {
    if (error instanceof AdminApiError) failure = describeApiError(error);
    else throw error;
  }

  const query: Record<string, string> = {};
  if (actorAdminId) query.actorAdminId = actorAdminId;
  if (action) query.action = action;
  if (fromInput) query.from = fromInput;
  if (toInput) query.to = toInput;

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">Audit platform</h1>
          <p className="page__sub">
            Log append-only: akses direktori, perubahan status, penugasan role, dan penyelesaian
            tagihan. Membaca log tidak menulis event baru.
          </p>
        </div>
        {result ? <p className="subtle">{result.total} event</p> : null}
      </header>

      <div className="panel">
        <div className="panel__body">
          <form className="toolbar" action="/audit" method="get">
            <div className="field">
              <label className="label" htmlFor="action">
                Aksi
              </label>
              <select className="select" id="action" name="action" defaultValue={action ?? ""}>
                <option value="">Semua aksi</option>
                {AUDIT_ACTIONS.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="label" htmlFor="actorAdminId">
                ID aktor (UUID)
              </label>
              <input
                className="input mono"
                id="actorAdminId"
                name="actorAdminId"
                defaultValue={actorAdminId ?? ""}
                placeholder="00000000-0000-0000-0000-000000000000"
              />
            </div>
            <div className="field field--narrow">
              <label className="label" htmlFor="from">
                Dari
              </label>
              <input
                className="input"
                id="from"
                name="from"
                type="datetime-local"
                defaultValue={fromInput}
              />
            </div>
            <div className="field field--narrow">
              <label className="label" htmlFor="to">
                Sampai
              </label>
              <input className="input" id="to" name="to" type="datetime-local" defaultValue={toInput} />
            </div>
            <button className="btn btn--primary" type="submit">
              Terapkan
            </button>
            <Link className="btn btn--ghost" href="/audit">
              Reset
            </Link>
          </form>
        </div>
      </div>

      {failure ? (
        <ErrorPanel title="Audit tidak dapat dimuat" message={failure} />
      ) : result ? (
        <div className="panel">
          <div className="panel__body panel__body--flush">
            {result.data.length === 0 ? (
              <EmptyState title="Belum ada event yang cocok">
                <p className="subtle">Longgarkan filter waktu atau pilih aksi lain.</p>
              </EmptyState>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Waktu</th>
                      <th scope="col">Aksi</th>
                      <th scope="col">Aktor</th>
                      <th scope="col">Target</th>
                      <th scope="col">Hasil</th>
                      <th scope="col">Konteks</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.data.map((event) => (
                      <tr key={event.id}>
                        <td>{formatDateTime(event.createdAt)}</td>
                        <td className="mono">{event.action}</td>
                        <td className="mono">{shortId(event.actorAdminId)}</td>
                        <td>
                          <span className="subtle">{event.targetType ?? "—"}</span>
                          {event.targetId ? (
                            <div className="mono subtle">{shortId(event.targetId)}</div>
                          ) : null}
                        </td>
                        <td>
                          <span className={`pill pill--${outcomeTone(event.outcome)}`}>
                            {event.outcome}
                          </span>
                        </td>
                        <td>
                          {event.reason ? <div>{event.reason}</div> : null}
                          <details>
                            <summary>Metadata & korelasi</summary>
                            <p className="json">
                              {`correlationId: ${event.correlationId}\n`}
                              {event.metadata ? JSON.stringify(event.metadata, null, 2) : "{}"}
                            </p>
                          </details>
                        </td>
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
              basePath="/audit"
              query={query}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
