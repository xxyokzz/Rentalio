"use client";

import Link from "next/link";
import { portalApi, type Schema } from "@/shared/api/endpoints";
import { ExtensionPanel } from "./extension-panel";
import { DisputePanel } from "./dispute-panel";
import { describeApiError } from "@/shared/api/errors";
import { formatIDR } from "@/shared/format/currency";
import { formatDateRange, formatDateTime } from "@/shared/format/date";
import { methodLabel, orderStatus, reservationStatus } from "@/shared/format/status";
import { useApi } from "@/shared/hooks/useApi";
import { whatsappShareUrl } from "@/shared/whatsapp";
import { EmptyState, InlineAlert, LoadingBlock } from "@/shared/ui/states";
import { Badge, PageHeader, Panel, PanelBody, PanelHead, StatusBadge } from "@/shared/ui/surfaces";

type PortalOrder = Schema<"PortalOrderResponse">;

function portalQuestion(order: PortalOrder): string {
  const tenantName = order.tenant?.name ?? "tenant";
  const reference = order.reservation?.reference ?? "-";
  const outstanding = order.summary?.outstandingAmount;
  const lines = [
    `Halo Admin ${tenantName}, saya ingin menanyakan pesanan saya.`,
    "",
    `Referensi: ${reference}`,
    outstanding ? `Sisa tagihan: ${formatIDR(outstanding)}` : "",
    "",
    "Terima kasih.",
  ];
  return lines.filter((line) => line !== "").join("\n");
}

/**
 * Portal pesanan berbasis token (Notion 14): hanya status pesanan, rincian
 * item, sisa tagihan, dan instruksi pembayaran. Satu-satunya aksi dari sisi
 * penyewa adalah menyanggah hasil inspeksi; pencatatan pembayaran tetap
 * dilakukan petugas.
 */
