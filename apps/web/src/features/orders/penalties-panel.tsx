"use client";

import { useState } from "react";
import { orderApi, type Schema } from "@/shared/api/endpoints";
import { describeApiError } from "@/shared/api/errors";
import { useSession } from "@/shared/auth/session";
import { formatIDR } from "@/shared/format/currency";
import { formatDateTime } from "@/shared/format/date";
import { Button } from "@/shared/ui/buttons";
import { ConfirmDialog, useToast } from "@/shared/ui/overlays";
import { Badge, Panel, PanelBody, PanelHead } from "@/shared/ui/surfaces";
import { EmptyState } from "@/shared/ui/states";

type Order = Schema<"OrderResponse">;
type Penalty = NonNullable<Schema<"OrderResponse">["penalties"]>[number];

/**
 * Daftar denda kerusakan yang tercatat pada order.
 *
 * Denda VOIDED tetap ditampilkan sebagai riwayat (beserta alasannya) tetapi
 * tidak menambah tagihan. Pembatalan hanya untuk OWNER/MANAGER — sama dengan
 * aturan server, jadi UI tidak menawarkan aksi yang pasti ditolak.
 */
export function PenaltiesPanel({
  tenantId,
  order,
  onChanged,
}: {
  tenantId: string;
  order: Order;
  onChanged: () => void;
}) {
  const { role, tenant } = useSession();
  const { notify } = useToast();
  const timezone = tenant?.timezone ?? "Asia/Jakarta";
  const canVoid = role === "OWNER" || role === "MANAGER";
  const [voiding, setVoiding] = useState<Penalty | null>(null);
  const [busy, setBusy] = useState(false);

  const penalties = order.penalties ?? [];
  const recordedTotal = penalties
    .filter((penalty) => penalty.status !== "VOIDED")
    .reduce((sum, penalty) => sum + Number.parseInt(penalty.amount ?? "0", 10), 0);

  const submitVoid = async (reason: string) => {
    if (!voiding?.id || !reason) return;
    setBusy(true);
    try {
      await orderApi.voidPenalty(tenantId, order.id ?? "", voiding.id, reason);
      notify("Denda dibatalkan dan dikeluarkan dari tagihan.", "success");
      setVoiding(null);
      onChanged();
    } catch (caught) {
      notify(describeApiError(caught), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel>
      <PanelHead
        title="Denda kerusakan"
        description={`Denda tercatat: ${formatIDR(String(recordedTotal))}. Tagihan ini terpisah dari harga sewa.`}
      />
      <PanelBody>
        {penalties.length === 0 ? (
          <EmptyState
            title="Belum ada denda"
            description="Denda dibuat dari keputusan inspeksi yang disetujui pada tab Pengembalian & inspeksi."
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Tanggal</th>
                  <th scope="col">Nominal</th>
                  <th scope="col">Alasan</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="text-right">
                    Aksi
                  </th>
                </tr>
              </thead>
              <tbody>
                {penalties.map((penalty) => (
                  <tr key={penalty.id}>
                    <td className="text-sm">
                      {penalty.createdAt ? formatDateTime(penalty.createdAt, timezone) : "—"}
                    </td>
                    <td className="num money">{formatIDR(penalty.amount)}</td>
                    <td className="text-sm">
                      {penalty.reason ?? "—"}
                      {penalty.status === "VOIDED" && penalty.voidedReason ? (
                        <div className="text-xs text-muted">
                          Dibatalkan: {penalty.voidedReason}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      {penalty.status === "VOIDED" ? (
                        <Badge tone="neutral">Dibatalkan</Badge>
                      ) : (
                        <Badge tone="info">Tercatat</Badge>
                      )}
                    </td>
                    <td>
                      <div className="table-actions">
                        {canVoid && penalty.status !== "VOIDED" ? (
                          <Button size="sm" variant="ghost" onClick={() => setVoiding(penalty)}>
                            Batalkan
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
      </PanelBody>

      <ConfirmDialog
        open={Boolean(voiding)}
        onClose={() => setVoiding(null)}
        onConfirm={submitVoid}
        title="Batalkan denda ini?"
        consequence="Denda dikeluarkan dari total tagihan dan tidak bisa diaktifkan kembali; baris serta alasannya tetap tersimpan sebagai riwayat."
        confirmLabel="Batalkan denda"
        requireReason
        busy={busy}
      >
        <p className="text-sm text-muted">
          Nominal: {formatIDR(voiding?.amount)}. Jika denda sudah dipakai untuk potongan deposit, tolak
          atau batalkan potongan itu secara terpisah.
        </p>
      </ConfirmDialog>
    </Panel>
  );
}
