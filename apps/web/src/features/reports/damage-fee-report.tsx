"use client";

import { useMemo, useState } from "react";
import { reportApi, type Schema } from "@/shared/api/endpoints";
import { useSession } from "@/shared/auth/session";
import { formatIDR } from "@/shared/format/currency";
import { DEFAULT_TIMEZONE, zonedDateEndIso, zonedDateStartIso } from "@/shared/format/date";
import { inspectionStatus } from "@/shared/format/status";
import { useApi } from "@/shared/hooks/useApi";
import { Button } from "@/shared/ui/buttons";
import { TextInput } from "@/shared/ui/form";
import { Badge, PageHeader, Panel, PanelBody, PanelHead, Stat, StatusBadge } from "@/shared/ui/surfaces";
import { InlineAlert, QueryState } from "@/shared/ui/states";

type Report = Schema<"DamageFeeReportResponse">;

const SEVERITIES = [
  { key: "MINOR", label: "Ringan" },
  { key: "MODERATE", label: "Sedang" },
  { key: "SEVERE", label: "Berat" },
] as const;

function csvCell(value: string | number): string {
  return `"${String(value).replace(/"/g, '""')}"`;
}

/**
 * Laporan denda kerusakan dari `GET /reports/damage-fees`.
 *
 * Angka tagihan hanya menjumlahkan denda berstatus RECORDED; sengketa dan
 * pembatalan ditampilkan terpisah agar laporan tidak membesar diam-diam.
 */