export function PortalPage({ token }: { token: string }) {
  const state = useApi(() => portalApi.getOrder(token), [token]);

  if (state.initialLoading) {
    return (
      <div className="public-main">
        <EmptyState title="Memuat pesanan…" description="Memeriksa tautan portal." />
        <LoadingBlock rows={3} />
      </div>
    );
  }

  if (state.error) {
    const notFound =
      typeof state.error === "object" &&
      state.error !== null &&
      "status" in state.error &&
      (state.error as { status?: number }).status === 404;

    return (
      <div className="public-main">
        <PageHeader
          title={notFound ? "Link pesanan tidak ditemukan" : "Gagal memuat pesanan"}
          subtitle={
            notFound
              ? "Link mungkin salah, sudah kedaluwarsa, atau sudah diganti dengan link baru."
              : "Koneksi ke server terputus. Silakan coba beberapa saat lagi ya."
          }
        />
        <InlineAlert tone={notFound ? "warning" : "danger"}>
          {describeApiError(state.error)}
        </InlineAlert>
        <p className="text-sm text-muted">
          Hubungi admin toko kamu untuk mendapatkan link pesanan terbaru.
        </p>
        <div className="cluster">
          {notFound ? null : <button className="btn" type="button" onClick={() => state.reload()}>Coba lagi</button>}
          <Link className="btn btn-ghost" href="/">
            Kembali ke beranda
          </Link>
        </div>
      </div>
    );
  }

  const order = state.data;
  if (!order) {
    return (
      <div className="public-main">
        <EmptyState title="Pesanan tidak ditemukan" />
      </div>
    );
  }

  const tenant = order.tenant;
  const timezone = tenant?.timezone ?? "Asia/Jakarta";
  const reservation = order.reservation;
  const totals = order.summary;
  const outstanding = Number.parseInt(totals?.outstandingAmount ?? "0", 10);
  const portalPath = `/portal/${token}`;

  return (
    <div className="public-main">
      <PageHeader
        breadcrumb={<span>Pesanan saya</span>}
        title={tenant?.name ?? "Pesanan kamu"}
        subtitle={
          reservation?.reference
            ? `Nomor referensi ${reservation.reference} · link aktif sampai ${formatDateTime(
                order.portalExpiresAt,
                timezone,
              )}`
            : undefined
        }
        actions={
          <a
            className="btn btn-secondary btn-sm"
            href={whatsappShareUrl(portalQuestion(order), tenant?.whatsappNumber)}
            target="_blank"
            rel="noreferrer noopener"
          >
            Tanya admin via WhatsApp
          </a>
        }
      />

      <div className="cluster">
        <StatusBadge status={reservationStatus(reservation?.status)} />
        {order.order ? <StatusBadge status={orderStatus(order.order.status)} /> : null}
        <Badge tone="neutral">
          {reservation?.bookingMode === "AUTOMATIC" ? "Booking otomatis" : "Booking manual"}
        </Badge>
        {order.guestName ? (
          <span className="text-sm text-muted">a.n. {order.guestName}</span>
        ) : null}
      </div>

      {reservation?.status === "PENDING_APPROVAL" ? (
        <InlineAlert tone="warning">
          Pesanan booking kamu sedang menunggu konfirmasi dari admin toko. Cek halaman ini secara berkala ya.
        </InlineAlert>
      ) : null}
      {reservation?.status === "CONFIRMED" && !order.order ? (
        <InlineAlert tone="info">
          Pesanan sewa kamu sudah dikonfirmasi! Silakan hubungi admin toko via WhatsApp untuk konfirmasi jadwal serah-terima.
        </InlineAlert>
      ) : null}
      {reservation?.status === "REJECTED" || reservation?.status === "CANCELLED" ? (
        <InlineAlert tone="danger">
          Pesanan ini dibatalkan atau ditolak. Hubungi admin toko jika kamu ingin mengajukan jadwal atau barang lain.
        </InlineAlert>
      ) : null}

      <div className="portal-layout">
        <Panel>
          <PanelHead title="Rincian sewa" description={formatDateRange(reservation?.startAt, reservation?.endAt, timezone)} />
          <PanelBody>
            {reservation?.items?.length ? (
              <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Barang</th>
                    <th scope="col">Jumlah</th>
                    <th scope="col">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {reservation.items.map((item, index) => (
                    <tr key={`${item.name ?? "item"}-${index}`}>
                      <td>{item.name ?? "—"}</td>
                      <td>{item.quantity ?? 0}</td>
                      <td className="money">{formatIDR(item.lineTotal ?? null)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            ) : (
              <EmptyState title="Belum ada item" />
            )}
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHead
            title="Pembayaran"
            description="Pembayaran kamu akan dicek dan dicatat langsung oleh tim toko."
          />
          <PanelBody>
            <dl className="definition-list">
              <dt>Total</dt>
              <dd className="money">{formatIDR(totals?.totalAmount ?? null)}</dd>
              <dt>Sudah dibayar</dt>
              <dd className="money">{formatIDR(totals?.paidAmount ?? null)}</dd>
              <dt>Sisa tagihan</dt>
              <dd className="money">{formatIDR(totals?.outstandingAmount ?? null)}</dd>
            </dl>

            <div className="stack-sm" style={{ marginTop: "var(--sw-space-4)" }}>
              <h3 className="panel-title">Metode pembayaran aktif</h3>
              {order.paymentMethods?.length ? (
                <div className="cluster">
                  {order.paymentMethods.map((method) => (
                    <Badge key={method} tone="neutral">
                      {methodLabel(method).label}
                    </Badge>
                  ))}
                </div>
              ) : (
                <InlineAlert tone="warning">
                  Toko belum mengatur metode pembayaran otomatis. Silakan hubungi admin via WhatsApp.
                </InlineAlert>
              )}
            </div>

            {outstanding > 0 && tenant?.bankTransferInstructions ? (
              <div className="stack-sm" style={{ marginTop: "var(--sw-space-4)" }}>
                <h3 className="panel-title">Instruksi transfer</h3>
                <p className="text-sm" style={{ whiteSpace: "pre-wrap" }}>
                  {tenant.bankTransferInstructions}
                </p>
              </div>
            ) : null}

            {outstanding > 0 && tenant?.qrisImageUrl ? (
              <div className="stack-sm" style={{ marginTop: "var(--sw-space-4)" }}>
                <h3 className="panel-title">QRIS</h3>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={tenant.qrisImageUrl}
                  alt={`QRIS ${tenant.name ?? "tenant"}`}
                  className="qris-image"
                />
                <p className="text-xs text-muted">
                  Pastikan nama toko sesuai sebelum transfer atau scan QRIS ya.
                </p>
              </div>
            ) : null}

            {outstanding <= 0 ? (
              <InlineAlert tone="info">Tagihan sudah lunas! Terima kasih banyak.</InlineAlert>
            ) : !tenant?.bankTransferInstructions && !tenant?.qrisImageUrl ? (
              <InlineAlert tone="info">
                Detail rekening atau QRIS belum dicantumkan. Silakan hubungi admin toko via WhatsApp untuk cara pembayaran.
              </InlineAlert>
            ) : null}
          </PanelBody>
        </Panel>
      </div>

      <DisputePanel
        token={token}
        inspection={order.inspection}
        onSubmitted={() => state.reload()}
      />

      <ExtensionPanel
        token={token}
        order={order}
        timezone={timezone}
        onSubmitted={() => state.reload()}
      />

      {order.order?.payments?.length ? (
        <Panel>
          <PanelHead title="Riwayat pembayaran" description="Pembayaran yang sudah diverifikasi oleh tim toko." />
          <PanelBody>
            <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Tanggal</th>
                  <th scope="col">Metode</th>
                  <th scope="col">Nominal</th>
                </tr>
              </thead>
              <tbody>
                {order.order.payments.map((payment, index) => (
                  <tr key={`${payment.recordedAt ?? "payment"}-${index}`}>
                    <td>{formatDateTime(payment.recordedAt, timezone)}</td>
                    <td>{methodLabel(payment.method).label}</td>
                    <td className="money">{formatIDR(payment.amount ?? null)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </PanelBody>
        </Panel>
      ) : null}

      <Panel>
        <PanelBody>
          <h2 className="panel-title">Catatan keamanan</h2>
          <p className="text-sm text-muted">
            Link ini khusus untuk pesanan kamu. Jangan bagikan ke orang lain ya. Kalau butuh bantuan, hubungi admin toko kamu langsung.
          </p>
          <p className="text-xs text-muted mono">{portalPath}</p>
        </PanelBody>
      </Panel>
    </div>
  );
}
