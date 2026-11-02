"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useMemo, useState } from "react";
import {
  catalogApi,
  reservationApi,
  type Schema,
} from "@/shared/api/endpoints";
import { describeApiError, extractConflicts, isConflict } from "@/shared/api/errors";
import { can, type Role } from "@/shared/auth/permissions";
import { useSession } from "@/shared/auth/session";
import { formatDateRange } from "@/shared/format/date";
import { reservationStatus } from "@/shared/format/status";
import { useApi } from "@/shared/hooks/useApi";
import { Button } from "@/shared/ui/buttons";
import { SelectInput } from "@/shared/ui/form";
import { ConfirmDialog, useToast } from "@/shared/ui/overlays";
import { Badge, PageHeader, Panel, PanelHead, StatusBadge } from "@/shared/ui/surfaces";
import { EmptyState, InlineAlert, QueryState } from "@/shared/ui/states";
import { Tabs } from "@/shared/ui/tabs";
import { BookingCalendar } from "./booking-calendar";
import { CreateReservationDialog } from "./create-reservation-dialog";

type Reservation = Schema<"ReservationResponse">;

export function BookingsPage() {
  const { tenantId, tenant, role } = useSession();
  const { notify } = useToast();
  const [tab, setTab] = useState("kalender");
  const [range, setRange] = useState(14);
  const [createOpen, setCreateOpen] = useState(false);
  const [conflictNotice, setConflictNotice] = useState<string | null>(null);

  const timezone = tenant?.timezone ?? "Asia/Jakarta";
  const canApprove = can(role as Role | undefined, "reservation.approve");
  const canCancel = can(role as Role | undefined, "reservation.cancel");
  const canCreate = can(role as Role | undefined, "reservation.create");
  const canConvert = can(role as Role | undefined, "order.create");

  const productsState = useApi(
    tenantId ? () => catalogApi.listProducts(tenantId) : null,
    [tenantId],
  );
  const reservationsState = useApi<Reservation[]>(
    tenantId ? () => reservationApi.list(tenantId) : null,
    [tenantId],
  );

  const products = useMemo(() => productsState.data ?? [], [productsState.data]);
  const reservations = useMemo(() => reservationsState.data ?? [], [reservationsState.data]);

  const productName = useMemo(() => {
    const map = new Map<string, string>();
    for (const product of products) if (product.id) map.set(product.id, product.name ?? product.id);
    return map;
  }, [products]);

  const days = useMemo(() => {
    const now = new Date();
    const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return Array.from({ length: range }, (_, index) => new Date(base + index * 86_400_000));
  }, [range]);

  const pending = reservations.filter((item) => item.status === "PENDING_APPROVAL");
  const sorted = [...reservations].sort(
    (a, b) => new Date(b.startAt ?? 0).getTime() - new Date(a.startAt ?? 0).getTime(),
  );

  return (
    <div className="page">
      <PageHeader
        title="Kalender & booking"
        subtitle="Pantau ketersediaan barang sewaan dan kelola pesanan booking pelanggan tokomu."
        actions={
          canCreate ? (
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              Buat booking
            </Button>
          ) : (
            <Badge tone="neutral">Hanya baca</Badge>
          )
        }
      />

      {conflictNotice ? (
        <InlineAlert tone="danger">
          <span role="alert">{conflictNotice}</span>
        </InlineAlert>
      ) : null}

      <Tabs
        items={[
          { id: "kalender", label: "Kalender ketersediaan" },
          { id: "pending", label: "Menunggu persetujuan", count: pending.length },
          { id: "semua", label: "Semua reservasi", count: reservations.length },
        ]}
        active={tab}
        onChange={setTab}
      >
        {tab === "kalender" ? (
          <div className="stack">
            <div className="toolbar">
              <SelectInput
                label="Rentang tampilan"
                value={String(range)}
                onChange={(event) => setRange(Number.parseInt(event.target.value, 10))}
              >
                <option value="7">7 hari</option>
                <option value="14">14 hari</option>
                <option value="30">30 hari</option>
              </SelectInput>
              <Button onClick={() => reservationsState.reload()} loading={reservationsState.loading}>
                Muat ulang
              </Button>
            </div>
            <QueryState state={reservationsState} loadingRows={5}>
              {() => (
                <BookingCalendar
                  days={days}
                  products={products}
                  reservations={reservations}
                  timezone={timezone}
                />
              )}
            </QueryState>
          </div>
        ) : (
          <Panel flush>
            <PanelHead
              title={tab === "pending" ? "Permintaan menunggu persetujuan" : "Semua reservasi"}
              description="Cek kembali jadwal sewa sebelum menyetujui agar tidak ada bentrok unit."
            />
            <QueryState
              state={reservationsState}
              loadingRows={5}
              empty={
                <EmptyState
                  title={tab === "pending" ? "Tidak ada permintaan menunggu" : "Belum ada reservasi"}
                  description={
                    tab === "pending"
                      ? "Semua permintaan booking sudah beres diproses."
                      : "Buat booking dari kalender atau menu kasir untuk memulai."
                  }
                />
              }
              isEmpty={(data) => (tab === "pending" ? data.every((item) => item.status !== "PENDING_APPROVAL") : data.length === 0)}
            >
              {() => (
                <ReservationTable
                  rows={tab === "pending" ? pending : sorted}
                  tenantId={tenantId ?? ""}
                  productName={productName}
                  timezone={timezone}
                  canApprove={canApprove}
                  canCancel={canCancel}
                  canConvert={canConvert}
                  onChanged={() => reservationsState.reload()}
                  onConflict={(message) => setConflictNotice(message)}
                  notify={notify}
                />
              )}
            </QueryState>
          </Panel>
        )}
      </Tabs>

      <CreateReservationDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        tenantId={tenantId}
        products={products}
        timezone={timezone}
        bookingMode={tenant?.bookingMode}
        onCreated={(reservation) => {
          setCreateOpen(false);
          reservationsState.reload();
          notify(
            reservation.status === "CONFIRMED"
              ? "Booking berhasil dikonfirmasi dan unit sudah diamankan!"
              : "Booking berhasil dibuat dan menunggu persetujuan.",
            "success",
          );
          setTab(reservation.status === "PENDING_APPROVAL" ? "pending" : "semua");
        }}
      />
    </div>
  );
}