export function DamageFeeReportPage() {
  const { tenantId, tenant } = useSession();
  const timezone = tenant?.timezone ?? DEFAULT_TIMEZONE;
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  // Tanggal pada input adalah tanggal toko: batas hari dihitung di zona tenant,
  // lalu dikirim sebagai ISO UTC agar server tidak menebak zona.
  const state = useApi(
    tenantId
      ? () =>
          reportApi.damageFees(tenantId, {
            from: zonedDateStartIso(from, timezone) ?? undefined,
            to: zonedDateEndIso(to, timezone) ?? undefined,
          })
      : null,
    [tenantId, from, to, timezone],
  );

  const report: Report | null = state.data ?? null;
  const inspectionTotal = useMemo(() => {
    if (!report) return 0;
    return Object.values(report.inspections ?? {}).reduce((sum, count) => sum + (count ?? 0), 0);
  }, [report]);

  const exportCsv = () => {
    if (!report) return;
    const rows: Array<Array<string | number>> = [
      ["bagian", "label", "nilai"],
      ["rentang", "dari", report.range?.from ?? "semua"],
      ["rentang", "sampai", report.range?.to ?? "semua"],
      ["denda", "jumlah_tagihan_tercatat", report.penalties?.count ?? 0],
      ["denda", "total_denda_tercatat_idr", report.penalties?.totalAmount ?? "0"],
      ["denda", "jumlah_dibatalkan", report.penalties?.voidedCount ?? 0],
      ["inspeksi", "total_keputusan", inspectionTotal],
    ];
    for (const [status, count] of Object.entries(report.inspections ?? {})) {
      rows.push(["inspeksi", `status_${status}`, count ?? 0]);
    }
    for (const severity of SEVERITIES) {
      const stat = report.severity?.[severity.key];
      rows.push(["tingkat_kerusakan", `${severity.key}_baris`, stat?.lines ?? 0]);
      rows.push(["tingkat_kerusakan", `${severity.key}_kuantitas`, stat?.quantity ?? 0]);
      rows.push([
        "tingkat_kerusakan",
        `${severity.key}_usulan_idr`,
        stat?.suggestedAmount ?? "0",
      ]);
    }
    for (const product of report.topProducts ?? []) {
      rows.push([
        "produk",
        `${product.productName ?? product.productId} baris`,
        product.lines ?? 0,
      ]);
      rows.push([
        "produk",
        `${product.productName ?? product.productId} usulan_idr`,
        product.suggestedAmount ?? "0",
      ]);
    }

    const csv = rows.map((row) => row.map(csvCell).join(",")).join("\n");
    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `laporan-denda-${from || "awal"}-${to || "akhir"}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="page">
      <PageHeader
        title="Laporan denda kerusakan"
        subtitle={`Tagihan denda, keputusan inspeksi, dan tingkat kerusakan ${tenant?.name ? `— ${tenant.name}` : ""}`}
        actions={
          <Button onClick={exportCsv} disabled={!report}>
            Ekspor CSV
          </Button>
        }
      />

      <Panel>
        <PanelHead
          title="Rentang tanggal"
          description={`Hari penuh menurut zona waktu toko (${timezone}). Kosongkan untuk semua data.`}
        />
        <PanelBody>
          <div className="form-grid">
            <TextInput
              label="Dari"
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
            <TextInput
              label="Sampai"
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </div>
          <InlineAlert tone="info">
            Hanya denda berstatus tercatat yang masuk total. Denda yang dibatalkan dan inspeksi
            yang sedang disanggah ditampilkan terpisah.
          </InlineAlert>
        </PanelBody>
      </Panel>

      <QueryState state={state} loadingRows={3}>
        {() =>
          report ? (
            <>
              <div className="grid-4">
                <Stat
                  label="Denda tercatat"
                  value={<span className="money">{formatIDR(report.penalties?.totalAmount ?? null)}</span>}
                  note={`${report.penalties?.count ?? 0} tagihan`}
                />
                <Stat
                  label="Denda dibatalkan"
                  value={report.penalties?.voidedCount ?? 0}
                  note="Tidak dihitung dalam total"
                />
                <Stat label="Keputusan inspeksi" value={inspectionTotal} note="Semua status" />
                <Stat
                  label="Inspeksi disanggah"
                  value={report.inspections?.DISPUTED ?? 0}
                  note="Menunggu keputusan ulang"
                />
              </div>

              <div className="grid-2">
                <Panel flush>
                  <PanelHead title="Status inspeksi" description="Jumlah inspeksi pada rentang ini." />
                  <div className="table-wrap">
                    <table className="table">
                      <tbody>
                        {Object.entries(report.inspections ?? {}).map(([status, count]) => (
                          <tr key={status}>
                            <td>
                              <StatusBadge status={inspectionStatus(status)} />
                            </td>
                            <td className="num money">{count ?? 0}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Panel>

                <Panel flush>
                  <PanelHead
                    title="Tingkat kerusakan"
                    description="Baris item inspeksi dan usulan denda (bukan tagihan)."
                  />
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th scope="col">Tingkat</th>
                          <th scope="col" className="num">
                            Baris
                          </th>
                          <th scope="col" className="num">
                            Kuantitas
                          </th>
                          <th scope="col" className="num">
                            Usulan
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {SEVERITIES.map((severity) => {
                          const stat = report.severity?.[severity.key];
                          return (
                            <tr key={severity.key}>
                              <td>
                                <Badge tone={severity.key === "SEVERE" ? "danger" : "neutral"}>
                                  {severity.label}
                                </Badge>
                              </td>
                              <td className="num">{stat?.lines ?? 0}</td>
                              <td className="num">{stat?.quantity ?? 0}</td>
                              <td className="num money">{formatIDR(stat?.suggestedAmount ?? null)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </Panel>
              </div>

              <Panel flush>
                <PanelHead
                  title="Produk paling sering rusak"
                  description="Lima produk dengan usulan denda terbesar pada rentang ini."
                />
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Produk</th>
                        <th scope="col" className="num">
                          Baris
                        </th>
                        <th scope="col" className="num">
                          Kuantitas
                        </th>
                        <th scope="col" className="num">
                          Usulan
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {(report.topProducts ?? []).map((product) => (
                        <tr key={product.productId}>
                          <td>{product.productName ?? product.productId}</td>
                          <td className="num">{product.lines ?? 0}</td>
                          <td className="num">{product.quantity ?? 0}</td>
                          <td className="num money">{formatIDR(product.suggestedAmount ?? null)}</td>
                        </tr>
                      ))}
                      {(report.topProducts ?? []).length === 0 ? (
                        <tr>
                          <td colSpan={4} className="text-sm text-muted">
                            Belum ada item kerusakan pada rentang ini.
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </Panel>
            </>
          ) : null
        }
      </QueryState>
    </div>
  );
}
