"use client";

import { useState } from "react";
import { extensionApi, type Schema } from "@/shared/api/endpoints";
import { describeApiError, extractConflicts, isConflict } from "@/shared/api/errors";
import { can, type Role } from "@/shared/auth/permissions";
import { useSession } from "@/shared/auth/session";
import { notifyExtensionActivity } from "@/shared/events/extension-activity";
import { formatIDR } from "@/shared/format/currency";
import {
  formatDateRange,
  formatDateTime,
  isoToZonedLocal,
  zonedLocalToIso,
} from "@/shared/format/date";
import { extensionStatus } from "@/shared/format/status";
import { Button } from "@/shared/ui/buttons";
import { CheckboxField, TextArea, TextInput } from "@/shared/ui/form";
import { ConfirmDialog, Dialog, useToast } from "@/shared/ui/overlays";
import { Badge, Panel, PanelHead, StatusBadge } from "@/shared/ui/surfaces";
import { EmptyState, InlineAlert } from "@/shared/ui/states";

type Order = Schema<"OrderResponse">;
type Extension = Schema<"OrderExtensionResponse">;
type ConflictTask = Schema<"ExtensionConflictTaskResponse">;

export function ExtensionsPanel({
  tenantId,
  order,
  extensions,
  onChanged,
}: {
  tenantId: string;
  order: Order;
  extensions: Extension[];
  onChanged: () => void;
}) {
  const { role, tenant } = useSession();
  const { notify } = useToast();
  const timezone = tenant?.timezone ?? "Asia/Jakarta";
  const canRequest = can(role as Role | undefined, "rental.extension.request");
  const canApprove = can(role as Role | undefined, "rental.extension.approve");
  const canResolve = can(role as Role | undefined, "rental.extension.resolve_conflict");
  // Permission override tidak tersedia pada data sesi; hanya OWNER yang
  // ditampilkan, dan backend tetap memeriksa permission khusus.
  const canOverride = role === "OWNER";

  const [requestOpen, setRequestOpen] = useState(false);
  const [rejecting, setRejecting] = useState<Extension | null>(null);
  const [overriding, setOverriding] = useState<Extension | null>(null);
  const [resolving, setResolving] = useState<{ extension: Extension; conflict: ConflictTask } | null>(null);
  const [conflictDetails, setConflictDetails] = useState<Record<string, ReturnType<typeof extractConflicts>>>({});
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<Extension | null>(null);

  const extensionEnabled = tenant?.rentalExtensionEnabled !== false;

  const approve = async (extension: Extension) => {
    if (!extension.id) return;
    setBusy(true);
    try {
      await extensionApi.approve(tenantId, order.id ?? "", extension.id, {});
      notify("Perpanjangan disetujui dan periode diperbarui secara atomik.", "success");
      notifyExtensionActivity();
      onChanged();
    } catch (caught) {
      if (isConflict(caught)) {
        const conflicts = extractConflicts(caught);
        setConflictDetails((current) => ({ ...current, [extension.id ?? ""]: conflicts }));
        notify(
          conflicts.length > 0
            ? "Konflik ketersediaan: perpanjangan tidak disetujui. Tinjau periode yang bentrok."
            : describeApiError(caught),
          "error",
        );
      } else {
        notify(describeApiError(caught), "error");
      }
    } finally {
      setBusy(false);
    }
  };

  const openDetail = async (extension: Extension) => {
    if (!extension.id) return;
    try {
      const value = await extensionApi.get(tenantId, order.id ?? "", extension.id);
      setDetail(value);
    } catch (caught) {
      notify(describeApiError(caught), "error");
    }
  };

  return (
    <div className="stack">
      {!extensionEnabled ? (
        <InlineAlert tone="warning">
          Fitur perpanjangan dinonaktifkan tenant. API menolak pengajuan perpanjangan; pengembalian dan
          inspeksi pesanan aktif tetap berjalan.
        </InlineAlert>
      ) : null}

      <Panel flush>
        <PanelHead
          title={`Pengajuan perpanjangan (${extensions.length})`}
          description="Pengajuan tidak mengubah periode/alokasi. Persetujuan menghitung ulang biaya dan mengalokasikan periode tambahan secara atomik."
          actions={
            canRequest && extensionEnabled && order.status === "ACTIVE" ? (
              <Button size="sm" variant="primary" onClick={() => setRequestOpen(true)}>
                Ajukan perpanjangan
              </Button>
            ) : null
          }
        />
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Diajukan</th>
                <th scope="col">Periode diminta</th>
                <th scope="col" className="num">
                  Biaya
                </th>
                <th scope="col">Status</th>
                <th scope="col">Override</th>
                <th scope="col" className="text-right">
                  Aksi
                </th>
              </tr>
            </thead>
            <tbody>
              {extensions.length === 0 ? (
                <tr className="table-empty">
                  <td colSpan={6}>
                    {order.status === "ACTIVE"
                      ? "Belum ada pengajuan perpanjangan."
                      : "Perpanjangan hanya untuk pesanan ACTIVE."}
                  </td>
                </tr>
              ) : (
                extensions.map((extension) => (
                  <ExtensionRow
                    key={extension.id}
                    extension={extension}
                    timezone={timezone}
                    conflicts={conflictDetails[extension.id ?? ""] ?? []}
                    canApprove={canApprove}
                    canOverride={canOverride}
                    canResolve={canResolve}
                    busy={busy}
                    onApprove={() => void approve(extension)}
                    onReject={() => setRejecting(extension)}
                    onOverride={() => setOverriding(extension)}
                    onResolve={(conflict) => setResolving({ extension, conflict })}
                    onDetail={() => void openDetail(extension)}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      {detail ? (
        <Panel>
          <PanelHead
            title="Detail perpanjangan"
            actions={
              <Button size="sm" variant="ghost" onClick={() => setDetail(null)}>
                Tutup
              </Button>
            }
          />
          <div className="panel-body stack-sm">
            <p className="text-sm">
              Periode: {formatDateRange(detail.previousEndAt, detail.requestedEndAt, timezone)}
            </p>
            <p className="text-sm">Biaya: {formatIDR(detail.amount)}</p>
            {detail.conflicts && detail.conflicts.length > 0 ? (
              <ul style={{ margin: 0, paddingLeft: "1.1rem" }} className="text-sm">
                {detail.conflicts.map((conflict) => (
                  <li key={conflict.id}>
                    Konflik {conflict.status} · {conflict.summary?.productName ?? "produk"} ·{" "}
                    {formatDateRange(conflict.summary?.startAt, conflict.summary?.endAt, timezone)}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">Tidak ada konflik tercatat.</p>
            )}
            <p className="text-xs text-muted">
              Daftar konflik dihitung server; client tidak boleh mengirim daftar sendiri.
            </p>
          </div>
        </Panel>
      ) : null}

      <RequestExtensionDialog
        open={requestOpen}
        onClose={() => setRequestOpen(false)}
        tenantId={tenantId}
        orderId={order.id ?? ""}
        currentEndAt={order.items?.[0]?.endAt ?? undefined}
        timezone={timezone}
        onSaved={() => {
          notify("Pengajuan perpanjangan dikirim.", "success");
          setRequestOpen(false);
          onChanged();
        }}
        onError={(message) => notify(message, "error")}
      />

      <ConfirmDialog
        open={Boolean(rejecting)}
        onClose={() => setRejecting(null)}
        onConfirm={async (reason) => {
          if (!rejecting?.id) return;
          setBusy(true);
          try {
            await extensionApi.reject(tenantId, order.id ?? "", rejecting.id, { reason });
            notify("Perpanjangan ditolak.", "success");
            notifyExtensionActivity();
            setRejecting(null);
            onChanged();
          } catch (caught) {
            notify(describeApiError(caught), "error");
          } finally {
            setBusy(false);
          }
        }}
        title="Tolak perpanjangan?"
        consequence="Status menjadi REJECTED. Periode, alokasi, dan biaya pesanan tidak berubah."
        confirmLabel="Tolak perpanjangan"
        destructive
        requireReason
        busy={busy}
      />

      <OverrideDialog
        extension={overriding}
        tenantId={tenantId}
        onClose={() => setOverriding(null)}
        onSaved={() => {
          notify("Override konflik disetujui; booking terdampak ditandai dan tugas operasional dibuat.", "success");
          notifyExtensionActivity();
          setOverriding(null);
          onChanged();
        }}
        onError={(message) => notify(message, "error")}
      />

      <ResolveConflictDialog
        target={resolving}
        tenantId={tenantId}
        onClose={() => setResolving(null)}
        onSaved={() => {
          notify("Konflik ditandai selesai; flag dihitung ulang server.", "success");
          notifyExtensionActivity();
          setResolving(null);
          onChanged();
        }}
        onError={(message) => notify(message, "error")}
      />
    </div>
  );
}

function ExtensionRow({
  extension,
  timezone,
  conflicts,
  canApprove,
  canOverride,
  canResolve,
  busy,
  onApprove,
  onReject,
  onOverride,
  onResolve,
  onDetail,
}: {
  extension: Extension;
  timezone: string;
  conflicts: ReturnType<typeof extractConflicts>;
  canApprove: boolean;
  canOverride: boolean;
  canResolve: boolean;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  onOverride: () => void;
  onResolve: (conflict: ConflictTask) => void;
  onDetail: () => void;
}) {
  const openTasks = (extension.conflicts ?? []).filter((conflict) => conflict.status === "OPEN");
  return (
    <>
      <tr>
        <td className="text-sm">{formatDateTime(extension.createdAt, timezone)}</td>
        <td className="text-sm">
          {formatDateRange(extension.previousEndAt, extension.requestedEndAt, timezone)}
        </td>
        <td className="num money">{formatIDR(extension.amount)}</td>
        <td>
          <StatusBadge status={extensionStatus(extension.status)} />
        </td>
        <td>
          {extension.override ? (
            <div className="stack-sm">
              <Badge tone="danger">Override</Badge>
              <span className="text-xs text-muted">{extension.override.reason}</span>
            </div>
          ) : (
            <span className="text-xs text-muted">—</span>
          )}
        </td>
        <td>
          <div className="table-actions">
            {extension.status === "PENDING_APPROVAL" && canApprove ? (
              <>
                <Button size="sm" variant="primary" loading={busy} onClick={onApprove}>
                  Setujui
                </Button>
                <Button size="sm" variant="danger" onClick={onReject}>
                  Tolak
                </Button>
              </>
            ) : null}
            {extension.status === "PENDING_APPROVAL" && conflicts.length > 0 && canOverride ? (
              <Button size="sm" variant="danger" onClick={onOverride}>
                Override konflik
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={onDetail}>
              Detail
            </Button>
            {canResolve && openTasks.length > 0 ? (
              <Button size="sm" onClick={() => onResolve(openTasks[0]!)}>
                Selesaikan konflik
              </Button>
            ) : null}
          </div>
        </td>
      </tr>
      {conflicts.length > 0 ? (
        <tr>
          <td colSpan={6} style={{ background: "var(--sw-danger-bg)" }}>
            <div className="text-sm" style={{ color: "var(--sw-danger-text)" }}>
              <strong>Konflik ketersediaan (server):</strong>
              <ul style={{ margin: "0.25rem 0 0", paddingLeft: "1.1rem" }}>
                {conflicts.map((conflict, index) => (
                  <li key={conflict.allocationId ?? index}>
                    {conflict.productName ?? "Produk"} · {formatDateRange(conflict.startAt, conflict.endAt, timezone)}
                    {conflict.orderNumber ? ` · pesanan ${conflict.orderNumber}` : ""}
                    {conflict.customerName ? ` · ${conflict.customerName}` : ""}
                    {conflict.reason === "CAPACITY_EXCEEDED" ? " · kapasitas terlampaui" : " · unit tumpang tindih"}
                  </li>
                ))}
              </ul>
              <span>
                Perpanjangan tidak disetujui. Override hanya untuk pengguna dengan permission khusus dan
                wajib menyertakan alasan serta konfirmasi risiko.
              </span>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function RequestExtensionDialog({
  open,
  onClose,
  tenantId,
  orderId,
  currentEndAt,
  timezone,
  onSaved,
  onError,
}: {
  open: boolean;
  onClose: () => void;
  tenantId: string;
  orderId: string;
  currentEndAt?: string;
  timezone: string;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [value, setValue] = useState(currentEndAt ? isoToZonedLocal(currentEndAt, timezone) : "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const iso = zonedLocalToIso(value, timezone);
    if (!iso) {
      onError("Tanggal akhir perpanjangan tidak valid.");
      return;
    }
    setBusy(true);
    try {
      await extensionApi.request(tenantId, orderId, { requestedEndAt: iso, note: note.trim() || undefined });
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
      title="Ajukan perpanjangan sewa"
      description="Periode aktif tidak berubah sampai pengajuan disetujui dan alokasi tambahan berhasil."
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Batal
          </Button>
          <Button type="submit" form="request-extension" variant="primary" loading={busy}>
            Kirim pengajuan
          </Button>
        </>
      }
    >
      <form id="request-extension" className="stack" onSubmit={submit}>
        <TextInput
          label={`Akhir sewa baru (${timezone})`}
          type="datetime-local"
          required
          value={value}
          onChange={(event) => setValue(event.target.value)}
          hint="Harus setelah tanggal akhir sewa saat ini. Biaya dihitung server."
        />
        <TextArea label="Catatan" rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
        <InlineAlert tone="info">
          Setelah disetujui, tagihan perpanjangan tetap terpisah dari pembayaran sebelumnya dan boleh
          belum lunas.
        </InlineAlert>
      </form>
    </Dialog>
  );
}

function OverrideDialog({
  extension,
  tenantId,
  onClose,
  onSaved,
  onError,
}: {
  extension: Extension | null;
  tenantId: string;
  onClose: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [risk, setRisk] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!extension?.id) return;
    if (!risk) {
      onError("Konfirmasi risiko wajib dicentang sebelum override.");
      return;
    }
    setBusy(true);
    try {
      await extensionApi.overrideConflict(tenantId, extension.orderId ?? "", extension.id, {
        reason: reason.trim(),
        riskConfirmed: true,
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
      open={Boolean(extension)}
      onClose={onClose}
      title="Override konflik perpanjangan"
      description="Override menandai booking lain berisiko dan membuat tugas operasional penyelesaian. Tidak mengubah status lifecycle booking terdampak."
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Batal
          </Button>
          <Button type="submit" form="override-conflict" variant="danger" loading={busy}>
            Override & setujui
          </Button>
        </>
      }
    >
      <form id="override-conflict" className="stack" onSubmit={submit}>
        <InlineAlert tone="danger">
          Periode tambahan akan tumpang tindih dengan booking lain yang sudah terkonfirmasi. Janji sewa
          penyewa lain dapat dilanggar; siapkan unit pengganti atau jadwal alternatif.
        </InlineAlert>
        <TextArea
          label="Alasan override (wajib, diaudit)"
          required
          rows={3}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        <CheckboxField
          label="Saya memahami risiko konflik dan menyetujui override ini."
          checked={risk}
          onChange={setRisk}
        />
      </form>
    </Dialog>
  );
}

function ResolveConflictDialog({
  target,
  tenantId,
  onClose,
  onSaved,
  onError,
}: {
  target: { extension: Extension; conflict: ConflictTask } | null;
  tenantId: string;
  onClose: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!target?.extension.id || !target.conflict.id) return;
    setBusy(true);
    try {
      await extensionApi.resolveConflict(
        tenantId,
        target.extension.orderId ?? "",
        target.extension.id,
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
      title="Selesaikan konflik"
      description="Catatan penyelesaian tersimpan pada konflik dan audit. Flag dihitung ulang setelah setiap penyelesaian."
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Batal
          </Button>
          <Button type="submit" form="resolve-conflict" variant="primary" loading={busy}>
            Tandai selesai
          </Button>
        </>
      }
    >
      <form id="resolve-conflict" className="stack" onSubmit={submit}>
        <TextArea
          label="Catatan penyelesaian (wajib)"
          required
          rows={3}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          hint="Contoh: unit pengganti sudah disiapkan dan penyewa terdampak sudah dihubungi."
        />
      </form>
    </Dialog>
  );
}
