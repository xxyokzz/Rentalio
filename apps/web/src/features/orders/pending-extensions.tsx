"use client";

import Link from "next/link";
import { useState } from "react";
import { describeApiError, extractConflicts, isConflict } from "@/shared/api/errors";
import { extensionApi, type Schema } from "@/shared/api/endpoints";
import { can, type Role } from "@/shared/auth/permissions";
import { useSession } from "@/shared/auth/session";
import { notifyExtensionActivity } from "@/shared/events/extension-activity";
import { formatIDR } from "@/shared/format/currency";
import { formatDateRange, formatDateTime } from "@/shared/format/date";
import { extensionStatus, orderStatus } from "@/shared/format/status";
import { useApi } from "@/shared/hooks/useApi";
import { Button, LinkButton } from "@/shared/ui/buttons";
import { ConfirmDialog, useToast } from "@/shared/ui/overlays";
import { Panel, PanelHead, StatusBadge } from "@/shared/ui/surfaces";
import { EmptyState, InlineAlert, QueryState } from "@/shared/ui/states";

type PendingExtension = Schema<"TenantExtensionRequest">;

/**
 * Antrean keputusan perpanjangan lintas order (satu tempat untuk semua
 * permintaan yang menunggu), dipasang di halaman Pesanan.
 *
 * Hanya tampil bagi pengguna dengan `rental.extension.approve`; keputusan
 * tetap lewat command approve/reject per order sehingga aturan ketersediaan
 * dan override konflik dihitung server — panel ini tidak memutuskan apa pun
 * di sisi klien.
 */
export function PendingExtensionsPanel({ tenantId }: { tenantId: string }) {
  const { role, tenant } = useSession();
  const { notify } = useToast();
  const timezone = tenant?.timezone ?? "Asia/Jakarta";
  const canApprove = can(role as Role | undefined, "rental.extension.approve");

  const [rejecting, setRejecting] = useState<PendingExtension | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const state = useApi(
    canApprove && tenantId ? () => extensionApi.listTenant(tenantId) : null,
    [tenantId, canApprove],
  );

  if (!canApprove) return null;

  const approve = async (row: PendingExtension) => {
    if (!row.id || !row.orderId) return;
    setBusyId(row.id);
    try {
      await extensionApi.approve(tenantId, row.orderId, row.id, {});
      notify("Perpanjangan disetujui dan periode diperbarui secara atomik.", "success");
      // Badge navigasi memuat ulang tanpa menunggu pindah halaman.
      notifyExtensionActivity();
      state.reload();
    } catch (caught) {
      if (isConflict(caught)) {
        const conflicts = extractConflicts(caught);
        notify(
          conflicts.length > 0
            ? "Konflik ketersediaan: perpanjangan tidak disetujui. Buka detail pesanan untuk meninjau periode bentrok."
            : describeApiError(caught),
          "error",
        );
      } else {
        notify(describeApiError(caught), "error");
      }
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="stack">
      <Panel flush>
        <PanelHead
          title="Permintaan perpanjangan menunggu keputusan"
          description="Daftar lintas pesanan, terlama lebih dulu. Persetujuan menghitung ulang biaya dan mengalokasikan periode tambahan secara atomik; penolakan tidak mengubah pesanan."
        />
        <QueryState
          state={state}
          loadingRows={3}
          isEmpty={(data) => data.length === 0}
          empty={
            <EmptyState
              title="Tidak ada permintaan yang menunggu keputusan"
              description="Pengajuan baru dari staf atau portal penyewa akan muncul di sini."
            />
          }
        >
          {(rows) => (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Pesanan</th>
                    <th scope="col">Periode diminta</th>
                    <th scope="col" className="num">
                      Biaya
                    </th>
                    <th scope="col">Status</th>
                    <th scope="col">Diajukan</th>
                    <th scope="col" className="text-right">
                      Aksi
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id ?? `${row.orderId}-${row.createdAt}`}>
                      <td>
                        <Link className="mono" href={`/app/orders/${row.orderId ?? ""}`}>
                          {row.order?.orderNumber ?? row.orderId}
                        </Link>
                        {row.order?.customerName ? (
                          <div className="text-xs text-muted">{row.order.customerName}</div>
                        ) : null}
                        {row.order?.status ? (
                          <div className="text-xs text-muted">
                            {orderStatus(row.order.status).label}
                          </div>
                        ) : null}
                      </td>
                      <td className="text-sm">
                        {formatDateRange(row.previousEndAt, row.requestedEndAt, timezone)}
                      </td>
                      <td className="num money">{formatIDR(row.amount)}</td>
                      <td>
                        <StatusBadge status={extensionStatus(row.status)} />
                      </td>
                      <td className="text-sm">{formatDateTime(row.createdAt, timezone)}</td>
                      <td>
                        <div className="table-actions">
                          <Button
                            size="sm"
                            variant="primary"
                            loading={busyId === row.id}
                            disabled={busyId !== null && busyId !== row.id}
                            onClick={() => void approve(row)}
                          >
                            Setujui
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={busyId !== null}
                            onClick={() => setRejecting(row)}
                          >
                            Tolak
                          </Button>
                          <LinkButton size="sm" href={`/app/orders/${row.orderId ?? ""}`}>
                            Detail
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

      <InlineAlert tone="info">
        Persetujuan dari daftar ini memakai aturan yang sama dengan halaman detail pesanan: bila ada
        bentrok ketersediaan, permintaan tetap ditolak server dan penyelesaiannya (unit pengganti
        atau override berizin) dilakukan dari detail pesanan.
      </InlineAlert>

      <ConfirmDialog
        open={Boolean(rejecting)}
        onClose={() => setRejecting(null)}
        onConfirm={async (reason) => {
          if (!rejecting?.id || !rejecting.orderId) return;
          setBusyId(rejecting.id);
          try {
            await extensionApi.reject(tenantId, rejecting.orderId, rejecting.id, { reason });
            notify("Perpanjangan ditolak.", "success");
            notifyExtensionActivity();
            setRejecting(null);
            state.reload();
          } catch (caught) {
            notify(describeApiError(caught), "error");
          } finally {
            setBusyId(null);
          }
        }}
        title="Tolak perpanjangan?"
        consequence="Status menjadi REJECTED. Periode, alokasi, dan biaya pesanan tidak berubah."
        confirmLabel="Tolak perpanjangan"
        destructive
        requireReason
        busy={busyId !== null}
      />
    </div>
  );
}
