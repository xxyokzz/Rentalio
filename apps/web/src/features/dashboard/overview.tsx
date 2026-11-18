"use client";

import Link from "next/link";
import { useMemo, useSyncExternalStore } from "react";
import {
  orderApi,
  reservationApi,
  catalogApi,
  type OrderStatus,
  type Schema,
} from "@/shared/api/endpoints";
import { loadConflictOverview } from "@/features/conflicts/conflict-overview-cache";
import { loadReceivableAging } from "@/features/reports/receivable-aging-cache";
import { useSession } from "@/shared/auth/session";
import { formatIDR } from "@/shared/format/currency";
import { formatDateRange } from "@/shared/format/date";
import { orderStatus, reservationStatus, type StatusDescriptor } from "@/shared/format/status";
import { useApi } from "@/shared/hooks/useApi";
import { LinkButton } from "@/shared/ui/buttons";
import { Icon, type IconName } from "@/shared/ui/icons";
import { StatusBadge } from "@/shared/ui/surfaces";
import { EmptyState, QueryState } from "@/shared/ui/states";

interface OverviewData {
  reservations: Schema<"ReservationResponse">[];
  orders: Schema<"OrderResponse">[];
  products: Schema<"ProductResponse">[];
  openConflicts: number | null;
  aging: Schema<"ReceivableAgingResponse"> | null;
}

interface QueueEntry {
  key: string;
  kind: "pending" | "ready" | "active";
  icon: IconName;
  title: string;
  meta: string;
  status: StatusDescriptor;
  href: string;
  action: string;
}

function greetingFor(timezone: string): string {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      hour12: false,
      timeZone: timezone,
    }).format(new Date()),
  );
  if (hour < 11) return "Selamat pagi";
  if (hour < 15) return "Selamat siang";
  if (hour < 19) return "Selamat sore";
  return "Selamat malam";
}

function todayFor(timezone: string): string {
  return new Intl.DateTimeFormat("id-ID", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: timezone,
  }).format(new Date());
}

