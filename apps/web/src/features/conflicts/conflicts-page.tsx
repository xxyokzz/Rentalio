"use client";

import Link from "next/link";
import { useState } from "react";
import { extensionApi, type Schema } from "@/shared/api/endpoints";
import { describeApiError } from "@/shared/api/errors";
import { can, type Role } from "@/shared/auth/permissions";
import { useSession } from "@/shared/auth/session";
import { notifyExtensionActivity } from "@/shared/events/extension-activity";
import { formatDateRange, formatDateTime } from "@/shared/format/date";
import { useApi } from "@/shared/hooks/useApi";
import { Button, LinkButton } from "@/shared/ui/buttons";
import { SelectInput, TextArea } from "@/shared/ui/form";
import { Dialog, useToast } from "@/shared/ui/overlays";
import { Badge, PageHeader, Panel, PanelHead, Stat, StatusBadge } from "@/shared/ui/surfaces";
import { EmptyState, InlineAlert, QueryState } from "@/shared/ui/states";
import { invalidateConflictOverview, loadConflictOverview } from "./conflict-overview-cache";

type Overview = Schema<"ExtensionConflictOverview">;
type OverviewConflict = Schema<"ExtensionConflictOverviewConflict">;

interface FlatConflict {
  conflict: OverviewConflict;
  orderId: string;
  orderNumber: string;
  source: "ORDER" | "RESERVATION";
}

