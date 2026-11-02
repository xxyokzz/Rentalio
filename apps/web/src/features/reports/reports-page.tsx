"use client";

import { useMemo, useState } from "react";
import { orderApi, type Schema } from "@/shared/api/endpoints";
import { useSession } from "@/shared/auth/session";
import { formatIDR } from "@/shared/format/currency";
import { formatDateTime } from "@/shared/format/date";
import { orderStatus } from "@/shared/format/status";
import { useApi } from "@/shared/hooks/useApi";
import { Button } from "@/shared/ui/buttons";
import { PageHeader, Panel, PanelHead, Stat, StatusBadge } from "@/shared/ui/surfaces";
import { InlineAlert, QueryState } from "@/shared/ui/states";

type Order = Schema<"OrderResponse">;

export function ReportsPage() {
  const { tenantId, tenant } = useSession();
  const timezone = tenant?.timezone ?? "Asia/Jakarta";
  const [pageSize, setPageSize] = useState(100);

  const state = useApi(
    tenantId ? () => orderApi.list(tenantId, { page: 1, pageSize }) : null,
    [tenantId, pageSize],
  );

  const recap = useMemo(() => {
    const orders = state.data?.data ?? [];
    const active = orders.filter((order) => order.status !== "CANCELLED");
    const totalBilled = active.reduce((sum, order) => sum + Number(order.totalAmount ?? 0), 0);
    const totalPaid = active.reduce((sum, order) => sum + Number(order.paidAmount ?? 0), 0);
    const totalOutstanding = active.reduce((sum, order) => sum + Number(order.outstandingAmount ?? 0), 0);
    const byStatus = new Map<string, number>();
    for (const order of orders) {
      const key = order.status ?? "UNKNOWN";
      byStatus.set(key, (byStatus.get(key) ?? 0) + 1);
    }
    return { orders, totalBilled, totalPaid, totalOutstanding, byStatus };
  }, [state.data]);

  const exportCsv = () => {
    const header = [
      "orderNumber",
      "status",
      "totalAmount",
      "paidAmount",
      "outstandingAmount",
      "createdAt",
      "hasOpenConflict",
    ];
    const lines = [header.join(",")];
    for (const order of recap.orders) {
      lines.push(
        [
          order.orderNumber ?? "",
          order.status ?? "",
          order.totalAmount ?? "",
          order.paidAmount ?? "",
          order.outstandingAmount ?? "",
          order.createdAt ?? "",
          order.hasOpenConflict ? "true" : "false",
        ]
          .map((value) => `"${String(value).replace(/"/g, '""')}"`)
          .join(","),
      );
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `rekap-pesanan-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="page">
      <PageHeader
        title="Rekap operasional"
        subtitle="Ringkasan data pesanan tokomu yang diambil langsung dari catatan sistem."
        actions={
          <Button onClick={exportCsv} disabled={recap.orders.length === 0}>
            Ekspor tampilan (CSV)
          </Button>
        }
      />

      <InlineAlert tone="info">
        Rekap ini menampilkan {pageSize} pesanan terbaru yang sedang dimuat di layar kamu. Cocok untuk pantauan harian dan ekspor cepat.
      </InlineAlert>

      <div className="toolbar">
        <Button size="sm" onClick={() => setPageSize(50)} disabled={pageSize === 50}>
          50 pesanan
        </Button>
        <Button size="sm" onClick={() => setPageSize(100)} disabled={pageSize === 100}>
          100 pesanan
        </Button>
        <Button size="sm" onClick={() => setPageSize(200)} disabled={pageSize === 200}>
          200 pesanan
        </Button>
      </div>

      <QueryState state={state} loadingRows={4}>
        {() => (
          <>
            <div className="grid-4">
              <Stat label="Pesanan dimuat" value={recap.orders.length} note={`Maksimal ${pageSize}`} />
              <Stat label="Total tagihan" value={<span className="money">{formatIDR(recap.totalBilled)}</span>} note="Tanpa pesanan CANCELLED" />
              <Stat label="Sudah dibayar" value={<span className="money">{formatIDR(recap.totalPaid)}</span>} note="Pembayaran VOIDED tidak dihitung" />
              <Stat label="Sisa tagihan" value={<span className="money">{formatIDR(recap.totalOutstanding)}</span>} note="Bisa negatif bila lebih bayar" />
            </div>

            <div className="grid-2">
              <Panel>
                <PanelHead title="Komposisi status lifecycle" />
                <div className="panel-body stack-sm">
                  {[...recap.byStatus.entries()].map(([status, count]) => (
                    <div key={status} className="row-between">
                      <StatusBadge status={orderStatus(status)} />
                      <span className="money">{count}</span>
                    </div>
                  ))}
                  {recap.byStatus.size === 0 ? <p className="text-sm text-muted">Belum ada data.</p> : null}
                </div>
              </Panel>

              <Panel>
                <PanelHead title="Pesanan dengan konflik terbuka" />
                <div className="panel-body stack-sm">
                  {recap.orders.filter((order) => order.hasOpenConflict).length === 0 ? (
                    <p className="text-sm text-muted">Tidak ada pesanan bertanda konflik pada data yang dimuat.</p>
                  ) : (
                    recap.orders
                      .filter((order) => order.hasOpenConflict)
                      .map((order) => (
                        <div key={order.id} className="row-between">
                          <span className="mono">{order.orderNumber}</span>
                          <span className="text-sm text-muted">{formatDateTime(order.createdAt, timezone)}</span>
                        </div>
                      ))
                  )}
                </div>
              </Panel>
            </div>

            <Panel flush>
              <PanelHead title="Rincian pesanan yang dimuat" description="Sumber sama dengan daftar pesanan." />
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Nomor</th>
                      <th scope="col">Status</th>
                      <th scope="col" className="num">
                        Total
                      </th>
                      <th scope="col" className="num">
                        Dibayar
                      </th>
                      <th scope="col" className="num">
                        Sisa
                      </th>
                      <th scope="col">Dibuat</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recap.orders.map((order) => (
                      <tr key={order.id}>
                        <td className="mono">{order.orderNumber}</td>
                        <td>
                          <StatusBadge status={orderStatus(order.status)} />
                        </td>
                        <td className="num money">{formatIDR(order.totalAmount)}</td>
                        <td className="num money">{formatIDR(order.paidAmount)}</td>
                        <td className="num money">{formatIDR(order.outstandingAmount)}</td>
                        <td className="text-sm">{formatDateTime(order.createdAt, timezone)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          </>
        )}
      </QueryState>
    </div>
  );
}
