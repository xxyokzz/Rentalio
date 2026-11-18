"use client";

import { useState } from "react";
import { portalApi, type Schema } from "@/shared/api/endpoints";
import { describeApiError } from "@/shared/api/errors";
import { formatIDR } from "@/shared/format/currency";
import { inspectionStatus } from "@/shared/format/status";
import { Button } from "@/shared/ui/buttons";
import { TextArea } from "@/shared/ui/form";
import { Panel, PanelBody, PanelHead, StatusBadge } from "@/shared/ui/surfaces";
import { InlineAlert } from "@/shared/ui/states";

type Inspection = NonNullable<Schema<"PortalOrderResponse">["inspection"]>;

/**
 * Hasil inspeksi untuk penyewa: nominal denda dan tombol sanggah.
 *
 * Sanggahan tidak mengubah nominal; status menjadi DISPUTED dan menunggu
 * keputusan ulang toko. Denda juga tidak bisa ditagihkan selama sengketa.
 */
export function DisputePanel({
  token,
  inspection,
  onSubmitted,
}: {
  token: string;
  inspection: Inspection | null | undefined;
  onSubmitted: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!inspection) return null;

  const submit = async () => {
    if (reason.trim().length < 5) {
      setError("Tuliskan alasan singkat (minimal 5 karakter).");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await portalApi.disputeInspection(token, inspection.id ?? "", { reason: reason.trim() });
      setReason("");
      onSubmitted();
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel>
      <PanelHead
        title="Hasil inspeksi pengembalian"
        description="Denda kerusakan ditagihkan terpisah dari biaya sewa dan hanya setelah disetujui toko."
      />
      <PanelBody>
        <div className="stack">
          <div className="table-wrap">
            <table className="table">
              <tbody>
                <tr>
                  <th scope="row">Status</th>
                  <td>
                    <StatusBadge status={inspectionStatus(inspection.status)} />
                  </td>
                </tr>
                <tr>
                  <th scope="row">Denda</th>
                  <td className="money">{formatIDR(inspection.penaltyAmount ?? null)}</td>
                </tr>
                {inspection.summary ? (
                  <tr>
                    <th scope="row">Catatan toko</th>
                    <td className="text-sm">{inspection.summary}</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          {inspection.status === "DISPUTED" ? (
            <InlineAlert tone="warning">
              Sanggahan sudah tercatat
              {inspection.disputeReason ? `: “${inspection.disputeReason}”` : "."} Toko akan meninjau
              ulang sebelum denda ditagihkan.
            </InlineAlert>
          ) : inspection.canDispute ? (
            <div className="stack-sm">
              <TextArea
                label="Sanggah hasil inspeksi"
                rows={3}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                hint="Jelaskan bagian yang menurutmu tidak sesuai. Sanggahan tercatat beserta waktunya."
              />
              {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
              <div className="form-actions">
                <Button variant="secondary" loading={busy} onClick={() => void submit()}>
                  Ajukan sanggahan
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </PanelBody>
    </Panel>
  );
}
