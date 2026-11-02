"use client";

import { useState } from "react";
import {
  inspectionApi,
  returnApi,
  type Schema,
} from "@/shared/api/endpoints";
import { describeApiError } from "@/shared/api/errors";
import { can, type Role } from "@/shared/auth/permissions";
import { useSession } from "@/shared/auth/session";
import { formatIDR } from "@/shared/format/currency";
import { formatDateTime } from "@/shared/format/date";
import { inspectionStatus, returnStatus } from "@/shared/format/status";
import { Button } from "@/shared/ui/buttons";
import { CheckboxField, SelectInput, TextArea, TextInput } from "@/shared/ui/form";
import { ConfirmDialog, Dialog, useToast } from "@/shared/ui/overlays";
import { Panel, PanelHead, StatusBadge } from "@/shared/ui/surfaces";
import { EmptyState, InlineAlert } from "@/shared/ui/states";

type Order = Schema<"OrderResponse">;
type ReturnRecord = Schema<"ReturnRecordResponse">;
type Inspection = Schema<"InspectionResponse">;

export function ReturnsPanel({
  tenantId,
  order,
  returns,
  inspections,
  onChanged,
}: {
  tenantId: string;
  order: Order;
  returns: ReturnRecord[];
  inspections: Inspection[];
  onChanged: () => void;
}) {
  const { role, tenant } = useSession();
  const { notify } = useToast();
  const timezone = tenant?.timezone ?? "Asia/Jakarta";
  const canReturn = can(role as Role | undefined, "order.return");
  const canInspect = can(role as Role | undefined, "order.inspect");

  const [createOpen, setCreateOpen] = useState(false);
  const [inspectionOpen, setInspectionOpen] = useState(false);
  const [completing, setCompleting] = useState<ReturnRecord | null>(null);
  const [cancelling, setCancelling] = useState<ReturnRecord | null>(null);
  const [submitting, setSubmitting] = useState<Inspection | null>(null);
  const [deciding, setDeciding] = useState<Inspection | null>(null);
  const [busy, setBusy] = useState(false);

  const completedReturns = returns.filter((item) => item.status === "COMPLETED");

  return (
    <div className="stack">
      <InlineAlert tone="info">
        Inspeksi hanya dapat dikaitkan ke pengembalian COMPLETED. Denda yang disetujui tidak otomatis
        berarti dibayar atau memotong deposit; gunakan alur pembayaran/deposit terpisah.
      </InlineAlert>

      <Panel flush>
        <PanelHead
          title={`Pengembalian (${returns.length})`}
          description="Satu unit fisik hanya boleh muncul pada satu pengembalian aktif per pesanan."
          actions={
            canReturn ? (
              <Button size="sm" variant="primary" onClick={() => setCreateOpen(true)}>
                Catat pengembalian
              </Button>
            ) : null
          }
        />
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Dibuat</th>
                <th scope="col">Diterima</th>
                <th scope="col">Item</th>
                <th scope="col">Status</th>
                <th scope="col" className="text-right">
                  Aksi
                </th>
              </tr>
            </thead>
            <tbody>
              {returns.length === 0 ? (
                <tr className="table-empty">
                  <td colSpan={5}>Belum ada pengembalian dicatat.</td>
                </tr>
              ) : (
                returns.map((record) => (
                  <tr key={record.id}>
                    <td className="text-sm">{formatDateTime(record.createdAt, timezone)}</td>
                    <td className="text-sm">{record.returnedAt ? formatDateTime(record.returnedAt, timezone) : "—"}</td>
                    <td className="text-sm">
                      {(record.items ?? []).map((item) => (
                        <div key={item.id}>
                          {item.productId} × {item.quantity}
                          {item.conditionNote ? <div className="text-xs text-muted">{item.conditionNote}</div> : null}
                        </div>
                      ))}
                    </td>
                    <td>
                      <StatusBadge status={returnStatus(record.status)} />
                    </td>
                    <td>
                      <div className="table-actions">
                        {canReturn && record.status === "PENDING" ? (
                          <>
                            <Button size="sm" variant="primary" onClick={() => setCompleting(record)}>
                              Selesaikan
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setCancelling(record)}>
                              Batalkan
                            </Button>
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel flush>
        <PanelHead
          title={`Inspeksi kondisi (${inspections.length})`}
          description="Draf → diajukan → diputuskan. Nominal denda dari server, bukan perkiraan UI."
          actions={
            canInspect ? (
              <Button
                size="sm"
                variant="primary"
                onClick={() => setInspectionOpen(true)}
                disabled={completedReturns.length === 0}
              >
                Buat inspeksi
              </Button>
            ) : null
          }
        />
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Dibuat</th>
                <th scope="col">Status</th>
                <th scope="col">Ringkasan</th>
                <th scope="col" className="num">
                  Denda
                </th>
                <th scope="col" className="text-right">
                  Aksi
                </th>
              </tr>
            </thead>
            <tbody>
              {inspections.length === 0 ? (
                <tr className="table-empty">
                  <td colSpan={5}>
                    {completedReturns.length === 0
                      ? "Selesaikan pengembalian terlebih dahulu untuk membuat inspeksi."
                      : "Belum ada inspeksi."}
                  </td>
                </tr>
              ) : (
                inspections.map((inspection) => (
                  <tr key={inspection.id}>
                    <td className="text-sm">{formatDateTime(inspection.createdAt, timezone)}</td>
                    <td>
                      <StatusBadge status={inspectionStatus(inspection.status)} />
                    </td>
                    <td className="text-sm">{inspection.summary ?? "—"}</td>
                    <td className="num money">
                      {inspection.penaltyAmount ? formatIDR(inspection.penaltyAmount) : "—"}
                    </td>
                    <td>
                      <div className="table-actions">
                        {canInspect && inspection.status === "DRAFT" ? (
                          <Button size="sm" onClick={() => setSubmitting(inspection)}>
                            Ajukan
                          </Button>
                        ) : null}
                        {canInspect && inspection.status === "SUBMITTED" ? (
                          <Button size="sm" variant="primary" onClick={() => setDeciding(inspection)}>
                            Putuskan
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <CreateReturnDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        tenantId={tenantId}
        order={order}
        onSaved={() => {
          notify("Pengembalian dicatat (PENDING).", "success");
          setCreateOpen(false);
          onChanged();
        }}
        onError={(message) => notify(message, "error")}
      />

      <CreateInspectionDialog
        open={inspectionOpen}
        onClose={() => setInspectionOpen(false)}
        tenantId={tenantId}
        orderId={order.id ?? ""}
        returns={completedReturns}
        onSaved={() => {
          notify("Draf inspeksi dibuat.", "success");
          setInspectionOpen(false);
          onChanged();
        }}
        onError={(message) => notify(message, "error")}
      />

      <ConfirmDialog
        open={Boolean(completing)}
        onClose={() => setCompleting(null)}
        onConfirm={async () => {
          if (!completing?.id) return;
          setBusy(true);
          try {
            await returnApi.complete(tenantId, completing.id, {});
            notify("Pengembalian selesai; unit RESERVED menjadi AVAILABLE.", "success");
            setCompleting(null);
            onChanged();
          } catch (caught) {
            notify(describeApiError(caught), "error");
          } finally {
            setBusy(false);
          }
        }}
        title="Selesaikan pengembalian?"
        consequence="Status menjadi COMPLETED, waktu diterima dicatat server, dan unit fisik terkait dikembalikan ke AVAILABLE. Pastikan kondisi aktual sudah dicatat."
        confirmLabel="Selesaikan pengembalian"
        busy={busy}
      >
        <p className="text-sm text-muted">
          Catat kondisi aktual melalui inspeksi setelah pengembalian selesai. Menyelesaikan pengembalian
          tidak otomatis membuat denda.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={Boolean(cancelling)}
        onClose={() => setCancelling(null)}
        onConfirm={async (reason) => {
          if (!cancelling?.id) return;
          setBusy(true);
          try {
            await returnApi.cancel(tenantId, cancelling.id, { reason });
            notify("Pengembalian dibatalkan.", "success");
            setCancelling(null);
            onChanged();
          } catch (caught) {
            notify(describeApiError(caught), "error");
          } finally {
            setBusy(false);
          }
        }}
        title="Batalkan pengembalian?"
        consequence="Status menjadi CANCELLED dan unit tidak dikembalikan ke AVAILABLE lewat catatan ini. Catat pengembalian baru bila barang benar-benar diterima."
        confirmLabel="Batalkan pengembalian"
        destructive
        requireReason
        busy={busy}
      />

      <SubmitInspectionDialog
        key={submitting?.id ?? "none"}
        inspection={submitting}
        tenantId={tenantId}
        onClose={() => setSubmitting(null)}
        onSaved={() => {
          notify("Inspeksi diajukan untuk keputusan.", "success");
          setSubmitting(null);
          onChanged();
        }}
        onError={(message) => notify(message, "error")}
      />

      <DecideInspectionDialog
        key={deciding?.id ?? "none"}
        inspection={deciding}
        tenantId={tenantId}
        onClose={() => setDeciding(null)}
        onSaved={() => {
          notify("Keputusan inspeksi disimpan.", "success");
          setDeciding(null);
          onChanged();
        }}
        onError={(message) => notify(message, "error")}
      />
    </div>
  );
}

function CreateReturnDialog({
  open,
  onClose,
  tenantId,
  order,
  onSaved,
  onError,
}: {
  open: boolean;
  onClose: () => void;
  tenantId: string;
  order: Order;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const items = order.items ?? [];
  const [included, setIncluded] = useState<Record<string, boolean>>(
    Object.fromEntries(items.map((item) => [item.id ?? "", true])),
  );
  const [quantities, setQuantities] = useState<Record<string, string>>(
    Object.fromEntries(items.map((item) => [item.id ?? "", String(item.quantity ?? 1)])),
  );
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [generalNotes, setGeneralNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const payload = items
      .filter((item) => included[item.id ?? ""])
      .map((item) => ({
        productId: item.productId ?? "",
        assetId: item.assetId ?? null,
        quantity: Number.parseInt(quantities[item.id ?? ""] ?? "1", 10),
        conditionNote: notes[item.id ?? ""]?.trim() || undefined,
      }))
      .filter((item) => item.productId && item.quantity > 0);
    if (payload.length === 0) {
      onError("Pilih minimal satu item untuk dikembalikan.");
      return;
    }
    setBusy(true);
    try {
      await returnApi.create(tenantId, order.id ?? "", { notes: generalNotes.trim() || undefined, items: payload });
      onSaved();
    } catch (caught) {
      onError(describeApiError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Catat pengembalian"
      description="Jumlah kumulatif pengembalian tidak boleh melebihi jumlah yang disewa; validasi dilakukan server."
      wide
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Batal
          </Button>
          <Button type="submit" form="create-return" variant="primary" loading={busy}>
            Simpan (PENDING)
          </Button>
        </>
      }
    >
      <form id="create-return" className="stack" onSubmit={submit}>
        {items.length === 0 ? (
          <EmptyState title="Pesanan tanpa item" description="Tidak ada item yang dapat dikembalikan." />
        ) : (
          items.map((item) => (
            <div className="panel" key={item.id} style={{ boxShadow: "none" }}>
              <div className="panel-body stack-sm">
                <CheckboxField
                  label={`Sertakan item ${item.productId ?? ""}${item.assetId ? ` · unit ${item.assetId}` : ""}`}
                  checked={included[item.id ?? ""] ?? false}
                  onChange={(value) =>
                    setIncluded((current) => ({ ...current, [item.id ?? ""]: value }))
                  }
                />
                <div className="form-grid">
                  <TextInput
                    label="Jumlah dikembalikan"
                    inputMode="numeric"
                    value={quantities[item.id ?? ""] ?? "1"}
                    onChange={(event) =>
                      setQuantities((current) => ({
                        ...current,
                        [item.id ?? ""]: event.target.value.replace(/\D/g, ""),
                      }))
                    }
                    hint={`Disewa: ${item.quantity ?? 0}. Unit fisik wajib berjumlah 1.`}
                  />
                  <TextInput
                    label="Catatan kondisi"
                    value={notes[item.id ?? ""] ?? ""}
                    onChange={(event) =>
                      setNotes((current) => ({ ...current, [item.id ?? ""]: event.target.value }))
                    }
                  />
                </div>
              </div>
            </div>
          ))
        )}
        <TextArea
          label="Catatan umum"
          rows={2}
          value={generalNotes}
          onChange={(event) => setGeneralNotes(event.target.value)}
        />
      </form>
    </Dialog>
  );
}

function CreateInspectionDialog({
  open,
  onClose,
  tenantId,
  orderId,
  returns,
  onSaved,
  onError,
}: {
  open: boolean;
  onClose: () => void;
  tenantId: string;
  orderId: string;
  returns: ReturnRecord[];
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [returnRecordId, setReturnRecordId] = useState("");
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await inspectionApi.create(tenantId, orderId, {
        returnRecordId: returnRecordId || null,
        summary: summary.trim() || undefined,
      });
      onSaved();
    } catch (caught) {
      onError(describeApiError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Buat inspeksi"
      description="Maksimal satu inspeksi aktif per pengembalian."
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Batal
          </Button>
          <Button type="submit" form="create-inspection" variant="primary" loading={busy}>
            Simpan draf
          </Button>
        </>
      }
    >
      <form id="create-inspection" className="stack" onSubmit={submit}>
        <SelectInput
          label="Pengembalian terkait"
          required
          value={returnRecordId}
          onChange={(event) => setReturnRecordId(event.target.value)}
        >
          <option value="">Pilih pengembalian COMPLETED</option>
          {returns.map((record) => (
            <option key={record.id} value={record.id}>
              {formatDateTime(record.returnedAt ?? record.createdAt)} · {record.id?.slice(0, 8)}
            </option>
          ))}
        </SelectInput>
        <TextArea
          label="Ringkasan temuan"
          rows={3}
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          hint="Bandingkan kondisi awal serah-terima dengan kondisi saat kembali."
        />
      </form>
    </Dialog>
  );
}

function SubmitInspectionDialog({
  inspection,
  tenantId,
  onClose,
  onSaved,
  onError,
}: {
  inspection: Inspection | null;
  tenantId: string;
  onClose: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [summary, setSummary] = useState(inspection?.summary ?? "");
  const [penalty, setPenalty] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!inspection?.id) return;
    setBusy(true);
    try {
      await inspectionApi.submit(tenantId, inspection.id, {
        summary: summary.trim() || undefined,
        penaltyAmount: penalty ? Number.parseInt(penalty, 10) : undefined,
      });
      onSaved();
    } catch (caught) {
      onError(describeApiError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={Boolean(inspection)}
      onClose={onClose}
      title="Ajukan inspeksi"
      description="Setelah diajukan, inspeksi menunggu keputusan petugas berizin."
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Batal
          </Button>
          <Button type="submit" form="submit-inspection" variant="primary" loading={busy}>
            Ajukan
          </Button>
        </>
      }
    >
      <form id="submit-inspection" className="stack" onSubmit={submit}>
        <TextArea label="Ringkasan" rows={3} value={summary} onChange={(event) => setSummary(event.target.value)} />
        <TextInput
          label="Usulan denda (Rp)"
          inputMode="numeric"
          value={penalty}
          onChange={(event) => setPenalty(event.target.value.replace(/\D/g, ""))}
          hint="Kondisi aman tetap Rp0. Denda tidak otomatis dipotong dari deposit."
        />
      </form>
    </Dialog>
  );
}

function DecideInspectionDialog({
  inspection,
  tenantId,
  onClose,
  onSaved,
  onError,
}: {
  inspection: Inspection | null;
  tenantId: string;
  onClose: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [decision, setDecision] = useState<"APPROVE" | "REJECT">("APPROVE");
  const [penalty, setPenalty] = useState(inspection?.penaltyAmount ?? "");
  const [summary, setSummary] = useState(inspection?.summary ?? "");
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!inspection?.id) return;
    if (decision === "APPROVE" && !penalty) {
      onError("Nominal denda wajib diisi saat menyetujui inspeksi (boleh 0 untuk kondisi aman).");
      return;
    }
    setBusy(true);
    try {
      await inspectionApi.decide(tenantId, inspection.id, {
        decision,
        penaltyAmount: penalty ? Number.parseInt(penalty, 10) : undefined,
        summary: summary.trim() || undefined,
      });
      onSaved();
    } catch (caught) {
      onError(describeApiError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={Boolean(inspection)}
      onClose={onClose}
      title="Putuskan inspeksi"
      description="Keputusan denda tidak mengubah status pembayaran atau deposit."
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Batal
          </Button>
          <Button type="submit" form="decide-inspection" variant="primary" loading={busy}>
            Simpan keputusan
          </Button>
        </>
      }
    >
      <form id="decide-inspection" className="stack" onSubmit={submit}>
        <SelectInput
          label="Keputusan"
          value={decision}
          onChange={(event) => setDecision(event.target.value as "APPROVE" | "REJECT")}
        >
          <option value="APPROVE">Setujui (APPROVED)</option>
          <option value="REJECT">Tolak (REJECTED)</option>
        </SelectInput>
        <TextInput
          label="Nominal denda final (Rp)"
          inputMode="numeric"
          value={penalty ?? ""}
          onChange={(event) => setPenalty(event.target.value.replace(/\D/g, ""))}
          hint="Wajib saat menyetujui. Gunakan 0 bila tidak ada kerusakan."
        />
        <TextArea label="Catatan keputusan" rows={2} value={summary} onChange={(event) => setSummary(event.target.value)} />
      </form>
    </Dialog>
  );
}
