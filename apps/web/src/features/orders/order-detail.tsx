"use client";

import Link from "next/link";
import { useState } from "react";
import {
  catalogApi,
  extensionApi,
  inspectionApi,
  orderApi,
  returnApi,
  type Schema,
} from "@/shared/api/endpoints";
import { describeApiError } from "@/shared/api/errors";
import { can, type Role } from "@/shared/auth/permissions";
import { useSession } from "@/shared/auth/session";
import { formatIDR } from "@/shared/format/currency";
import { formatDateTime, isoToZonedLocal, zonedLocalToIso } from "@/shared/format/date";
import { orderStatus } from "@/shared/format/status";
import { useApi } from "@/shared/hooks/useApi";
import { Button, LinkButton } from "@/shared/ui/buttons";
import { TextArea, TextInput } from "@/shared/ui/form";
import { ConfirmDialog, Dialog, useToast } from "@/shared/ui/overlays";
import {
  Badge,
  DefinitionList,
  PageHeader,
  Panel,
  PanelBody,
  PanelHead,
  Stat,
  StatusBadge,
} from "@/shared/ui/surfaces";
import { EmptyState, InlineAlert, QueryState } from "@/shared/ui/states";
import { Tabs } from "@/shared/ui/tabs";
import { WhatsAppMessageCard } from "@/shared/ui/whatsapp-message";
import { PaymentsPanel } from "./payments-panel";
import { DepositPanel } from "./deposit-panel";
import { CollateralPanel } from "./collateral-panel";
import { ReturnsPanel } from "./returns-panel";
import { buildProductNames, itemLabel } from "./item-label";
import { ExtensionsPanel } from "./extensions-panel";

type Order = Schema<"OrderResponse">;

interface OrderData {
  order: Order;
  refunds: Schema<"RefundResponse">[];
  returns: Schema<"ReturnRecordResponse">[];
  inspections: Schema<"InspectionResponse">[];
  extensions: Schema<"OrderExtensionResponse">[];
  productNames: Map<string, string>;
}