export function DashboardOverview() {
  const { tenantId, tenant, role } = useSession();
  const timezone = tenant?.timezone ?? "Asia/Jakarta";
  // Waktu dirender hanya di klien: server dan klien bisa berada di zona berbeda.
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const today = mounted ? todayFor(timezone) : null;
  const greeting = mounted ? greetingFor(timezone) : "Halo";

  const state = useApi<OverviewData>(
    tenantId
      ? async () => {
          const [reservations, orders, products, conflicts, aging] = await Promise.all([
            reservationApi.list(tenantId),
            orderApi.list(tenantId, { pageSize: 100 }),
            catalogApi.listProducts(tenantId),
            // Cache singkat yang sama dipakai badge dan halaman konflik, jadi
            // membuka Ringkasan tidak menambah request ringkasan kedua.
            loadConflictOverview(tenantId, "OPEN").catch(() => null),
            // Cache singkat yang sama dipakai badge; gagal baca tidak memblokir
            // ringkasan operasional.
            loadReceivableAging(tenantId).catch(() => null),
          ]);
          return {
            reservations,
            orders: orders.data,
            products,
            openConflicts: conflicts?.summary?.openConflicts ?? null,
            aging,
          };
        }
      : null,
    [tenantId],
  );

  const metrics = useMemo(() => {
    const data = state.data;
    if (!data) return null;
    const pending = data.reservations.filter((item) => item.status === "PENDING_APPROVAL");
    const ready = data.orders.filter((item) => item.status === "READY_FOR_HANDOVER");
    const active = data.orders.filter((item) => item.status === "ACTIVE");
    const outstanding = data.orders.filter(
      (item) => Number(item.outstandingAmount ?? 0) > 0 && item.status !== "CANCELLED",
    );
    const outstandingTotal = outstanding.reduce(
      (sum, item) => sum + Number(item.outstandingAmount ?? 0),
      0,
    );
    const activeProducts = data.products.filter((item) => item.isActive !== false);
    const unpriced = data.products.filter((item) => !item.rate?.perDayAmount);
    return { pending, ready, active, outstanding, outstandingTotal, activeProducts, unpriced };
  }, [state.data]);

  const queue = useMemo<QueueEntry[]>(() => {
    if (!metrics || !state.data) return [];
    const entries: QueueEntry[] = [];

    for (const order of metrics.ready.slice(0, 3)) {
      entries.push({
        key: `ready-${order.id}`,
        kind: "ready",
        icon: "check",
        title: order.orderNumber ?? "Pesanan tanpa nomor",
        meta: `Siap diserahkan · total ${formatIDR(order.totalAmount)}`,
        status: orderStatus(order.status as OrderStatus),
        href: `/app/orders/${order.id}`,
        action: "Serahkan",
      });
    }

    for (const reservation of metrics.pending.slice(0, 3)) {
      entries.push({
        key: `pending-${reservation.id}`,
        kind: "pending",
        icon: "clock",
        title: formatDateRange(reservation.startAt, reservation.endAt, timezone),
        meta: `${reservation.items?.length ?? 0} item · menunggu persetujuan`,
        status: reservationStatus(reservation.status),
        href: "/app/bookings",
        action: "Tinjau",
      });
    }

    for (const order of metrics.active.slice(0, 3)) {
      entries.push({
        key: `active-${order.id}`,
        kind: "active",
        icon: "box",
        title: order.orderNumber ?? "Pesanan tanpa nomor",
        meta: `Sedang disewa · sisa ${formatIDR(order.outstandingAmount)}`,
        status: orderStatus(order.status as OrderStatus),
        href: `/app/orders/${order.id}`,
        action: "Buka",
      });
    }

    return entries.slice(0, 6);
  }, [metrics, state.data, timezone]);

  const attentionCount =
    (metrics?.pending.length ?? 0) +
    (metrics?.ready.length ?? 0) +
    (metrics?.outstanding.length ?? 0) +
    (state.data?.openConflicts ?? 0) +
    (state.data?.aging?.alertCount ?? 0);

  return (
    <div className="page">
      <header className="dash-head">
        <div>
          <div className="dash-eyebrow">
            <span className="dash-dot" aria-hidden="true" />
            <span className="dash-tenant">{tenant?.name ?? "Workspace"}</span>
            <span className="crumb-sep" aria-hidden="true">
              ·
            </span>
            {today ?? "Hari ini"}
            {tenant?.timezone ? ` · ${tenant.timezone.replace("Asia/", "")}` : ""}
          </div>
          <h1 className="dash-title">
            {greeting}<span className="dash-period">.</span>
          </h1>
          <p className="dash-sub">
            {attentionCount > 0
              ? `${attentionCount} hal perlu kamu cek hari ini. Cek antrean di bawah ya:`
              : "Semua aman dan terkendali! Ini ringkasan operasional tokomu hari ini."}
          </p>
        </div>
        <div className="dash-actions">
          <LinkButton href="/app/bookings">
            <Icon name="calendar" size={16} />
            Kalender booking
          </LinkButton>
          <LinkButton href="/app/pos" variant="primary">
            <Icon name="register" size={16} />
            Buka kasir
          </LinkButton>
        </div>
      </header>

      <QueryState state={state} loadingRows={4}>
        {(data) => (
          <>
            <div className="focus-strip">
              <Link
                className="focus-item"
                href="/app/bookings"
                data-tone={metrics && metrics.pending.length > 0 ? "warning" : undefined}
              >
                <span className="focus-top">
                  <span className="focus-icon">
                    <Icon name="clock" size={17} />
                  </span>
                  <Icon name="arrow-up-right" size={15} className="focus-arrow" />
                </span>
                <span className="focus-value">{metrics?.pending.length ?? 0}</span>
                <span className="focus-label">Menunggu persetujuan</span>
                <span className="focus-note">Permintaan booking baru yang belum dikonfirmasi</span>
              </Link>

              <Link
                className="focus-item"
                href="/app/orders"
                data-tone={metrics && metrics.ready.length > 0 ? "success" : undefined}
              >
                <span className="focus-top">
                  <span className="focus-icon">
                    <Icon name="check" size={17} />
                  </span>
                  <Icon name="arrow-up-right" size={15} className="focus-arrow" />
                </span>
                <span className="focus-value">{metrics?.ready.length ?? 0}</span>
                <span className="focus-label">Siap serah-terima</span>
                <span className="focus-note">Pesanan sudah oke, siap diambil pelanggan</span>
              </Link>

              <Link className="focus-item" href="/app/orders">
                <span className="focus-top">
                  <span className="focus-icon">
                    <Icon name="box" size={17} />
                  </span>
                  <Icon name="arrow-up-right" size={15} className="focus-arrow" />
                </span>
                <span className="focus-value">{metrics?.active.length ?? 0}</span>
                <span className="focus-label">Sedang disewa</span>
                <span className="focus-note">Barang masih dibawa dan dipakai pelanggan</span>
              </Link>

              <Link
                className="focus-item"
                href="/app/conflicts"
                data-tone={data.openConflicts ? "danger" : undefined}
              >
                <span className="focus-top">
                  <span className="focus-icon">
                    <Icon name="alert" size={17} />
                  </span>
                  <Icon name="arrow-up-right" size={15} className="focus-arrow" />
                </span>
                <span className="focus-value">{data.openConflicts ?? "—"}</span>
                <span className="focus-label">Konflik perpanjangan</span>
                <span className="focus-note">
                  {data.openConflicts === null
                    ? "Tidak tersedia untuk peran akunmu"
                    : "Ada jadwal sewa yang tabrakan dan perlu dicek"}
                </span>
              </Link>
            </div>

            <div className="dash-grid">
              <section className="panel panel-flush" aria-labelledby="queue-title">
                <header className="panel-head">
                  <div>
                    <h2 className="panel-title" id="queue-title">
                      Antrean hari ini
                    </h2>
                    <p className="text-sm text-muted">
                      Jadwal serah-terima barang, konfirmasi booking baru, dan pesanan aktif.
                    </p>
                  </div>
                  <div className="cluster">
                    <LinkButton size="sm" href="/app/orders">
                      Semua pesanan
                    </LinkButton>
                  </div>
                </header>

                {queue.length === 0 ? (
                  <div className="queue-empty">
                    <span className="queue-empty-icon">
                      <Icon name="check" size={18} />
                    </span>
                    <p className="empty-title">Belum ada antrean</p>
                    <p className="text-sm text-muted">
                      Santai sejenak, saat ini belum ada pesanan atau jadwal yang perlu ditangani.
                    </p>
                  </div>
                ) : (
                  <div className="queue-list">
                    {queue.map((entry) => (
                      <Link className="queue-row" href={entry.href} key={entry.key}>
                        <span className="queue-icon" data-kind={entry.kind}>
                          <Icon name={entry.icon} size={17} />
                        </span>
                        <span className="queue-copy">
                          <span className="queue-title">{entry.title}</span>
                          <span className="queue-meta">{entry.meta}</span>
                        </span>
                        <span className="queue-side">
                          <StatusBadge status={entry.status} />
                          <span className="queue-action">{entry.action} →</span>
                        </span>
                      </Link>
                    ))}
                  </div>
                )}
              </section>

              <aside className="dash-rail">
                <section className="rail-panel" aria-labelledby="readiness-title">
                  <div className="rail-head">
                    <h2 className="rail-title" id="readiness-title">
                      Kesiapan katalog
                    </h2>
                    <Link className="rail-link" href="/app/inventory">
                      Kelola
                    </Link>
                  </div>

                  {data.products.length === 0 ? (
                    <EmptyState
                      title="Belum ada produk"
                      description="Tambahkan kategori dan produk agar penyewa dapat melihat katalog."
                      action={
                        <LinkButton href="/app/inventory" variant="primary" size="sm">
                          Tambah produk
                        </LinkButton>
                      }
                    />
                  ) : (
                    <>
                      <div className="readiness-value">
                        <b>
                          {metrics?.activeProducts.length ?? 0}
                          <span> / {data.products.length}</span>
                        </b>
                        <span>produk aktif</span>
                      </div>
                      <div
                        className="progress"
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={data.products.length}
                        aria-valuenow={metrics?.activeProducts.length ?? 0}
                        aria-label="Produk aktif dari total produk"
                      >
                        <span
                          style={{
                            width: `${Math.round(
                              ((metrics?.activeProducts.length ?? 0) / data.products.length) * 100,
                            )}%`,
                          }}
                        />
                      </div>
                      <div className="readiness-meta">
                        <span>
                          Total <b>{data.products.length}</b>
                        </span>
                        <span>
                          Belum bertarif <b>{metrics?.unpriced.length ?? 0}</b>
                        </span>
                      </div>
                      {role && role !== "OWNER" ? (
                        <p className="rail-note" style={{ marginTop: 10 }}>
                          Perubahan katalog memerlukan izin tulis katalog.
                        </p>
                      ) : null}
                    </>
                  )}
                </section>

                <section className="rail-panel" aria-labelledby="attention-title">
                  <div className="rail-head">
                    <h2 className="rail-title" id="attention-title">
                      Perlu perhatian
                    </h2>
                  </div>
                  {attentionCount === 0 ? (
                    <p className="rail-empty">
                      <Icon name="check" size={16} />
                      Tidak ada saldo atau konflik tertunggak.
                    </p>
                  ) : (
                    <div className="rail-list">
                      {(metrics?.outstanding.length ?? 0) > 0 ? (
                        <Link className="rail-item" href="/app/orders">
                          <Icon name="wallet" size={16} />
                          <span>
                            <b>{metrics?.outstanding.length}</b> pesanan masih bersaldo
                          </span>
                          <span className="badge badge-warning">
                            {formatIDR(metrics?.outstandingTotal)}
                          </span>
                        </Link>
                      ) : null}
                      {(data.aging?.outstanding?.overdueOrders ?? 0) > 0 ? (
                        <Link className="rail-item" href="/app/reports/damage-fees">
                          <Icon name="wallet" size={16} />
                          <span>
                            <b>{data.aging?.outstanding?.overdueOrders}</b> tagihan menua &gt;{" "}
                            {data.aging?.thresholds?.invoiceDays} hari
                          </span>
                          <span className="badge badge-warning">
                            {formatIDR(data.aging?.outstanding?.overdueAmount)}
                          </span>
                        </Link>
                      ) : null}
                      {(data.aging?.penalties?.agedOrders ?? 0) > 0 ? (
                        <Link className="rail-item" href="/app/reports/damage-fees">
                          <Icon name="alert" size={16} />
                          <span>
                            <b>{data.aging?.penalties?.agedOrders}</b> denda menggantung
                          </span>
                          <span className="badge badge-warning">
                            {formatIDR(data.aging?.penalties?.agedAmount)}
                          </span>
                        </Link>
                      ) : null}
                      {data.openConflicts ? (
                        <Link className="rail-item" href="/app/conflicts">
                          <Icon name="alert" size={16} />
                          <span>
                            <b>{data.openConflicts}</b> konflik perpanjangan
                          </span>
                          <span className="badge badge-danger">Selesaikan</span>
                        </Link>
                      ) : null}
                    </div>
                  )}
                  <p className="rail-note" style={{ marginTop: 12 }}>
                    Status pembayaran terpisah dari status sewa. Pembayaran lunas hanya setelah
                    petugas mencatat penerimaan.
                  </p>
                </section>
              </aside>
            </div>
          </>
        )}
      </QueryState>
    </div>
  );
}
