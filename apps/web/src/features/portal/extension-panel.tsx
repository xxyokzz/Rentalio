"use client";

import { useMemo, useState } from "react";
import { portalApi, type Schema } from "@/shared/api/endpoints";
import { describeApiError } from "@/shared/api/errors";
import { formatIDR } from "@/shared/format/currency";
import { formatDateTime, isoToZonedLocal, zonedLocalToIso } from "@/shared/format/date";
import type { StatusDescriptor } from "@/shared/format/status";
import { TextArea, TextInput } from "@/shared/ui/form";
import { InlineAlert } from "@/shared/ui/states";
import { Badge, Panel, PanelBody, PanelHead } from "@/shared/ui/surfaces";

type PortalOrder = Schema<"PortalOrderResponse">;
export type PortalExtension = NonNullable<PortalOrder["extensions"]>[number];

export function extensionStatus(status: string | undefined): StatusDescriptor {
  switch (status) {
    case "PENDING_APPROVAL":
      return { label: "Menunggu keputusan admin", tone: "warning" };
    case "APPROVED":
      return { label: "Disetujui", tone: "success" };
    case "REJECTED":
      return { label: "Ditolak", tone: "danger" };
    default:
      return { label: status ?? "Tidak diketahui", tone: "neutral" };
  }
}

/**
 * Panel perpanjangan sewa di portal (Notion 14). Formulir hanya mengirim
 * tanggal akhir baru: biaya, periode sebelumnya, dan konflik dihitung server.
 * Setelah dikirim, status permintaan dibaca ulang dari server sehingga tamu
 * melihat keputusan staff walau menutup halaman.
 */
export function ExtensionPanel({
  token,
  order,
  timezone,
  onSubmitted,
}: {
  token: string;
  order: PortalOrder;
  timezone: string;
  onSubmitted?: () => void;
}) {
  const currentEndAt = order.reservation?.endAt ?? null;
  const extensions: PortalExtension[] = order.extensions ?? [];
  const pending = extensions.find((extension) => extension.status === "PENDING_APPROVAL") ?? null;
  const canRequest = Boolean(order.order) && Boolean(order.extensionsEnabled) && !pending;

  const minimumEnd = useMemo(() => {
    if (!currentEndAt) return "";
    // Minimal satu menit setelah akhir sewa berjalan.
    const next = new Date(new Date(currentEndAt).getTime() + 60_000);
    return isoToZonedLocal(next.toISOString(), timezone);
  }, [currentEndAt, timezone]);

  const [value, setValue] = useState(minimumEnd);
  const [note, setNote] = useState("");
  // Validasi klien ditampilkan apa adanya; galat API lewat `describeApiError`
  // karena bentuknya bukan pesan siap pakai.
  const [formError, setFormError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<unknown>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setFormError(null);
    setApiError(null);
    setMessage(null);
    const requestedEndAt = zonedLocalToIso(value, timezone);
    if (!requestedEndAt) {
      setFormError("Isi tanggal dan jam pengembalian baru.");
      return;
    }
    if (!currentEndAt || new Date(requestedEndAt) <= new Date(currentEndAt)) {
      setFormError("Tanggal akhir baru harus setelah tanggal akhir sewa saat ini.");
      return;
    }

    setBusy(true);
    try {
      const result = await portalApi.requestExtension(token, {
        requestedEndAt,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setMessage(
        `Pengajuan terkirim. Perkiraan biaya ${formatIDR(result.extension.amount ?? null)} dan menunggu keputusan admin toko.`,
      );
      setNote("");
      onSubmitted?.();
    } catch (caught) {
      setApiError(caught);
    } finally {
      setBusy(false);
    }
  };

  // Fitur nonaktif, pesanan belum dibuat, dan tidak ada riwayat → tidak ada
  // yang bisa ditampilkan; jangan tampilkan panel kosong yang membingungkan.
  if (!order.extensionsEnabled && extensions.length === 0) return null;

  return (
    <Panel>
      <PanelHead
        title="Perpanjangan sewa"
        description={
          currentEndAt
            ? `Sewa berjalan sampai ${formatDateTime(currentEndAt, timezone)}.`
            : undefined
        }
      />

      <PanelBody>
        {extensions.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Diajukan</th>
                  <th scope="col">Sampai</th>
                  <th scope="col">Biaya</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {extensions.map((extension) => {
                  const status = extensionStatus(extension.status);
                  return (
                    <tr key={extension.id ?? `${extension.requestedEndAt}`}>
                      <td>{formatDateTime(extension.createdAt, timezone)}</td>
                      <td>{formatDateTime(extension.requestedEndAt, timezone)}</td>
                      <td className="money">{formatIDR(extension.amount ?? null)}</td>
                      <td>
                        <Badge tone={status.tone}>{status.label}</Badge>
                        {extension.decisionReason ? (
                          <p className="text-xs text-muted">Catatan: {extension.decisionReason}</p>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted">Belum ada pengajuan perpanjangan.</p>
        )}

        {pending ? (
          <InlineAlert tone="warning">
            Permintaan perpanjangan sampai{" "}
            {formatDateTime(pending.requestedEndAt, timezone)} sedang menunggu keputusan admin toko.
            Jadwal sewa belum berubah sampai disetujui.
          </InlineAlert>
        ) : null}

        {!order.order ? (
          <InlineAlert tone="info">
            Perpanjangan tersedia setelah pesanan dibuat dan diserahkan oleh admin toko.
          </InlineAlert>
        ) : !order.extensionsEnabled ? (
          <InlineAlert tone="info">
            Toko ini belum membuka pengajuan perpanjangan. Silakan hubungi admin via WhatsApp.
          </InlineAlert>
        ) : null}

        {canRequest ? (
          <div className="stack-sm" style={{ marginTop: "var(--sw-space-4)" }}>
            <h3 className="panel-title">Ajukan perpanjangan</h3>
            <TextInput
              label="Kembali sampai"
              type="datetime-local"
              value={value}
              min={minimumEnd}
              required
              onChange={(event) => setValue(event.target.value)}
            />
            <TextArea
              label="Catatan (opsional)"
              rows={2}
              maxLength={500}
              value={note}
              placeholder="Misalnya: masih menunggu acara selesai."
              onChange={(event) => setNote(event.target.value)}
            />
            <p className="text-xs text-muted">
              Biaya perpanjangan dihitung otomatis oleh sistem dan baru ditagihkan setelah
              disetujui admin toko. Jadwal sewa tidak berubah selama masih menunggu.
            </p>

            {formError ? <InlineAlert tone="danger">{formError}</InlineAlert> : null}
            {apiError ? <InlineAlert tone="danger">{describeApiError(apiError)}</InlineAlert> : null}
            {message ? <InlineAlert tone="info">{message}</InlineAlert> : null}

            <div className="cluster">
              <button className="btn" type="button" onClick={submit} disabled={busy}>
                {busy ? "Mengirim…" : "Kirim pengajuan"}
              </button>
            </div>
          </div>
        ) : null}
      </PanelBody>
    </Panel>
  );
}