export function OrderDetail({ orderId }: { orderId: string }) {
  const { tenantId, tenant, role } = useSession();
  const { notify } = useToast();
  const timezone = tenant?.timezone ?? "Asia/Jakarta";
  const [tab, setTab] = useState("ringkasan");
  const [handoverOpen, setHandoverOpen] = useState(false);
  const [completeOpen, setCompleteOpen] = useState(false);
  const [readyBusy, setReadyBusy] = useState(false);

  const state = useApi<OrderData>(
    tenantId
      ? async () => {
          const [order, refunds, returns, inspections, extensions, products] = await Promise.all([
            orderApi.get(tenantId, orderId),
            orderApi.listRefunds(tenantId, orderId),
            returnApi.list(tenantId, orderId),
            inspectionApi.list(tenantId, orderId),
            extensionApi.list(tenantId, orderId),
            catalogApi.listProducts(tenantId).catch(() => []),
          ]);
          return {
            order,
            refunds,
            returns,
            inspections,
            extensions,
            productNames: buildProductNames(products),
          };
        }
      : null,
    [tenantId, orderId],
  );

  const order = state.data?.order;

  const markReady = async () => {
    if (!tenantId) return;
    setReadyBusy(true);
    try {
      await orderApi.markReadyForHandover(tenantId, orderId, {});
      notify("Pesanan siap serah-terima.", "success");
      state.reload();
    } catch (caught) {
      notify(describeApiError(caught), "error");
    } finally {
      setReadyBusy(false);
    }
  };

  return (
    <div className="page">
      <PageHeader
        breadcrumb={
          <>
            <Link href="/app/orders">Pesanan</Link>
            <span aria-hidden="true">/</span>
            <span>{order?.orderNumber ?? "Detail"}</span>
          </>
        }
        title="Detail pesanan"
        subtitle={
          order
            ? `Nomor ${order.orderNumber ?? "—"} · dibuat ${formatDateTime(order.createdAt, timezone)} · status lifecycle, pembayaran, deposit, dan alasan konflik ditampilkan terpisah.`
            : undefined
        }
        actions={
          order ? (
            <>
              {order.status === "CONFIRMED" && can(role as Role | undefined, "order.handover") ? (
                <Button variant="primary" loading={readyBusy} onClick={() => void markReady()}>
                  Tandai siap serah-terima
                </Button>
              ) : null}
              {order.status === "READY_FOR_HANDOVER" && can(role as Role | undefined, "order.handover") ? (
                <Button variant="primary" onClick={() => setHandoverOpen(true)}>
                  Catat serah-terima
                </Button>
              ) : null}
              {order.status === "RETURN_IN_PROGRESS" && can(role as Role | undefined, "order.return") ? (
                <Button variant="primary" onClick={() => setCompleteOpen(true)}>
                  Selesaikan pesanan
                </Button>
              ) : null}
              <LinkButton href="/app/orders">Kembali</LinkButton>
            </>
          ) : null
        }
      />

      <QueryState state={state} loadingRows={6}>
        {(data) => (
          <>
            {data.order.hasOpenConflict ? (
              <InlineAlert tone="danger">
                Pesanan ini terdampak konflik perpanjangan yang belum diselesaikan. Lifecycle tidak
                berubah otomatis; selesaikan tugas konflik di tab Perpanjangan atau halaman Konflik.
              </InlineAlert>
            ) : null}

            <div className="grid-4">
              <Stat label="Status lifecycle" value={<StatusBadge status={orderStatus(data.order.status)} />} />
              <Stat label="Total tagihan" value={<span className="money">{formatIDR(data.order.totalAmount)}</span>} />
              <Stat label="Dibayar" value={<span className="money">{formatIDR(data.order.paidAmount)}</span>} />
              <Stat
                label="Sisa tagihan"
                value={<span className="money">{formatIDR(data.order.outstandingAmount)}</span>}
                note="Pembayaran terpisah dari lifecycle"
              />
            </div>

            <Tabs
              items={[
                { id: "ringkasan", label: "Ringkasan" },
                { id: "pembayaran", label: "Pembayaran & refund", count: data.order.payments?.length ?? 0 },
                { id: "jaminan", label: "Jaminan" },
                { id: "pengembalian", label: "Pengembalian & inspeksi", count: data.returns.length },
                { id: "perpanjangan", label: "Perpanjangan", count: data.extensions.length },
                { id: "whatsapp", label: "Pesan WhatsApp", count: data.order.whatsappMessages?.length ?? 0 },
              ]}
              active={tab}
              onChange={setTab}
            >
              {tab === "ringkasan" ? (
                <div className="stack">
                  <div className="grid-2">
                    <Panel>
                      <PanelHead title="Informasi pesanan" />
                      <PanelBody>
                        <DefinitionList
                          items={[
                            { term: "Nomor pesanan", value: <span className="mono">{data.order.orderNumber ?? "—"}</span> },
                            { term: "Status lifecycle", value: <StatusBadge status={orderStatus(data.order.status)} /> },
                            { term: "Reservasi sumber", value: data.order.sourceReservationId ?? "—" },
                            { term: "Pelanggan", value: data.order.customerId ?? "Belum dicatat" },
                            {
                              term: "Saldo deposit",
                              value: <span className="money">{formatIDR(data.order.deposit?.balance ?? "0")}</span>,
                            },
                            { term: "Dibuat", value: formatDateTime(data.order.createdAt, timezone) },
                            { term: "Diperbarui", value: formatDateTime(data.order.updatedAt, timezone) },
                          ]}
                        />
                      </PanelBody>
                    </Panel>
                    <Panel>
                      <PanelHead title="Alur penyelesaian" />
                      <PanelBody>
                        <ol style={{ margin: 0, paddingLeft: "1.2rem" }} className="stack-sm">
                          <li>Konfirmasi pesanan → siap serah-terima.</li>
                          <li>Catat serah-terima (waktu, kondisi, bukti) → ACTIVE.</li>
                          <li>Catat pengembalian dan selesaikan → RETURN_IN_PROGRESS.</li>
                          <li>Inspeksi/denda, lalu selesaikan pesanan → COMPLETED.</li>
                        </ol>
                        <p className="text-xs text-muted">
                          Pembayaran belum lunas tidak otomatis menghalangi inspeksi/pengembalian; saldo
                          tetap ditampilkan.
                        </p>
                      </PanelBody>
                    </Panel>
                  </div>

                  <Panel flush>
                    <PanelHead title="Item pesanan" description="Harga snapshot dari server, bukan input browser." />
                    <div className="table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th scope="col">Produk</th>
                            <th scope="col">Unit</th>
                            <th scope="col" className="num">
                              Jumlah
                            </th>
                            <th scope="col">Periode</th>
                            <th scope="col" className="num">
                              Harga
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {(data.order.items ?? []).map((item) => (
                            <tr key={item.id}>
                              <td>{itemLabel({ productId: item.productId }, data.productNames)}</td>
                              <td className="mono text-sm">
                                {item.assetId ? `#${item.assetId.slice(-6)}` : "—"}
                              </td>
                              <td className="num">{item.quantity ?? 0}</td>
                              <td className="text-sm">
                                {formatDateTime(item.startAt, timezone)} – {formatDateTime(item.endAt, timezone)}
                              </td>
                              <td className="num money">{formatIDR(item.priceSnapshot)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Panel>

                  <InlineAlert tone="info">
                    Lampiran foto/bukti serah-terima dan inspeksi memerlukan endpoint upload storage yang
                    belum tersedia pada kontrak OpenAPI; UI tidak memalsukan unggahan.
                  </InlineAlert>
                </div>
              ) : null}

              {tab === "pembayaran" ? (
                tenantId ? (
                  <PaymentsPanel
                    tenantId={tenantId}
                    order={data.order}
                    refunds={data.refunds}
                    refundsLoading={false}
                    onChanged={state.reload}
                  />
                ) : null
              ) : null}

              {tab === "jaminan" ? (
                tenantId ? (
                  <div className="stack">
                    <CollateralPanel
                      tenantId={tenantId}
                      order={data.order}
                      onChanged={state.reload}
                    />
                    <h2 className="panel-title">Jaminan uang (opsional)</h2>
                    <DepositPanel tenantId={tenantId} order={data.order} onChanged={state.reload} />
                  </div>
                ) : null
              ) : null}

              {tab === "pengembalian" ? (
                tenantId ? (
                  <ReturnsPanel
                    tenantId={tenantId}
                    order={data.order}
                    returns={data.returns}
                    inspections={data.inspections}
                    productNames={data.productNames}
                    onChanged={state.reload}
                  />
                ) : null
              ) : null}

              {tab === "perpanjangan" ? (
                tenantId ? (
                  <ExtensionsPanel
                    tenantId={tenantId}
                    order={data.order}
                    extensions={data.extensions}
                    onChanged={state.reload}
                  />
                ) : null
              ) : null}

              {tab === "whatsapp" ? (
                <Panel>
                  <PanelHead
                    title="Riwayat pesan WhatsApp"
                    description="Snapshot immutable; mengubah template tidak menulis ulang histori."
                  />
                  <PanelBody>
                    {(data.order.whatsappMessages ?? []).length === 0 ? (
                      <EmptyState
                        title="Belum ada pesan"
                        description="Pesan dibuat saat konversi booking atau pencatatan pembayaran jika template aktif tersedia."
                      />
                    ) : (
                      <div className="stack">
                        {(data.order.whatsappMessages ?? []).map((message) => (
                          <WhatsAppMessageCard key={message.id} message={message} />
                        ))}
                      </div>
                    )}
                  </PanelBody>
                </Panel>
              ) : null}
            </Tabs>

            {/* `key` me-remount dialog setiap kali dibuka: waktu default dan pesan
                error lama tidak terbawa dari pembukaan sebelumnya. */}
            <HandoverDialog
              key={handoverOpen ? "handover-open" : "handover-closed"}
              open={handoverOpen}
              onClose={() => setHandoverOpen(false)}
              tenantId={tenantId}
              orderId={orderId}
              timezone={timezone}
              onSaved={() => {
                notify("Serah-terima dicatat; pesanan menjadi ACTIVE.", "success");
                setHandoverOpen(false);
                state.reload();
              }}
            />

            <ConfirmDialog
              open={completeOpen}
              onClose={() => setCompleteOpen(false)}
              onConfirm={async (note) => {
                if (!tenantId) return;
                try {
                  await orderApi.complete(tenantId, orderId, {
                    settlementNote: note.trim() || undefined,
                  });
                  notify("Pesanan selesai.", "success");
                  setCompleteOpen(false);
                  state.reload();
                } catch (caught) {
                  notify(describeApiError(caught), "error");
                }
              }}
              title="Selesaikan pesanan?"
              consequence="Pesanan menjadi COMPLETED. Hanya dapat dilakukan setelah pengembalian tercatat (RETURN_IN_PROGRESS). Pastikan deposit/refund dan denda sudah ditindaklanjuti sesuai kebijakan."
              confirmLabel="Selesaikan pesanan"
              requireReason={false}
            />
          </>
        )}
      </QueryState>
    </div>
  );
}

function HandoverDialog({
  open,
  onClose,
  tenantId,
  orderId,
  timezone,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  tenantId: string | null;
  orderId: string;
  timezone: string;
  onSaved: () => void;
}) {
  const [handoverAt, setHandoverAt] = useState(isoToZonedLocal(new Date().toISOString(), timezone));
  const [conditionNotes, setConditionNotes] = useState("");
  const [evidence, setEvidence] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setFormError(null);
    // Kesalahan ditampilkan di dalam dialog (persisten), bukan toast sekilas
    // yang mudah terlewat sehingga pengguna merasa tombol tidak bekerja.
    if (!tenantId) {
      setFormError("Sesi toko belum siap. Muat ulang halaman lalu coba lagi.");
      return;
    }
    const iso = zonedLocalToIso(handoverAt, timezone);
    if (!iso) {
      setFormError("Waktu serah-terima tidak valid.");
      return;
    }
    if (new Date(iso).getTime() > Date.now() + 60_000) {
      setFormError(
        "Waktu serah-terima tidak boleh di masa depan. Samakan jam perangkat ini dengan waktu server, lalu coba lagi.",
      );
      return;
    }
    if (conditionNotes.trim().length < 3) {
      setFormError("Catat kondisi awal barang minimal 3 karakter.");
      return;
    }
    setBusy(true);
    try {
      await orderApi.handover(tenantId, orderId, {
        handoverAt: iso,
        conditionNotes: conditionNotes.trim(),
        evidenceRefs: evidence
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      });
      onSaved();
    } catch (caught) {
      setFormError(describeApiError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Catat serah-terima"
      description="Kondisi awal menjadi pembanding saat pengembalian dan inspeksi."
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Batal
          </Button>
          <Button type="submit" form="handover" variant="primary" loading={busy}>
            Simpan serah-terima
          </Button>
        </>
      }
    >
      <form id="handover" className="stack" onSubmit={submit}>
        {formError ? <InlineAlert tone="danger">{formError}</InlineAlert> : null}
        <TextInput
          label={`Waktu serah-terima (${timezone})`}
          type="datetime-local"
          required
          value={handoverAt}
          onChange={(event) => setHandoverAt(event.target.value)}
        />
        <TextArea
          label="Kondisi awal barang"
          required
          rows={3}
          value={conditionNotes}
          onChange={(event) => setConditionNotes(event.target.value)}
          hint="Contoh: unit bersih, tanpa lecet, kelengkapan lengkap."
        />
        <TextInput
          label="Referensi bukti (opsional)"
          value={evidence}
          onChange={(event) => setEvidence(event.target.value)}
          hint="Pisahkan dengan koma bila lebih dari satu. Unggahan file belum tersedia di API."
        />
      </form>
    </Dialog>
  );
}