export function ConflictsPage() {
  const { tenantId, tenant, role } = useSession();
  const { notify } = useToast();
  const timezone = tenant?.timezone ?? "Asia/Jakarta";
  const canResolve = can(role as Role | undefined, "rental.extension.resolve_conflict");
  const [filter, setFilter] = useState<"OPEN" | "RESOLVED" | "ALL">("OPEN");
  const [target, setTarget] = useState<FlatConflict | null>(null);

  // Cache singkat berbagi hasil dengan badge menu Konflik perpanjangan, jadi
  // membuka halaman ini tidak memicu dua request identik.
  const state = useApi<Overview>(
    tenantId ? () => loadConflictOverview(tenantId, filter) : null,
    [tenantId, filter],
  );

  const flatten = (overview: Overview): FlatConflict[] => {
    const rows: FlatConflict[] = [];
    for (const order of overview.orders ?? []) {
      for (const conflict of order.conflicts ?? []) {
        rows.push({
          conflict,
          orderId: order.id ?? "",
          orderNumber: order.orderNumber ?? order.id ?? "",
          source: "ORDER",
        });
      }
    }
    if (rows.length === 0) {
      for (const reservation of overview.reservations ?? []) {
        for (const conflict of reservation.conflicts ?? []) {
          rows.push({
            conflict,
            orderId: conflict.orderId ?? "",
            orderNumber: conflict.orderId ? "—" : "Reservasi",
            source: "RESERVATION",
          });
        }
      }
    }
    return rows;
  };

  return (
    <div className="page">
      <PageHeader
        title="Konflik perpanjangan"
        subtitle="Pantau dan selesaikan jadwal perpanjangan sewa yang bentrok dengan jadwal sewa lainnya."
        actions={
          <LinkButton href="/app/orders">Pesanan</LinkButton>
        }
      />

      <div className="toolbar">
        <SelectInput
          label="Filter konflik"
          value={filter}
          onChange={(event) => setFilter(event.target.value as "OPEN" | "RESOLVED" | "ALL")}
        >
          <option value="OPEN">Perlu diselesaikan</option>
          <option value="RESOLVED">Sudah selesai</option>
          <option value="ALL">Semua</option>
        </SelectInput>
        <Button
          onClick={() => {
            // Aksi manual harus mengenai server: buang cache singkat dulu agar
            // klik "Muat ulang" tidak menyajikan hasil yang tersimpan ≤5 detik.
            invalidateConflictOverview();
            state.reload();
          }}
          loading={state.loading}
        >
          Muat ulang
        </Button>
      </div>

      <QueryState state={state} loadingRows={4}>
        {(overview) => {
          const rows = flatten(overview);
          return (
            <>
              <div className="grid-4">
                <Stat label="Konflik terbuka" value={overview.summary?.openConflicts ?? 0} />
                <Stat label="Konflik selesai" value={overview.summary?.resolvedConflicts ?? 0} />
                <Stat label="Pesanan bertanda" value={overview.summary?.flaggedOrders ?? 0} />
                <Stat label="Reservasi bertanda" value={overview.summary?.flaggedReservations ?? 0} />
              </div>

              <InlineAlert tone="info">
                Menyelesaikan catatan konflik di sini berfungsi sebagai tanda bahwa tim kamu sudah mengatur solusinya di lapangan (misalnya ganti unit atau koordinasi jadwal).
              </InlineAlert>

              <Panel flush>
                <PanelHead
                  title="Daftar konflik"
                  description="Daftar jadwal bentrok yang perlu koordinasi dan penanganan tim kamu."
                />
                {rows.length === 0 ? (
                  <EmptyState
                    title="Tidak ada konflik jadwal"
                    description="Semua jadwal sewa aman dan tidak ada bentrok."
                  />
                ) : (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th scope="col">Pesanan</th>
                          <th scope="col">Konflik dengan</th>
                          <th scope="col">Periode bentrok</th>
                          <th scope="col">Status</th>
                          <th scope="col">Penyelesaian</th>
                          <th scope="col" className="text-right">
                            Aksi
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row) => (
                          <tr key={row.conflict.id ?? `${row.orderId}-${row.conflict.createdAt}`}>
                            <td>
                              {row.orderId ? (
                                <Link className="mono" href={`/app/orders/${row.orderId}`}>
                                  {row.orderNumber}
                                </Link>
                              ) : (
                                <span className="text-sm text-muted">Reservasi</span>
                              )}
                              <div className="text-xs text-muted">
                                {row.conflict.extension?.overrideReason ?? "Override konflik"}
                              </div>
                            </td>
                            <td className="text-sm">
                              {row.conflict.summary?.productName ?? "Produk"}
                              <div className="text-xs text-muted">
                                {row.conflict.summary?.orderNumber
                                  ? `Pesanan ${row.conflict.summary.orderNumber}`
                                  : row.conflict.conflictingReservationId
                                    ? "Reservasi terdampak"
                                    : "Unit terdampak"}
                                {row.conflict.summary?.customerName
                                  ? ` · ${row.conflict.summary.customerName}`
                                  : ""}
                              </div>
                            </td>
                            <td className="text-sm">
                              {formatDateRange(
                                row.conflict.summary?.startAt,
                                row.conflict.summary?.endAt,
                                timezone,
                              )}
                              <div className="text-xs text-muted">
                                {row.conflict.summary?.reason === "CAPACITY_EXCEEDED"
                                  ? "Kapasitas terlampaui"
                                  : "Unit tumpang tindih"}
                              </div>
                            </td>
                            <td>
                              <Badge tone={row.conflict.status === "OPEN" ? "danger" : "success"}>
                                {row.conflict.status === "OPEN" ? "Terbuka" : "Selesai"}
                              </Badge>
                            </td>
                            <td className="text-sm">
                              {row.conflict.resolvedAt ? (
                                <>
                                  {formatDateTime(row.conflict.resolvedAt, timezone)}
                                  {row.conflict.resolutionNote ? (
                                    <div className="text-xs text-muted">{row.conflict.resolutionNote}</div>
                                  ) : null}
                                </>
                              ) : (
                                "—"
                              )}
                            </td>
                            <td>
                              <div className="table-actions">
                                {canResolve && row.conflict.status === "OPEN" && row.conflict.extensionId ? (
                                  <Button size="sm" onClick={() => setTarget(row)}>
                                    Tandai selesai
                                  </Button>
                                ) : null}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>
            </>
          );
        }}
      </QueryState>

      <ResolveDialog
        target={target}
        tenantId={tenantId}
        onClose={() => setTarget(null)}
        onSaved={() => {
          notify("Konflik ditandai selesai.", "success");
          // Badge konflik di menu ikut turun tanpa menunggu navigasi.
          notifyExtensionActivity();
          setTarget(null);
          state.reload();
        }}
        onError={(message) => notify(message, "error")}
      />
    </div>
  );
}

function ResolveDialog({
  target,
  tenantId,
  onClose,
  onSaved,
  onError,
}: {
  target: FlatConflict | null;
  tenantId: string | null;
  onClose: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!tenantId || !target?.conflict.extensionId || !target.conflict.id || !target.orderId) return;
    setBusy(true);
    try {
      await extensionApi.resolveConflict(
        tenantId,
        target.orderId,
        target.conflict.extensionId,
        target.conflict.id,
        { resolutionNote: note.trim() },
      );
      onSaved();
    } catch (caught) {
      onError(describeApiError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={Boolean(target)}
      onClose={onClose}
      title="Tandai konflik selesai"
      description="Pastikan solusi di lapangan sudah beres (misalnya unit pengganti sudah disiapkan atau jadwal sudah disepakati dengan pelanggan)."
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Batal
          </Button>
          <Button type="submit" form="resolve-conflict-page" variant="primary" loading={busy}>
            Tandai selesai
          </Button>
        </>
      }
    >
      <form id="resolve-conflict-page" className="stack" onSubmit={submit}>
        <StatusBadge status={{ label: target?.conflict.status ?? "OPEN", tone: "danger" }} />
        <TextArea
          label="Catatan penyelesaian (wajib)"
          required
          rows={3}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          hint="Tuliskan solusi yang diambil, misalnya: pakai unit cadangan atau koordinasi dengan pelanggan."
        />
      </form>
    </Dialog>
  );
}
