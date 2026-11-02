"use client";

import Link from "next/link";
import { orderApi, returnApi, type Schema } from "@/shared/api/endpoints";
import { formatDateTime } from "@/shared/format/date";
import { orderStatus, returnStatus } from "@/shared/format/status";
import { useSession } from "@/shared/auth/session";
import { useApi } from "@/shared/hooks/useApi";
import { LinkButton } from "@/shared/ui/buttons";
import { PageHeader, Panel, PanelHead, Stat, StatusBadge } from "@/shared/ui/surfaces";
import { EmptyState, InlineAlert, QueryState } from "@/shared/ui/states";

interface ReturnRow {
  orderId: string;
  orderNumber: string;
  orderStatus?: string;
  record: Schema<"ReturnRecordResponse">;
}

interface ReturnsData {
  rows: ReturnRow[];
  activeOrders: Schema<"OrderResponse">[];
  waitingReturn: Schema<"OrderResponse">[];
}

export function ReturnsPage() {
  const { tenantId, tenant } = useSession();
  const timezone = tenant?.timezone ?? "Asia/Jakarta";

  const state = useApi<ReturnsData>(
    tenantId
      ? async () => {
          const [active, returning] = await Promise.all([
            orderApi.list(tenantId, { status: "ACTIVE", pageSize: 50 }),
            orderApi.list(tenantId, { status: "RETURN_IN_PROGRESS", pageSize: 50 }),
          ]);
          const orders = [...active.data, ...returning.data];
          const lists = await Promise.all(
            orders.map((order) =>
              returnApi
                .list(tenantId, order.id ?? "")
                .then((records) => records.map((record) => ({
                  orderId: order.id ?? "",
                  orderNumber: order.orderNumber ?? order.id ?? "",
                  orderStatus: order.status,
                  record,
                })))
                .catch(() => []),
            ),
          );
          return {
            rows: lists.flat().sort(
              (a, b) =>
                new Date(b.record.createdAt ?? 0).getTime() - new Date(a.record.createdAt ?? 0).getTime(),
            ),
            activeOrders: active.data,
            waitingReturn: returning.data,
          };
        }
      : null,
    [tenantId],
  );

  const pending = state.data?.rows.filter((row) => row.record.status === "PENDING") ?? [];

  return (
    <div className="page">
      <PageHeader
        title="Pengembalian & inspeksi"
        subtitle="Pantau barang yang sedang disewa atau dalam proses dikembalikan oleh pelanggan."
        actions={<LinkButton href="/app/orders">Semua pesanan</LinkButton>}
      />

      <InlineAlert tone="info">
        Alur pengembalian: terima barang sewaan, periksa kondisinya, dan catat denda jika ada kerusakan atau keterlambatan.
      </InlineAlert>

      <QueryState state={state} loadingRows={5}>
        {(data) => (
          <>
            <div className="grid-3">
              <Stat label="Sedang disewa" value={data.activeOrders.length} note="Barang di pelanggan" />
              <Stat label="Proses kembali" value={data.waitingReturn.length} note="Menunggu dicek" />
              <Stat label="Perlu diselesaikan" value={pending.length} note="Belum selesai" />
            </div>

            <Panel flush>
              <PanelHead
                title="Pengembalian tercatat"
                description="Selesaikan pengembalian setelah barang benar-benar diterima dan kondisinya dicatat."
              />
              <QueryState
                state={{ ...state, data: data.rows }}
                isEmpty={(rows) => rows.length === 0}
                empty={
                  <EmptyState
                    title="Belum ada pengembalian"
                    description="Buka detail pesanan ACTIVE untuk mencatat pengembalian item."
                  />
                }
              >
                {(rows) => (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th scope="col">Pesanan</th>
                          <th scope="col">Dibuat</th>
                          <th scope="col">Diterima</th>
                          <th scope="col">Item</th>
                          <th scope="col">Status pengembalian</th>
                          <th scope="col" className="text-right">
                            Aksi
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row) => (
                          <tr key={`${row.orderId}-${row.record.id}`}>
                            <td>
                              <Link className="mono" href={`/app/orders/${row.orderId}`}>
                                {row.orderNumber}
                              </Link>
                            </td>
                            <td className="text-sm">{formatDateTime(row.record.createdAt, timezone)}</td>
                            <td className="text-sm">
                              {row.record.returnedAt ? formatDateTime(row.record.returnedAt, timezone) : "—"}
                            </td>
                            <td className="text-sm">
                              {(row.record.items ?? []).map((item) => (
                                <div key={item.id}>
                                  {item.assetId ? `Unit ${item.assetId}` : item.productId} × {item.quantity}
                                  {item.conditionNote ? (
                                    <div className="text-xs text-muted">{item.conditionNote}</div>
                                  ) : null}
                                </div>
                              ))}
                            </td>
                            <td>
                              <StatusBadge status={returnStatus(row.record.status)} />
                            </td>
                            <td>
                              <div className="table-actions">
                                <LinkButton size="sm" href={`/app/orders/${row.orderId}`}>
                                  Buka pesanan
                                </LinkButton>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </QueryState>
            </Panel>

            <Panel flush>
              <PanelHead
                title="Pesanan aktif menunggu pengembalian"
                description="Pembayaran belum lunas tidak menghalangi pencatatan pengembalian."
              />
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Nomor</th>
                      <th scope="col">Status</th>
                      <th scope="col" className="num">
                        Sisa tagihan
                      </th>
                      <th scope="col" className="text-right">
                        Aksi
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.activeOrders.length === 0 ? (
                      <tr className="table-empty">
                        <td colSpan={4}>Tidak ada pesanan ACTIVE.</td>
                      </tr>
                    ) : (
                      data.activeOrders.map((order) => (
                        <tr key={order.id}>
                          <td className="mono">{order.orderNumber}</td>
                          <td>
                            <StatusBadge status={orderStatus(order.status)} />
                          </td>
                          <td className="num money">{order.outstandingAmount}</td>
                          <td>
                            <div className="table-actions">
                              <LinkButton size="sm" href={`/app/orders/${order.id}`}>
                                Catat pengembalian
                              </LinkButton>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
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
