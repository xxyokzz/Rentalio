"use client";

import Link from "next/link";
import { useState } from "react";
import { orderApi, type OrderStatus } from "@/shared/api/endpoints";
import { useSession } from "@/shared/auth/session";
import { formatIDR } from "@/shared/format/currency";
import { formatDateTime } from "@/shared/format/date";
import { orderStatus } from "@/shared/format/status";
import { useApi } from "@/shared/hooks/useApi";
import { LinkButton } from "@/shared/ui/buttons";
import { SelectInput } from "@/shared/ui/form";
import { Badge, PageHeader, Panel, PanelHead, StatusBadge } from "@/shared/ui/surfaces";
import { EmptyState, InlineAlert, QueryState } from "@/shared/ui/states";
import { Pagination } from "@/shared/ui/tabs";
import { PendingExtensionsPanel } from "./pending-extensions";

const STATUSES: OrderStatus[] = [
  "CONFIRMED",
  "READY_FOR_HANDOVER",
  "ACTIVE",
  "RETURN_IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
];

export function OrdersPage() {
  const { tenantId, tenant } = useSession();
  const timezone = tenant?.timezone ?? "Asia/Jakarta";
  const [status, setStatus] = useState<OrderStatus | "">("");
  const [page, setPage] = useState(1);
  const pageSize = 20;

  const state = useApi(
    tenantId
      ? () =>
          orderApi.list(tenantId, {
            ...(status ? { status } : {}),
            page,
            pageSize,
          })
      : null,
    [tenantId, status, page],
  );

  return (
    <div className="page">
      <PageHeader
        title="Pesanan"
        subtitle="Pantau daftar pesanan sewa, status pembayaran, dan jadwal pengembalian barang tokomu."
        actions={<LinkButton href="/app/pos" variant="primary">Buat pesanan</LinkButton>}
      />

      <PendingExtensionsPanel tenantId={tenantId ?? ""} />

      <div className="toolbar">
        <SelectInput
          label="Status pesanan"
          value={status}
          onChange={(event) => {
            setStatus(event.target.value as OrderStatus | "");
            setPage(1);
          }}
        >
          <option value="">Semua status</option>
          {STATUSES.map((item) => (
            <option key={item} value={item}>
              {orderStatus(item).label}
            </option>
          ))}
        </SelectInput>
      </div>

      <Panel flush>
        <PanelHead title="Daftar pesanan" description="Pagination dan filter dijalankan server-side." />
        <QueryState
          state={state}
          loadingRows={6}
          isEmpty={(data) => data.data.length === 0}
          empty={
            <EmptyState
              title="Belum ada pesanan"
              description="Pesanan dibuat dari reservasi CONFIRMED melalui kasir atau halaman booking."
            />
          }
        >
          {(data) => (
            <>
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
                      <th scope="col" className="text-right">
                        Aksi
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.data.map((order) => (
                      <tr key={order.id}>
                        <td>
                          <Link className="mono" href={`/app/orders/${order.id}`}>
                            {order.orderNumber ?? order.id}
                          </Link>
                          {order.hasOpenConflict ? (
                            <div>
                              <Badge tone="danger">Konflik terbuka</Badge>
                            </div>
                          ) : null}
                        </td>
                        <td>
                          <StatusBadge status={orderStatus(order.status)} />
                        </td>
                        <td className="num money">{formatIDR(order.totalAmount)}</td>
                        <td className="num money">{formatIDR(order.paidAmount)}</td>
                        <td className="num money">{formatIDR(order.outstandingAmount)}</td>
                        <td className="text-sm">{formatDateTime(order.createdAt, timezone)}</td>
                        <td>
                          <div className="table-actions">
                            <LinkButton size="sm" href={`/app/orders/${order.id}`}>
                              Detail
                            </LinkButton>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="panel-foot">
                <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPageChange={setPage} />
              </div>
            </>
          )}
        </QueryState>
      </Panel>

      <InlineAlert tone="info">
        Status pembayaran tidak otomatis mengubah status lifecycle. Pembayaran lunas hanya setelah petugas
        berwenang mencatat penerimaan/verifikasi.
      </InlineAlert>
    </div>
  );
}