function ReservationTable({
  rows,
  tenantId,
  productName,
  timezone,
  canApprove,
  canCancel,
  canConvert,
  onChanged,
  onConflict,
  notify,
}: {
  rows: Reservation[];
  tenantId: string;
  productName: Map<string, string>;
  timezone: string;
  canApprove: boolean;
  canCancel: boolean;
  canConvert: boolean;
  onChanged: () => void;
  onConflict: (message: string) => void;
  notify: (message: string, tone: "success" | "error") => void;
}) {
  const router = useRouter();
  const [rejecting, setRejecting] = useState<Reservation | null>(null);
  const [cancelling, setCancelling] = useState<Reservation | null>(null);
  const [busy, setBusy] = useState(false);

  const confirm = async (reservation: Reservation) => {
    if (!reservation.id || !tenantId) return;
    setBusy(true);
    try {
      await reservationApi.confirm(tenantId, reservation.id, {});
      notify("Booking dikonfirmasi.", "success");
      onChanged();
    } catch (error) {
      if (isConflict(error)) {
        const conflicts = extractConflicts(error);
        onConflict(
          conflicts.length > 0
            ? `Konflik ketersediaan: ${conflicts
                .map(
                  (conflict) =>
                    `${conflict.productName ?? "produk"} (${formatDateRange(conflict.startAt, conflict.endAt, timezone)})`,
                )
                .join("; ")}. Booking tidak dikonfirmasi.`
            : describeApiError(error),
        );
      } else {
        notify(describeApiError(error), "error");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Periode</th>
              <th scope="col">Item</th>
              <th scope="col">Mode</th>
              <th scope="col">Status booking</th>
              <th scope="col">Alokasi</th>
              <th scope="col" className="text-right">
                Aksi
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr className="table-empty">
                <td colSpan={6}>Tidak ada data.</td>
              </tr>
            ) : (
              rows.map((reservation) => (
                <tr key={reservation.id}>
                  <td>{formatDateRange(reservation.startAt, reservation.endAt, timezone)}</td>
                  <td>
                    {(reservation.items ?? []).map((item) => (
                      <div key={item.id} className="text-sm">
                        {productName.get(item.productId ?? "") ?? "Produk"} × {item.quantity ?? 0}
                      </div>
                    ))}
                  </td>
                  <td className="text-sm">{reservation.bookingMode === "MANUAL" ? "Manual" : "Otomatis"}</td>
                  <td>
                    <div className="cluster">
                      <StatusBadge status={reservationStatus(reservation.status)} />
                      {reservation.hasOpenConflict ? <Badge tone="danger">Konflik terbuka</Badge> : null}
                    </div>
                  </td>
                  <td className="text-sm">
                    {(reservation.allocations ?? []).filter((item) => item.status === "ACTIVE").length} aktif
                  </td>
                  <td>
                    <div className="table-actions">
                      {reservation.status === "PENDING_APPROVAL" && canApprove ? (
                        <Button size="sm" variant="primary" loading={busy} onClick={() => void confirm(reservation)}>
                          Setujui
                        </Button>
                      ) : null}
                      {reservation.status === "PENDING_APPROVAL" && canApprove ? (
                        <Button size="sm" variant="danger" onClick={() => setRejecting(reservation)}>
                          Tolak
                        </Button>
                      ) : null}
                      {reservation.status === "CONFIRMED" && canConvert ? (
                        <Button
                          size="sm"
                          onClick={async () => {
                            try {
                              const order = await reservationApi.convertToOrder(tenantId, reservation.id ?? "");
                              notify("Pesanan sewa berhasil dibuat dari reservasi.", "success");
                              if (order.id) router.push(`/app/orders/${order.id}`);
                            } catch (error) {
                              notify(describeApiError(error), "error");
                            }
                          }}
                        >
                          Buat pesanan
                        </Button>
                      ) : null}
                      {canCancel &&
                      reservation.status !== "CANCELLED" &&
                      reservation.status !== "REJECTED" &&
                      reservation.status !== "CONVERTED_TO_ORDER" ? (
                        <Button size="sm" variant="ghost" onClick={() => setCancelling(reservation)}>
                          Batalkan
                        </Button>
                      ) : null}
                      {reservation.status === "CONVERTED_TO_ORDER" ? (
                        <Link className="btn btn-sm btn-ghost" href="/app/orders">
                          Lihat pesanan
                        </Link>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={Boolean(rejecting)}
        onClose={() => setRejecting(null)}
        onConfirm={async (reason) => {
          const reservation = rejecting;
          if (!reservation?.id || !tenantId) return;
          setBusy(true);
          try {
            await reservationApi.reject(tenantId, reservation.id, { reason });
            notify("Permintaan booking ditolak.", "success");
            setRejecting(null);
            onChanged();
          } catch (error) {
            notify(describeApiError(error), "error");
          } finally {
            setBusy(false);
          }
        }}
        title="Tolak permintaan booking?"
        consequence="Status booking akan ditolak dan unit sewa tidak dialokasikan untuk pesanan ini."
        confirmLabel="Tolak booking"
        destructive
        requireReason
        busy={busy}
      />

      <ConfirmDialog
        open={Boolean(cancelling)}
        onClose={() => setCancelling(null)}
        onConfirm={async (reason) => {
          const reservation = cancelling;
          if (!reservation?.id || !tenantId) return;
          setBusy(true);
          try {
            await reservationApi.cancel(tenantId, reservation.id, { reason });
            notify("Reservasi dibatalkan dan unit sewa kembali tersedia.", "success");
            setCancelling(null);
            onChanged();
          } catch (error) {
            notify(describeApiError(error), "error");
          } finally {
            setBusy(false);
          }
        }}
        title="Batalkan reservasi?"
        consequence="Status booking akan dibatalkan dan unit sewa akan kembali tersedia untuk disewa pelanggan lain."
        confirmLabel="Batalkan reservasi"
        destructive
        requireReason
        busy={busy}
      />
    </>
  );
}

