"use client";

import { useState } from "react";
import { tenantApi, type Schema } from "@/shared/api/endpoints";
import { describeApiError } from "@/shared/api/errors";
import { formatIDR } from "@/shared/format/currency";
import { formatDateTime } from "@/shared/format/date";
import { useApi } from "@/shared/hooks/useApi";
import { Button } from "@/shared/ui/buttons";
import { useToast, Dialog } from "@/shared/ui/overlays";
import { Badge } from "@/shared/ui/surfaces";
import { EmptyState, InlineAlert, LoadingBlock } from "@/shared/ui/states";

type Revision = Schema<"DamageFeeRevisionResponse">;

export interface CurrentDamagePolicy {
  inspectionEnabled: boolean;
  feeEnabled: boolean;
  minorAmount: string;
  moderateAmount: string;
  severeAmount: string;
  maxAmount: string;
}

const FIELDS = [
  { key: "inspectionEnabled", label: "Inspeksi kerusakan" },
  { key: "feeEnabled", label: "Denda kerusakan" },
  { key: "minorAmount", label: "Denda ringan" },
  { key: "moderateAmount", label: "Denda sedang" },
  { key: "severeAmount", label: "Denda parah" },
  { key: "maxAmount", label: "Plafon usulan" },
] as const;

function fieldValue(
  policy: CurrentDamagePolicy | Revision,
  key: (typeof FIELDS)[number]["key"],
): string | boolean {
  if (key === "inspectionEnabled") return policy.inspectionEnabled === true;
  if (key === "feeEnabled") return policy.feeEnabled === true;
  return (policy[key] as string | null | undefined) ?? "";
}

function display(key: (typeof FIELDS)[number]["key"], value: string | boolean): string {
  if (typeof value === "boolean") return value ? "Aktif" : "Nonaktif";
  if (key === "maxAmount") return value ? formatIDR(value) : "Tanpa plafon";
  return formatIDR(value || "0");
}

function changed(
  current: CurrentDamagePolicy,
  revision: Revision,
  key: (typeof FIELDS)[number]["key"],
): boolean {
  return String(fieldValue(current, key)) !== String(fieldValue(revision, key));
}

/**
 * Riwayat kebijakan denda (append-only) dengan perbandingan terhadap
 * pengaturan saat ini dan pemulihan revisi oleh owner.
 *
 * Pemulihan tidak menghapus revisi: server menulis revisi baru, dan batas total
 * denda per order tidak termasuk snapshot sehingga tetap seperti sekarang.
 */
