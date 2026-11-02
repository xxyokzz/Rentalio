"use client";

import { useState } from "react";
import { orderApi, type Schema } from "@/shared/api/endpoints";
import { describeApiError } from "@/shared/api/errors";
import { can, type Role } from "@/shared/auth/permissions";
import { useSession } from "@/shared/auth/session";
import { formatDateTime } from "@/shared/format/date";
import { collateralStatus, collateralType } from "@/shared/format/status";
import { Button } from "@/shared/ui/buttons";
import { TextArea, TextInput } from "@/shared/ui/form";
import { ConfirmDialog, useToast } from "@/shared/ui/overlays";
import { Badge, Panel, PanelHead, StatusBadge } from "@/shared/ui/surfaces";
import { EmptyState, InlineAlert } from "@/shared/ui/states";

type Order = Schema<"OrderResponse">;
type Collateral = Schema<"CollateralResponse">;

/**
 * Tab Jaminan: ID card penyewa sebagai jaminan utama, dan jaminan lain
 * (dokumen/barang) sebagai opsional. Jaminan uang tidak di sini — uang tetap
 * memakai ledger deposit yang ditampilkan terpisah pada panel "Jaminan uang".
 */
export function CollateralPanel({
  tenantId,
  order,
  onChanged,
}: {
  tenantId: string;
  order: Order;
  onChanged: () => void;
}) {
  const { role } = useSession();
  const { notify } = useToast();
  const canManage = can(role as Role | undefined, "deposit.receive");

  const collaterals = (order.collaterals ?? []) as Collateral[];
  const heldIdCard = collaterals.find((c) => c.type === "ID_CARD" && c.status === "HELD");
  const otherHeld = collaterals.filter((c) => c.type === "OTHER" && c.status === "HELD");
  const otherReturned = collaterals.filter((c) => c.type === "OTHER" && c.status === "RETURNED");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [returning, setReturning] = useState<Collateral | null>(null);

  // Form ID card
  const [idLabel, setIdLabel] = useState("KTP");
  const [idNumber, setIdNumber] = useState("");
  const [idName, setIdName] = useState("");

  // Form jaminan lain
  const [otherLabel, setOtherLabel] = useState("");
  const [otherDesc, setOtherDesc] = useState("");

  const run = async (action: () => Promise<unknown>, success: string) => {
    setError(null);
    setBusy(true);
    try {
      await action();
      notify(success, "success");
      onChanged();
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setBusy(false);
    }
  };

  const recordIdCard = () =>
    void run(async () => {
      await orderApi.createCollateral(tenantId, order.id ?? "", {
        type: "ID_CARD",
        label: idLabel.trim() || "KTP",
        ...(idNumber.trim() ? { documentNumber: idNumber.trim() } : {}),
        ...(idName.trim() ? { description: `Nama penyewa: ${idName.trim()}` } : {}),
      });
      setIdNumber("");
      setIdName("");
    }, "ID card dicatat sebagai jaminan utama.");

  const recordOther = () =>
    void run(async () => {
      await orderApi.createCollateral(tenantId, order.id ?? "", {
        type: "OTHER",
        label: otherLabel.trim(),
        ...(otherDesc.trim() ? { description: otherDesc.trim() } : {}),
      });
      setOtherLabel("");
      setOtherDesc("");
    }, "Jaminan lain dicatat.");

  return (
    <div className="stack">
      {error ? (
        <InlineAlert tone="danger">
          <span role="alert">{error}</span>
        </InlineAlert>
      ) : null}

      {/* ---------------- Jaminan utama: ID card ---------------- */}
      <Panel>
        <PanelHead
          title="Jaminan utama — ID card penyewa"
          description="ID card (KTP/SIM/dll.) dipegang sebagai jaminan utama selama masa sewa. Maksimal satu ID card aktif per pesanan."
          actions={
            heldIdCard ? (
              <Badge tone="info">Tercatat</Badge>
            ) : (
              <Badge tone="neutral">Belum dicatat</Badge>
            )
          }
        />
        <div className="panel-body stack">
          {heldIdCard ? (
            <div className="stack-sm">
              <div className="row-between">
                <div>
                  <div className="text-sm">
                    <strong>{heldIdCard.label}</strong>
                    {heldIdCard.documentNumber ? (
                      <span className="text-muted"> · No. {heldIdCard.documentNumber}</span>
                    ) : null}
                  </div>
                  {heldIdCard.description ? (
                    <div className="text-sm text-muted">{heldIdCard.description}</div>
                  ) : null}
                  <div className="text-xs text-muted">
                    Ditahan sejak {formatDateTime(heldIdCard.heldAt ?? heldIdCard.createdAt, "Asia/Jakarta")}
                  </div>
                </div>
                <div className="cluster">
                  <StatusBadge status={collateralStatus(heldIdCard.status)} />
                  {canManage ? (
                    <Button size="sm" onClick={() => setReturning(heldIdCard)}>
                      Tandai dikembalikan
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          ) : canManage ? (
            <div className="form-grid">
              <TextInput
                label="Jenis jaminan"
                value={idLabel}
                onChange={(event) => setIdLabel(event.target.value)}
                hint="Mis. KTP, SIM C, atau Paspor."
              />
              <TextInput
                label="Nomor identitas"
                value={idNumber}
                onChange={(event) => setIdNumber(event.target.value)}
                hint="Opsional."
              />
              <TextInput
                label="Nama pada identitas"
                value={idName}
                onChange={(event) => setIdName(event.target.value)}
                hint="Opsional."
              />
              <div className="form-actions" style={{ alignItems: "flex-end" }}>
                <Button variant="primary" loading={busy} onClick={recordIdCard}>
                  Catat ID card
                </Button>
              </div>
            </div>
          ) : (
            <EmptyState
              title="Belum ada ID card dicatat"
              description="Staf dengan izin dapat mencatat ID card penyewa sebagai jaminan utama."
            />
          )}
        </div>
      </Panel>

      {/* ---------------- Jaminan lain (opsional) ---------------- */}
      <Panel>
        <PanelHead
          title="Jaminan lain (opsional)"
          description="Dokumen atau barang lain yang dijaminkan penyewa. Tidak wajib — tambahkan bila perlu."
        />
        <div className="panel-body stack">
          {canManage ? (
            <div className="form-grid">
              <TextInput
                label="Nama jaminan"
                required
                value={otherLabel}
                onChange={(event) => setOtherLabel(event.target.value)}
                hint="Mis. Sertifikat rumah, BPKB, NPWP."
              />
              <TextInput
                label="Keterangan"
                value={otherDesc}
                onChange={(event) => setOtherDesc(event.target.value)}
                hint="Opsional."
              />
              <div className="form-actions" style={{ alignItems: "flex-end" }}>
                <Button
                  variant="primary"
                  loading={busy}
                  disabled={otherLabel.trim().length < 1}
                  onClick={recordOther}
                >
                  Tambah jaminan
                </Button>
              </div>
            </div>
          ) : null}

          {otherHeld.length === 0 && otherReturned.length === 0 ? (
            <EmptyState title="Belum ada jaminan lain" />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Jaminan</th>
                    <th scope="col">Jenis</th>
                    <th scope="col">Status</th>
                    <th scope="col">Ditahan</th>
                    <th scope="col" className="text-right">
                      Aksi
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[...otherHeld, ...otherReturned].map((item) => (
                    <tr key={item.id}>
                      <td className="text-sm">
                        {item.label}
                        {item.description ? (
                          <div className="text-xs text-muted">{item.description}</div>
                        ) : null}
                      </td>
                      <td>
                        <StatusBadge status={collateralType(item.type)} />
                      </td>
                      <td>
                        <StatusBadge status={collateralStatus(item.status)} />
                      </td>
                      <td className="text-sm">{formatDateTime(item.heldAt ?? item.createdAt, "Asia/Jakarta")}</td>
                      <td>
                        <div className="table-actions">
                          {canManage && item.status === "HELD" ? (
                            <Button size="sm" onClick={() => setReturning(item)}>
                              Kembalikan
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
        </div>
      </Panel>

      <ConfirmDialog
        open={Boolean(returning)}
        onClose={() => setReturning(null)}
        onConfirm={async (notes) => {
          if (!returning?.id) return;
          await run(
            () => orderApi.returnCollateral(tenantId, returning.id ?? "", { notes: notes || undefined }),
            "Jaminan ditandai sudah dikembalikan. Riwayat tetap tersimpan.",
          );
          setReturning(null);
        }}
        title="Tandai jaminan dikembalikan?"
        consequence="Status berubah menjadi RETURNED dan jaminan dianggap sudah kembali ke penyewa. Riwayat tidak dihapus."
        confirmLabel="Kembalikan jaminan"
        requireReason={false}
      />
    </div>
  );
}
