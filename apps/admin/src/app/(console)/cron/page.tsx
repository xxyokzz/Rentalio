import type { Metadata } from "next";
import Link from "next/link";
import { AdminApiError, listCronRuns } from "@/shared/api/server";
import { describeApiError } from "@/shared/api/errors";
import type { CronRun, CronRunStatus, Paged } from "@/shared/api/types";
import {
  CRON_JOB_LABELS,
  CRON_JOB_NAMES,
  CRON_JOB_STATE_LABELS,
  CRON_JOB_STATE_TONES,
  CRON_RUN_STATUSES,
  CRON_RUN_STATUS_LABELS,
  CRON_RUN_STATUS_TONES,
} from "@/shared/labels";
import { formatDateTime, formatDuration, shortId } from "@/shared/format";
import { Pagination } from "@/shared/ui/pagination";
import { EmptyState, ErrorPanel } from "@/shared/ui/states";

export const metadata: Metadata = { title: "Cron" };
export const dynamic = "force-dynamic";

interface Search {
  status?: string;
  page?: string;
}

function parseStatus(value: string | undefined): CronRunStatus | undefined {
  return CRON_RUN_STATUSES.find((status) => status === value);
}

export default async function CronPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const status = parseStatus(params.status);
  const page = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);

  let result: Paged<CronRun> | null = null;
  let failure: string | null = null;

  try {
    result = await listCronRuns({ status, page });
  } catch (error) {
    if (error instanceof AdminApiError) failure = describeApiError(error);
    else throw error;
  }

  const query: Record<string, string> = {};
  if (status) query.status = status;

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">Riwayat cron</h1>
          <p className="page__sub">
            Eksekusi endpoint cron Vercel per menit: status keseluruhan, durasi, serta status
            outbox, subscription, dan billing reminder. Halaman ini hanya membaca riwayat dan tidak
            memicu job.
          </p>
        </div>
        {result ? <p className="subtle">{result.total} run</p> : null}
      </header>

      <div className="panel">
        <div className="panel__body">
          <form className="toolbar" action="/cron" method="get">
            <div className="field field--narrow">
              <label className="label" htmlFor="status">
                Status
              </label>
              <select className="select" id="status" name="status" defaultValue={status ?? ""}>
                <option value="">Semua status</option>
                {CRON_RUN_STATUSES.map((item) => (
                  <option key={item} value={item}>
                    {CRON_RUN_STATUS_LABELS[item]}
                  </option>
                ))}
              </select>
            </div>
            <button className="btn btn--primary" type="submit">
              Terapkan
            </button>
            <Link className="btn btn--ghost" href="/cron">
              Reset
            </Link>
          </form>
        </div>
      </div>

      {failure ? (
        <ErrorPanel title="Riwayat cron tidak dapat dimuat" message={failure} />
      ) : result ? (
        <div className="panel">
          <div className="panel__body panel__body--flush">
            {result.data.length === 0 ? (
              <EmptyState title="Belum ada run cron yang cocok">
                <p className="subtle">Ubah filter status atau tunggu jadwal cron berikutnya.</p>
              </EmptyState>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Waktu mulai</th>
                      <th scope="col">Status</th>
                      <th scope="col">Durasi</th>
                      <th scope="col">Status job</th>
                      <th scope="col">Alert</th>
                      <th scope="col">Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.data.map((run) => (
                      <tr key={run.id}>
                        <td>
                          {formatDateTime(run.startedAt)}
                          <div className="mono subtle">{shortId(run.id)}</div>
                        </td>
                        <td>
                          <span className={`pill pill--${CRON_RUN_STATUS_TONES[run.status]}`}>
                            {CRON_RUN_STATUS_LABELS[run.status]}
                          </span>
                        </td>
                        <td>{formatDuration(run.durationMs)}</td>
                        <td>
                          <div className="job-status">
                            {CRON_JOB_NAMES.map((name) => {
                              const state = run.jobs[name];
                              return (
                                <span
                                  key={name}
                                  className={`pill pill--${CRON_JOB_STATE_TONES[state]}`}
                                >
                                  {CRON_JOB_LABELS[name]}: {CRON_JOB_STATE_LABELS[state]}
                                </span>
                              );
                            })}
                          </div>
                        </td>
                        <td>{formatDateTime(run.alertedAt)}</td>
                        <td>
                          <details>
                            <summary>Hasil &amp; alert</summary>
                            <p className="json">
                              {[
                                `failedJobs: ${run.failedJobs.join(", ") || "—"}`,
                                `alertedAt: ${formatDateTime(run.alertedAt)}`,
                                `results: ${
                                  run.results ? JSON.stringify(run.results, null, 2) : "{}"
                                }`,
                              ].join("\n")}
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
              basePath="/cron"
              query={query}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
