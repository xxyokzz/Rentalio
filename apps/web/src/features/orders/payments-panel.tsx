"use client";

import { useMemo, useState } from "react";
import {
  orderApi,
  paymentSettingsApi,
  type PaymentContext,
  type PaymentMethod,
  type Schema,
} from "@/shared/api/endpoints";
import { describeApiError } from "@/shared/api/errors";
import { can, type Role } from "@/shared/auth/permissions";
import { useSession } from "@/shared/auth/session";
import { formatIDR } from "@/shared/format/currency";
import { formatDateTime } from "@/shared/format/date";
import { contextLabel, methodLabel, paymentStatus, refundStatus } from "@/shared/format/status";
import { useApi } from "@/shared/hooks/useApi";
import { Button } from "@/shared/ui/buttons";
import { SelectInput, TextArea, TextInput } from "@/shared/ui/form";
import { ConfirmDialog, Dialog, useToast } from "@/shared/ui/overlays";
import { Badge, Panel, PanelHead, StatusBadge } from "@/shared/ui/surfaces";
import { EmptyState, InlineAlert, LoadingBlock } from "@/shared/ui/states";
import { WhatsAppMessageCard } from "@/shared/ui/whatsapp-message";

type Order = Schema<"OrderResponse">;

export function PaymentsPanel({
  tenantId,
  order,
  refunds,
  refundsLoading,
  onChanged,
}: {
  tenantId: string;
  order: Order;
  refunds: Schema<"RefundResponse">[];
  refundsLoading: boolean;
  onChanged: () => void;
}) {
  const { role, tenant } = useSession();
  const { notify } = useToast();
  const timezone = tenant?.timezone ?? "Asia/Jakarta";
  const canRecord = can(role as Role | undefined, "payment.record");
  const canVoid = can(role as Role | undefined, "payment.void");
  const canRequestRefund = can(role as Role | undefined, "refund.request");
  const canApproveRefund = can(role as Role | undefined, "refund.approve");
  const canProcessRefund = can(role as Role | undefined, "refund.process");

  const [context, setContext] = useState<PaymentContext>("NEW_BOOKING");
  const [method, setMethod] = useState<PaymentMethod | "">("");
  const [amount, setAmount] = useState(order.outstandingAmount ?? "");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<Schema<"WhatsAppMessageResponse"> | null>(null);
  const [voiding, setVoiding] = useState<Schema<"PaymentResponse"> | null>(null);
  const [refundOpen, setRefundOpen] = useState(false);
  const [resultFor, setResultFor] = useState<Schema<"RefundResponse"> | null>(null);

  const settingsState = useApi(
    tenantId ? () => paymentSettingsApi.list(tenantId) : null,
    [tenantId],
  );

  const methodsForContext = useMemo(() => {
    const settings = settingsState.data?.settings ?? [];
    return settings
      .filter((item) => item.context === context && item.enabled !== false)
      .map((item) => item.method as PaymentMethod);
  }, [settingsState.data, context]);

  const recordPayment = async () => {
    setError(null);
    setBusy(true);
    try {
      const payment = await orderApi.recordPayment(
        tenantId,
        order.id ?? "",
        {
          amount: amount.replace(/\D/g, ""),
          currency: "IDR",
          method: method as PaymentMethod,
          context,
          reference: reference.trim() || undefined,
        },
        crypto.randomUUID(),
      );
      setMessage(payment.whatsappMessage ?? null);
      setReference("");
      notify("Pembayaran dicatat. Status lunas hanya setelah verifikasi petugas.", "success");
      onChanged();
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <Panel>
        <PanelHead
          title="Ringkasan pembayaran"
          description="Nilai dihitung server: pembayaran VOIDED tidak dihitung dalam paidAmount."
        />
        <div className="panel-body grid-3">
          <div className="total-row">
            <span>Total tagihan</span>
            <span className="money">{formatIDR(order.totalAmount)}</span>
          </div>
          <div className="total-row">
            <span>Dibayar</span>
            <span className="money">{formatIDR(order.paidAmount)}</span>
          </div>
          <div className="total-row">
            <span>Sisa</span>
            <span className="money">{formatIDR(order.outstandingAmount)}</span>
          </div>
        </div>
      </Panel>

      {message ? (
        <Panel>
          <PanelHead title="Pesan konfirmasi pembayaran" description="Snapshot server, siap dikirim manual." />
          <div className="panel-body">
            <WhatsAppMessageCard message={message} />
          </div>
        </Panel>
      ) : null}

      {canRecord ? (
        <Panel>
          <PanelHead title="Catat pembayaran manual" description="Append-only: koreksi memakai void, bukan edit." />
          <div className="panel-body stack">
            {error ? (
              <InlineAlert tone="danger">
                <span role="alert">{error}</span>
              </InlineAlert>
            ) : null}
            <div className="form-grid">
              <SelectInput
                label="Konteks transaksi"
                value={context}
                onChange={(event) => {
                  setContext(event.target.value as PaymentContext);
                  setMethod("");
                }}
                hint="Metode nonaktif untuk konteks ini ditolak server."
              >
                <option value="NEW_BOOKING">Booking baru</option>
                <option value="ADD_UNIT">Tambah unit</option>
                <option value="EXTENSION">Perpanjangan</option>
              </SelectInput>
              <SelectInput
                label="Metode"
                required
                value={method}
                onChange={(event) => setMethod(event.target.value as PaymentMethod)}
              >
                <option value="">Pilih metode</option>
                {methodsForContext.map((item) => (
                  <option key={item} value={item}>
                    {methodLabel(item).label}
                  </option>
                ))}
              </SelectInput>
              <TextInput
                label="Nominal (Rp)"
                inputMode="numeric"
                required
                value={amount}
                onChange={(event) => setAmount(event.target.value.replace(/\D/g, ""))}
              />
              <TextInput
                label="Referensi (opsional)"
                value={reference}
                onChange={(event) => setReference(event.target.value)}
              />
            </div>
            {settingsState.initialLoading ? (
              <LoadingBlock rows={1} />
            ) : methodsForContext.length === 0 ? (
              <InlineAlert tone="warning">
                Tidak ada metode pembayaran aktif untuk konteks ini. Atur di Pengaturan → Metode
                pembayaran; server akan menolak penyimpanan yang menyisakan nol metode.
              </InlineAlert>
            ) : null}
            <div className="form-actions">
              <Button
                variant="primary"
                loading={busy}
                disabled={!method || !amount}
                onClick={() => void recordPayment()}
              >
                Catat pembayaran
              </Button>
            </div>
          </div>
        </Panel>
      ) : null}

      <Panel flush>
        <PanelHead title="Riwayat pembayaran" description="Termasuk pembayaran yang sudah di-void." />
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Waktu</th>
                <th scope="col">Metode</th>
                <th scope="col">Konteks</th>
                <th scope="col" className="num">
                  Nominal
                </th>
                <th scope="col">Status</th>
                <th scope="col">Referensi</th>
                <th scope="col" className="text-right">
                  Aksi
                </th>
              </tr>
            </thead>
            <tbody>
              {(order.payments ?? []).length === 0 ? (
                <tr className="table-empty">
                  <td colSpan={7}>Belum ada pembayaran tercatat.</td>
                </tr>
              ) : (
                (order.payments ?? []).map((payment) => (
                  <tr key={payment.id}>
                    <td className="text-sm">{formatDateTime(payment.recordedAt, timezone)}</td>
                    <td>{methodLabel(payment.method).label}</td>
                    <td className="text-sm">{contextLabel(payment.context).label}</td>
                    <td className="num money">{formatIDR(payment.amount)}</td>
                    <td>
                      <StatusBadge status={paymentStatus(payment.status)} />
                      {payment.voidReason ? (
                        <div className="text-xs text-muted">Alasan: {payment.voidReason}</div>
                      ) : null}
                    </td>
                    <td className="text-sm">{payment.reference ?? "—"}</td>
                    <td>
                      <div className="table-actions">
                        {canVoid && payment.status === "RECORDED" ? (
                          <Button size="sm" variant="danger" onClick={() => setVoiding(payment)}>
                            Void
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

      <Panel flush>
        <PanelHead
          title="Refund pembayaran"
          description="Refund adalah entitas terpisah; payment asli tetap RECORDED."
          actions={
            canRequestRefund ? (
              <Button size="sm" variant="primary" onClick={() => setRefundOpen(true)}>
                Ajukan refund
              </Button>
            ) : null
          }
        />
        {refundsLoading ? (
          <div className="panel-body">
            <LoadingBlock rows={2} />
          </div>
        ) : refunds.length === 0 ? (
          <EmptyState title="Belum ada refund" description="Refund hanya untuk payment RECORDED pada order ini." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Diajukan</th>
                  <th scope="col" className="num">
                    Nominal
                  </th>
                  <th scope="col">Status</th>
                  <th scope="col" className="num">
                    Sisa refundable
                  </th>
                  <th scope="col">Alasan</th>
                  <th scope="col" className="text-right">
                    Aksi
                  </th>
                </tr>
              </thead>
              <tbody>
                {refunds.map((refund) => (
                  <tr key={refund.id}>
                    <td className="text-sm">{formatDateTime(refund.requestedAt, timezone)}</td>
                    <td className="num money">{formatIDR(refund.amount)}</td>
                    <td>
                      <StatusBadge status={refundStatus(refund.status)} />
                    </td>
                    <td className="num money">{formatIDR(refund.refundableAmount)}</td>
                    <td className="text-sm">{refund.reason ?? "—"}</td>
                    <td>
                      <div className="table-actions">
                        {canApproveRefund && refund.status === "REQUESTED" ? (
                          <Button
                            size="sm"
                            onClick={async () => {
                              try {
                                await orderApi.approveRefund(tenantId, refund.id ?? "", {});
                                notify("Refund disetujui; lanjut catat hasil.", "success");
                                onChanged();
                              } catch (caught) {
                                notify(describeApiError(caught), "error");
                              }
                            }}
                          >
                            Setujui
                          </Button>
                        ) : null}
                        {canProcessRefund && (refund.status === "APPROVED" || refund.status === "PROCESSING") ? (
                          <Button size="sm" variant="primary" onClick={() => setResultFor(refund)}>
                            Catat hasil
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
      </Panel>

      <ConfirmDialog
        open={Boolean(voiding)}
        onClose={() => setVoiding(null)}
        onConfirm={async (reason) => {
          if (!voiding?.id) return;
          try {
            await orderApi.voidPayment(tenantId, voiding.id, { reason });
            notify("Pembayaran di-void. Histori tetap tersimpan.", "success");
            setVoiding(null);
            onChanged();
          } catch (caught) {
            notify(describeApiError(caught), "error");
          }
        }}
        title="Void pembayaran?"
        consequence="Pembayaran berubah menjadi VOIDED dan tidak dihitung dalam paidAmount. Baris histori tidak dihapus; tindakan diaudit."
        confirmLabel="Void pembayaran"
        destructive
        requireReason
        reasonLabel="Alasan void"
      />

      <RequestRefundDialog
        open={refundOpen}
        onClose={() => setRefundOpen(false)}
        tenantId={tenantId}
        orderId={order.id ?? ""}
        payments={(order.payments ?? []).filter((payment) => payment.status === "RECORDED")}
        onSaved={() => {
          notify("Refund diajukan. Menunggu persetujuan.", "success");
          setRefundOpen(false);
          onChanged();
        }}
        onError={(text) => notify(text, "error")}
      />

      <RecordRefundResultDialog
        refund={resultFor}
        tenantId={tenantId}
        onClose={() => setResultFor(null)}
        onSaved={() => {
          notify("Hasil refund dicatat.", "success");
          setResultFor(null);
          onChanged();
        }}
        onError={(text) => notify(text, "error")}
      />
    </div>
  );
}

function RequestRefundDialog({
  open,
  onClose,
  tenantId,
  orderId,
  payments,
  onSaved,
  onError,
}: {
  open: boolean;
  onClose: () => void;
  tenantId: string;
  orderId: string;
  payments: Schema<"PaymentResponse">[];
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [paymentId, setPaymentId] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!paymentId) {
      onError("Pilih pembayaran yang akan direfund.");
      return;
    }
    setBusy(true);
    try {
      await orderApi.requestRefund(tenantId, orderId, {
        paymentId,
        amount: amount.replace(/\D/g, ""),
        currency: "IDR",
        reason: reason.trim(),
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
      title="Ajukan refund"
      description="Batas refund dihitung server di bawah row lock payment; dua pengajuan paralel tidak dapat melebihi nilai payment."
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Batal
          </Button>
          <Button type="submit" form="request-refund" variant="primary" loading={busy}>
            Ajukan
          </Button>
        </>
      }
    >
      <form id="request-refund" className="stack" onSubmit={submit}>
        <SelectInput
          label="Pembayaran"
          required
          value={paymentId}
          onChange={(event) => {
            setPaymentId(event.target.value);
            const payment = payments.find((item) => item.id === event.target.value);
            setAmount(payment?.amount ?? "");
          }}
        >
          <option value="">Pilih pembayaran</option>
          {payments.map((payment) => (
            <option key={payment.id} value={payment.id}>
              {methodLabel(payment.method).label} · {formatIDR(payment.amount)} ·{" "}
              {formatDateTime(payment.recordedAt)}
            </option>
          ))}
        </SelectInput>
        <TextInput
          label="Nominal refund (Rp)"
          inputMode="numeric"
          required
          value={amount}
          onChange={(event) => setAmount(event.target.value.replace(/\D/g, ""))}
        />
        <TextArea
          label="Alasan"
          required
          rows={3}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          hint="Alasan disimpan untuk audit dan ditampilkan pada riwayat."
        />
      </form>
    </Dialog>
  );
}

function RecordRefundResultDialog({
  refund,
  tenantId,
  onClose,
  onSaved,
  onError,
}: {
  refund: Schema<"RefundResponse"> | null;
  tenantId: string;
  onClose: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [status, setStatus] = useState<"SUCCEEDED" | "FAILED">("SUCCEEDED");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!refund?.id) return;
    setBusy(true);
    try {
      await orderApi.recordRefundResult(tenantId, refund.id, {
        status,
        reference: reference.trim() || undefined,
        note: note.trim() || undefined,
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
      open={Boolean(refund)}
      onClose={onClose}
      title="Catat hasil refund"
      description="MVP offline: hasil dicatat staf, bukan gateway. FAILED melepas kembali nilai refundable."
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Batal
          </Button>
          <Button type="submit" form="refund-result" variant="primary" loading={busy}>
            Simpan hasil
          </Button>
        </>
      }
    >
      <form id="refund-result" className="stack" onSubmit={submit}>
        <SelectInput
          label="Hasil"
          value={status}
          onChange={(event) => setStatus(event.target.value as "SUCCEEDED" | "FAILED")}
        >
          <option value="SUCCEEDED">Berhasil (SUCCEEDED)</option>
          <option value="FAILED">Gagal (FAILED)</option>
        </SelectInput>
        <TextInput label="Referensi" value={reference} onChange={(event) => setReference(event.target.value)} />
        <TextArea label="Catatan" rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
        <div className="cluster">
          <Badge tone="neutral">Nominal: {formatIDR(refund?.amount)}</Badge>
        </div>
      </form>
    </Dialog>
  );
}
