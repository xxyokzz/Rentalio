"use client";

import { useState } from "react";
import { orderApi, type Schema } from "@/shared/api/endpoints";
import { describeApiError } from "@/shared/api/errors";
import { can, type Role } from "@/shared/auth/permissions";
import { useSession } from "@/shared/auth/session";
import { formatIDR } from "@/shared/format/currency";
import { formatDateTime } from "@/shared/format/date";
import { depositMovementStatus, depositRequestStatus, methodLabel } from "@/shared/format/status";
import { Button } from "@/shared/ui/buttons";
import { SelectInput, TextArea, TextInput } from "@/shared/ui/form";
import { ConfirmDialog, Dialog, useToast } from "@/shared/ui/overlays";
import { Badge, Panel, PanelHead, StatusBadge } from "@/shared/ui/surfaces";
import { InlineAlert } from "@/shared/ui/states";

type Order = Schema<"OrderResponse">;
type Movement = Schema<"DepositMovementResponse">;
type DeductionRequest = Schema<"DepositDeductionRequestResponse">;

export function DepositPanel({
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
  const canReceive = can(role as Role | undefined, "deposit.receive");
  const canDeduct = can(role as Role | undefined, "deposit.deduct");
  const canApprove = can(role as Role | undefined, "deposit.deduct.approve");
  const canRefund = can(role as Role | undefined, "deposit.refund");

  const deposit = order.deposit;
  const movements = deposit?.movements ?? [];
  const requests = deposit?.deductionRequests ?? [];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<DeductionRequest | null>(null);
  const [reversing, setReversing] = useState<Movement | null>(null);

  const [receiptAmount, setReceiptAmount] = useState("");
  const [receiptMethod, setReceiptMethod] = useState("");
  const [receiptRef, setReceiptRef] = useState("");

  const [deductAmount, setDeductAmount] = useState("");
  const [deductReason, setDeductReason] = useState("");
  const [deductNote, setDeductNote] = useState("");

  const [refundAmount, setRefundAmount] = useState("");
  const [refundReason, setRefundReason] = useState("");

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

  return (
    <div className="stack">
      <Panel>
        <PanelHead
          title="Saldo deposit"
          description="Saldo dihitung dari ledger; tidak pernah negatif dan tidak boleh diubah manual."
        />
        <div className="panel-body stack">
          {error ? (
            <InlineAlert tone="danger">
              <span role="alert">{error}</span>
            </InlineAlert>
          ) : null}
          <div className="row-between">
            <span className="stat-value money">{formatIDR(deposit?.balance ?? "0")}</span>
            <Badge tone="neutral">Dipisahkan dari refund pembayaran</Badge>
          </div>

          {canReceive ? (
            <div className="form-grid">
              <TextInput
                label="Terima deposit (Rp)"
                inputMode="numeric"
                value={receiptAmount}
                onChange={(event) => setReceiptAmount(event.target.value.replace(/\D/g, ""))}
                hint="Catat setelah dana benar-benar diterima."
              />
              <SelectInput label="Metode" value={receiptMethod} onChange={(event) => setReceiptMethod(event.target.value)}>
                <option value="">Tanpa metode</option>
                <option value="CASH">Tunai</option>
                <option value="BANK_TRANSFER">Transfer bank</option>
                <option value="QRIS">QRIS</option>
              </SelectInput>
              <TextInput label="Referensi" value={receiptRef} onChange={(event) => setReceiptRef(event.target.value)} />
              <div className="form-actions" style={{ alignItems: "flex-end" }}>
                <Button
                  variant="primary"
                  loading={busy}
                  disabled={!receiptAmount}
                  onClick={() =>
                    void run(
                      () =>
                        orderApi.receiveDeposit(tenantId, order.id ?? "", {
                          amount: receiptAmount.replace(/\D/g, ""),
                          currency: "IDR",
                          ...(receiptMethod
                            ? { method: receiptMethod as "CASH" | "BANK_TRANSFER" | "QRIS" }
                            : {}),
                          reference: receiptRef.trim() || undefined,
                        }),
                      "Penerimaan deposit dicatat.",
                    )
                  }
                >
                  Catat penerimaan
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </Panel>

      {canDeduct ? (
        <Panel>
          <PanelHead
            title="Ajukan potongan deposit"
            description="Potongan dua langkah: pengaju dan penyetuju harus aktor berbeda. Saldo belum berubah saat pengajuan."
          />
          <div className="panel-body stack">
            <div className="form-grid">
              <TextInput
                label="Nominal potongan (Rp)"
                inputMode="numeric"
                value={deductAmount}
                onChange={(event) => setDeductAmount(event.target.value.replace(/\D/g, ""))}
              />
              <TextInput
                label="Alasan"
                required
                value={deductReason}
                onChange={(event) => setDeductReason(event.target.value)}
                hint="Contoh: kerusakan ringan unit A-02."
              />
            </div>
            <TextArea
              label="Catatan kondisi (opsional)"
              rows={2}
              value={deductNote}
              onChange={(event) => setDeductNote(event.target.value)}
              hint="Bandingkan kondisi awal serah-terima dan kondisi saat pengembalian."
            />
            <div className="form-actions">
              <Button
                loading={busy}
                disabled={!deductAmount || deductReason.trim().length < 3}
                onClick={() =>
                  void run(
                    () =>
                      orderApi.requestDepositDeduction(tenantId, order.id ?? "", {
                        amount: deductAmount.replace(/\D/g, ""),
                        currency: "IDR",
                        reason: deductReason.trim(),
                        conditionNotes: deductNote.trim() || undefined,
                      }),
                    "Pengajuan potongan dikirim untuk persetujuan aktor lain.",
                  )
                }
              >
                Ajukan potongan
              </Button>
            </div>
          </div>
        </Panel>
      ) : null}

      <Panel flush>
        <PanelHead title="Permintaan potongan" />
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Diajukan</th>
                <th scope="col" className="num">
                  Nominal
                </th>
                <th scope="col">Status</th>
                <th scope="col">Alasan</th>
                <th scope="col" className="text-right">
                  Aksi
                </th>
              </tr>
            </thead>
            <tbody>
              {requests.length === 0 ? (
                <tr className="table-empty">
                  <td colSpan={5}>Belum ada permintaan potongan.</td>
                </tr>
              ) : (
                requests.map((request) => (
                  <tr key={request.id}>
                    <td className="text-sm">{formatDateTime(request.createdAt, timezone)}</td>
                    <td className="num money">{formatIDR(request.amount)}</td>
                    <td>
                      <StatusBadge status={depositRequestStatus(request.status)} />
                    </td>
                    <td className="text-sm">
                      {request.reason}
                      {request.conditionNotes ? (
                        <div className="text-xs text-muted">{request.conditionNotes}</div>
                      ) : null}
                    </td>
                    <td>
                      <div className="table-actions">
                        {canApprove && request.status === "PENDING" ? (
                          <>
                            <Button
                              size="sm"
                              variant="primary"
                              loading={busy}
                              onClick={() =>
                                void run(
                                  () => orderApi.approveDepositDeduction(tenantId, request.id ?? "", {}),
                                  "Potongan disetujui dan movement DEDUCTION dibuat.",
                                )
                              }
                            >
                              Setujui
                            </Button>
                            <Button size="sm" variant="danger" onClick={() => setRejecting(request)}>
                              Tolak
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

      {canRefund ? (
        <Panel>
          <PanelHead title="Refund deposit" description="Movement REFUND terpisah dari refund payment." />
          <div className="panel-body">
            <div className="form-grid">
              <TextInput
                label="Nominal refund (Rp)"
                inputMode="numeric"
                value={refundAmount}
                onChange={(event) => setRefundAmount(event.target.value.replace(/\D/g, ""))}
              />
              <TextInput
                label="Alasan"
                required
                value={refundReason}
                onChange={(event) => setRefundReason(event.target.value)}
              />
              <div className="form-actions" style={{ alignItems: "flex-end" }}>
                <Button
                  variant="primary"
                  loading={busy}
                  disabled={!refundAmount || refundReason.trim().length < 3}
                  onClick={() =>
                    void run(
                      () =>
                        orderApi.refundDeposit(tenantId, order.id ?? "", {
                          amount: refundAmount.replace(/\D/g, ""),
                          currency: "IDR",
                          reason: refundReason.trim(),
                        }),
                      "Refund deposit dicatat.",
                    )
                  }
                >
                  Refund deposit
                </Button>
              </div>
            </div>
          </div>
        </Panel>
      ) : null}

      <Panel flush>
        <PanelHead title="Ledger deposit" description="Append-only: koreksi memakai REVERSAL berizin." />
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Waktu</th>
                <th scope="col">Jenis</th>
                <th scope="col" className="num">
                  Nominal
                </th>
                <th scope="col">Metode</th>
                <th scope="col">Alasan</th>
                <th scope="col" className="text-right">
                  Aksi
                </th>
              </tr>
            </thead>
            <tbody>
              {movements.length === 0 ? (
                <tr className="table-empty">
                  <td colSpan={6}>Belum ada pergerakan deposit.</td>
                </tr>
              ) : (
                movements.map((movement) => (
                  <tr key={movement.id}>
                    <td className="text-sm">{formatDateTime(movement.createdAt, timezone)}</td>
                    <td>
                      <StatusBadge status={depositMovementStatus(movement.type)} />
                    </td>
                    <td className="num money">{formatIDR(movement.amount)}</td>
                    <td className="text-sm">{movement.method ? methodLabel(movement.method).label : "—"}</td>
                    <td className="text-sm">{movement.reason ?? "—"}</td>
                    <td>
                      <div className="table-actions">
                        {canApprove && movement.type !== "REVERSAL" ? (
                          <Button size="sm" variant="ghost" onClick={() => setReversing(movement)}>
                            Reversal
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

      <ConfirmDialog
        open={Boolean(rejecting)}
        onClose={() => setRejecting(null)}
        onConfirm={async (reason) => {
          if (!rejecting?.id) return;
          await run(
            () => orderApi.rejectDepositDeduction(tenantId, rejecting.id ?? "", { reason }),
            "Pengajuan potongan ditolak tanpa movement.",
          );
          setRejecting(null);
        }}
        title="Tolak potongan deposit?"
        consequence="Pengajuan berubah menjadi REJECTED dan tidak ada movement deposit yang dibuat."
        confirmLabel="Tolak pengajuan"
        destructive
        requireReason
      />

      <ConfirmDialog
        open={Boolean(reversing)}
        onClose={() => setReversing(null)}
        onConfirm={async (reason) => {
          if (!reversing?.id) return;
          await run(
            () =>
              orderApi.reverseDepositMovement(tenantId, order.id ?? "", reversing.id ?? "", { reason }),
            "Movement dibalik dengan REVERSAL. Movement asal tetap tersimpan.",
          );
          setReversing(null);
        }}
        title="Buat reversal movement?"
        consequence="Satu movement hanya dapat dibalik sekali. Saldo dihitung ulang dari ledger; baris asal tidak dihapus."
        confirmLabel="Buat reversal"
        requireReason
        reasonLabel="Alasan reversal"
      />
    </div>
  );
}