export function DamageFeeHistory({
  tenantId,
  timezone,
  current,
  canRestore,
  onRestored,
}: {
  tenantId: string;
  timezone: string;
  current: CurrentDamagePolicy;
  canRestore: boolean;
  onRestored: () => Promise<void> | void;
}) {
  const { notify } = useToast();
  const state = useApi(() => tenantApi.listDamageFeeRevisions(tenantId), [tenantId]);
  const [comparingId, setComparingId] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<Revision | null>(null);
  const [busy, setBusy] = useState(false);
  const revisions = state.data ?? [];
  const comparing = revisions.find((revision) => revision.id === comparingId) ?? null;

  const restore = async () => {
    if (!restoring?.id) return;
    setBusy(true);
    try {
      await tenantApi.restoreDamageFeeRevision(tenantId, restoring.id);
      notify("Kebijakan denda dipulihkan ke revisi terpilih.", "success");
      setRestoring(null);
      setComparingId(null);
      state.reload();
      await onRestored();
    } catch (caught) {
      notify(describeApiError(caught), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack-sm">
      <div>
        <p className="text-sm">
          <strong>Riwayat kebijakan denda</strong>
        </p>
        <p className="text-xs text-muted">
          Lima puluh perubahan terakhir, terbaru lebih dulu. Bandingkan dengan pengaturan saat ini
          sebelum memulihkan.
        </p>
      </div>
      <div className="stack-sm">
          {state.error ? <InlineAlert tone="warning">{describeApiError(state.error)}</InlineAlert> : null}
          {state.initialLoading ? <LoadingBlock rows={2} /> : null}
          {!state.initialLoading && revisions.length === 0 ? (
            <EmptyState
              title="Belum ada riwayat"
              description="Riwayat tercatat saat pengaturan inspeksi atau denda kerusakan disimpan."
            />
          ) : null}
          {revisions.map((revision) => {
            const changedFields = FIELDS.filter((field) => changed(current, revision, field.key));
            const isChanged = changedFields.length > 0;
            return (
              <div key={revision.id} className="stack-sm" style={{ borderTop: "1px solid var(--sw-border)" }}>
                <div className="row-between">
                  <div>
                    <span className="text-sm">{formatDateTime(revision.createdAt, timezone)}</span>
                    <span className="text-xs text-muted mono" style={{ marginLeft: 8 }}>
                      {revision.actorUserId?.slice(0, 8) ?? "—"}
                    </span>
                  </div>
                  <div className="toolbar">
                    <Badge tone={revision.feeEnabled ? "success" : "neutral"}>
                      {revision.feeEnabled ? "Denda aktif" : "Denda nonaktif"}
                    </Badge>
                    {isChanged ? <Badge tone="warning">{changedFields.length} beda</Badge> : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setComparingId(comparingId === revision.id ? null : (revision.id ?? null))}
                    >
                      {comparingId === revision.id ? "Tutup" : "Bandingkan"}
                    </Button>
                    {canRestore ? (
                      <Button size="sm" variant="secondary" onClick={() => setRestoring(revision)}>
                        Pulihkan
                      </Button>
                    ) : null}
                  </div>
                </div>

                <div className="text-xs text-muted">
                  Ringan {formatIDR(revision.minorAmount)} · Sedang {formatIDR(revision.moderateAmount)} ·
                  Parah {formatIDR(revision.severeAmount)} · Plafon{" "}
                  {revision.maxAmount ? formatIDR(revision.maxAmount) : "tanpa plafon"}
                </div>

                {comparingId === revision.id ? (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th scope="col">Pengaturan</th>
                          <th scope="col">Saat ini</th>
                          <th scope="col">Revisi ini</th>
                        </tr>
                      </thead>
                      <tbody>
                        {FIELDS.map((field) => {
                          const differs = changed(current, revision, field.key);
                          return (
                            <tr key={field.key}>
                              <th scope="row">
                                {field.label}
                                {differs ? <Badge tone="warning">berubah</Badge> : null}
                              </th>
                              <td className={differs ? "money" : "money text-muted"}>
                                {display(field.key, fieldValue(current, field.key))}
                              </td>
                              <td className={differs ? "money" : "money text-muted"}>
                                {display(field.key, fieldValue(revision, field.key))}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </div>
            );
          })}
          {!canRestore && revisions.length > 0 ? (
            <p className="text-xs text-muted">Hanya owner yang dapat memulihkan revisi.</p>
          ) : null}
        </div>

      <Dialog
        open={Boolean(restoring)}
        onClose={() => setRestoring(null)}
        title="Pulihkan kebijakan denda?"
        description="Pengaturan inspeksi, saklar denda, nominal per tingkat, dan plafon akan diganti dengan nilai revisi ini."
        footer={
          <>
            <Button onClick={() => setRestoring(null)} disabled={busy}>
              Batal
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void restore()}>
              Pulihkan revisi
            </Button>
          </>
        }
      >
        <div className="stack-sm">
          <InlineAlert tone="info">
            Batas total denda per order tidak termasuk revisi, jadi nilainya tidak berubah. Revisi
            lama tetap tersimpan sebagai riwayat.
          </InlineAlert>
          {restoring ? (
            <p className="text-sm">
              {formatDateTime(restoring.createdAt, timezone)} — ringan{" "}
              {formatIDR(restoring.minorAmount)}, sedang {formatIDR(restoring.moderateAmount)}, parah{" "}
              {formatIDR(restoring.severeAmount)}
              {restoring.maxAmount ? `, plafon ${formatIDR(restoring.maxAmount)}` : ", tanpa plafon"}.
            </p>
          ) : null}
        </div>
      </Dialog>
    </div>
  );
}
