"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  availabilityApi,
  catalogApi,
  orderApi,
  paymentSettingsApi,
  reservationApi,
  type Schema,
} from "@/shared/api/endpoints";
import { describeApiError, extractConflicts, isConflict } from "@/shared/api/errors";
import { can, type Role } from "@/shared/auth/permissions";
import { useSession } from "@/shared/auth/session";
import { formatIDR, rentalDays } from "@/shared/format/currency";
import { formatDateRange, isoToZonedLocal, zonedLocalToIso } from "@/shared/format/date";
import { contextLabel, methodLabel, orderStatus } from "@/shared/format/status";
import { useApi } from "@/shared/hooks/useApi";
import { Button, LinkButton } from "@/shared/ui/buttons";
import { SelectInput, TextInput } from "@/shared/ui/form";
import { InlineAlert, LoadingBlock, QueryState } from "@/shared/ui/states";
import { Badge, PageHeader, Panel, PanelBody, PanelHead, StatusBadge } from "@/shared/ui/surfaces";
import { WhatsAppMessageCard } from "@/shared/ui/whatsapp-message";
import { blocksUnavailableBooking } from "@/features/catalog/policy";

type Product = Schema<"ProductResponse">;
type Method = "CASH" | "BANK_TRANSFER" | "QRIS";

interface CartLine {
  key: string;
  productId: string;
  quantity: number;
}

interface CheckoutResult {
  reservation: Schema<"ReservationResponse"> | null;
  order: Schema<"OrderResponse"> | null;
  messages: Schema<"WhatsAppMessageResponse">[];
}

function defaultPeriod() {
  const start = new Date(Date.now() + 60 * 60 * 1000);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start: isoToZonedLocal(start.toISOString()), end: isoToZonedLocal(end.toISOString()) };
}

export function PosPage() {
  const { tenantId, tenant, role } = useSession();
  const timezone = tenant?.timezone ?? "Asia/Jakarta";
  const canCreate = can(role as Role | undefined, "reservation.create");
  const canPayment = can(role as Role | undefined, "payment.record");

  const initial = defaultPeriod();
  const [start, setStart] = useState(initial.start);
  const [end, setEnd] = useState(initial.end);
  const [search, setSearch] = useState("");
  const [lines, setLines] = useState<CartLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [result, setResult] = useState<CheckoutResult | null>(null);

  const [method, setMethod] = useState<Method | "">("");
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [paymentBusy, setPaymentBusy] = useState(false);
  const [paymentMessage, setPaymentMessage] = useState<Schema<"WhatsAppMessageResponse"> | null>(null);

  const productsState = useApi<Product[]>(
    tenantId ? () => catalogApi.listProducts(tenantId, { isActive: true }) : null,
    [tenantId],
  );
  const methodsState = useApi(
    tenantId ? () => paymentSettingsApi.list(tenantId) : null,
    [tenantId],
  );

  const products = useMemo(() => productsState.data ?? [], [productsState.data]);
  const activeMethods = useMemo(() => {
    const settings = methodsState.data?.settings ?? [];
    return settings
      .filter((item) => item.context === "NEW_BOOKING" && item.enabled !== false)
      .map((item) => item.method as Method);
  }, [methodsState.data]);

  const startIso = zonedLocalToIso(start, timezone);
  const endIso = zonedLocalToIso(end, timezone);
  const days = startIso && endIso ? rentalDays(startIso, endIso) : 0;

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return products.filter((product) => !term || (product.name ?? "").toLowerCase().includes(term));
  }, [products, search]);

  const estimate = useMemo(() => {
    return lines.reduce((total, line) => {
      const product = products.find((item) => item.id === line.productId);
      const perDay = Number.parseInt(product?.rate?.perDayAmount ?? "0", 10);
      return total + (Number.isFinite(perDay) ? perDay * days * line.quantity : 0);
    }, 0);
  }, [lines, products, days]);

  const addLine = (productId: string) => {
    setLines((current) => {
      const existing = current.find((line) => line.productId === productId);
      if (existing) {
        return current.map((line) =>
          line.productId === productId ? { ...line, quantity: line.quantity + 1 } : line,
        );
      }
      return [...current, { key: crypto.randomUUID(), productId, quantity: 1 }];
    });
  };

  const updateQuantity = (key: string, quantity: number) => {
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, quantity: Math.max(1, quantity) } : line)),
    );
  };

  const checkout = async () => {
    setError(null);
    setWarning(null);
    if (!tenantId) return;
    if (!startIso || !endIso || new Date(endIso) <= new Date(startIso)) {
      setError("Periode sewa tidak valid. Waktu selesai harus setelah waktu mulai.");
      return;
    }
    if (lines.length === 0) {
      setError("Keranjang masih kosong.");
      return;
    }
    if (activeMethods.length === 0) {
      setError("Belum ada metode pembayaran aktif untuk booking baru. Atur di Pengaturan → Metode pembayaran.");
      return;
    }

    setBusy(true);
    try {
      // Pemeriksaan awal; alokasi final tetap di server saat submit.
      const checks = await Promise.all(
        lines.map((line) =>
          availabilityApi
            .check(tenantId, { productId: line.productId, startAt: startIso, endAt: endIso })
            .catch(() => null),
        ),
      );
      const unavailable = lines.filter((line, index) => {
        const check = checks[index];
        return check ? (check.available ?? 0) < line.quantity : true;
      });

      // Opsi B memblokir booking baru saat stok kosong; Opsi A tetap
      // mengirim permintaan PENDING_APPROVAL tanpa alokasi (Notion 14/16).
      if (unavailable.length > 0 && blocksUnavailableBooking(tenant?.catalogPolicy)) {
        setWarning(
          "Stok tidak tersedia untuk periode ini (policy Opsi B). Booking diblokir; gunakan tombol Tanyakan via WhatsApp dari katalog atau ubah periode.",
        );
        return;
      }
      if (unavailable.length > 0) {
        setWarning(
          "Stok belum tersedia (policy Opsi A). Permintaan akan dikirim sebagai PENDING_APPROVAL tanpa alokasi dan tanpa konfirmasi otomatis.",
        );
      }

      const reservation = await reservationApi.create(
        tenantId,
        {
          startAt: startIso,
          endAt: endIso,
          items: lines.map((line) => ({ productId: line.productId, quantity: line.quantity })),
        },
        crypto.randomUUID(),
      );

      if (reservation.status !== "CONFIRMED") {
        setResult({ reservation, order: null, messages: [] });
        return;
      }

      const order = await reservationApi.convertToOrder(tenantId, reservation.id ?? "");
      setResult({
        reservation,
        order,
        messages: order.whatsappMessages ?? [],
      });
      setAmount(order.outstandingAmount ?? order.totalAmount ?? "");
    } catch (caught) {
      if (isConflict(caught)) {
        const conflicts = extractConflicts(caught);
        setError(
          conflicts.length > 0
            ? `Konflik ketersediaan: ${conflicts
                .map((conflict) => `${conflict.productName ?? "produk"} (${formatDateRange(conflict.startAt, conflict.endAt, timezone)})`)
                .join("; ")}. Tidak ada alokasi parsial; ubah pilihan lalu coba lagi.`
            : describeApiError(caught),
        );
      } else {
        setError(describeApiError(caught));
      }
    } finally {
      setBusy(false);
    }
  };

  const recordPayment = async () => {
    if (!tenantId || !result?.order?.id || !method) return;
    setPaymentBusy(true);
    setError(null);
    try {
      const payment = await orderApi.recordPayment(
        tenantId,
        result.order.id,
        {
          amount: amount.replace(/\D/g, ""),
          currency: "IDR",
          method,
          context: "NEW_BOOKING",
          reference: reference.trim() || undefined,
        },
        crypto.randomUUID(),
      );
      setPaymentMessage(payment.whatsappMessage ?? null);
      const refreshed = await orderApi.get(tenantId, result.order.id);
      setResult({ ...result, order: refreshed });
      setAmount(refreshed.outstandingAmount ?? "0");
      setReference("");
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setPaymentBusy(false);
    }
  };

  const reset = () => {
    setResult(null);
    setLines([]);
    setError(null);
    setWarning(null);
    setPaymentMessage(null);
    setMethod("");
    const next = defaultPeriod();
    setStart(next.start);
    setEnd(next.end);
  };

  return (
    <div className="page">
      <PageHeader
        title="Kasir (POS)"
        subtitle="Pilih barang sewaan, atur tanggal sewa, cek ketersediaan stok, dan catat pembayarannya langsung."
        actions={<LinkButton href="/app/orders">Daftar pesanan</LinkButton>}
      />

      {!canCreate ? (
        <InlineAlert tone="warning">
          Akun kamu tidak punya izin buat pesanan baru ya.
        </InlineAlert>
      ) : null}

      {error ? (
        <InlineAlert tone="danger">
          <span role="alert">{error}</span>
        </InlineAlert>
      ) : null}
      {warning ? <InlineAlert tone="warning">{warning}</InlineAlert> : null}

      {result ? (
        <CheckoutSummary
          result={result}
          timezone={timezone}
          methods={activeMethods.length > 0 ? activeMethods : ["CASH", "BANK_TRANSFER", "QRIS"]}
          method={method}
          onMethodChange={setMethod}
          amount={amount}
          onAmountChange={setAmount}
          reference={reference}
          onReferenceChange={setReference}
          onRecordPayment={() => void recordPayment()}
          paymentBusy={paymentBusy}
          paymentMessage={paymentMessage}
          canPayment={canPayment}
          onReset={reset}
        />
      ) : (
        <div className="pos-layout">
          <Panel flush>
            <PanelHead title="Pilih barang" description="Hanya produk aktif. Tarif diambil dari server." />
            <PanelBody>
              <TextInput
                label="Cari produk"
                placeholder="Nama produk"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </PanelBody>
            <QueryState state={productsState} loadingRows={4} isEmpty={(list) => list.length === 0} empty={<p className="panel-body text-muted">Belum ada produk aktif.</p>}>
              {() => (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Produk</th>
                        <th scope="col">Tipe</th>
                        <th scope="col" className="num">
                          Tarif/hari
                        </th>
                        <th scope="col" className="text-right">
                          Aksi
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((product) => (
                        <tr key={product.id}>
                          <td>{product.name}</td>
                          <td className="text-sm">
                            {product.stockMode === "INDIVIDUAL_UNITS" ? "Unit" : "Kuantitas"}
                          </td>
                          <td className="num money">
                            {product.rate?.perDayAmount ? formatIDR(product.rate.perDayAmount) : "—"}
                          </td>
                          <td>
                            <div className="table-actions">
                              <Button size="sm" onClick={() => product.id && addLine(product.id)}>
                                Tambah
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                      {filtered.length === 0 ? (
                        <tr className="table-empty">
                          <td colSpan={4}>Tidak ada produk yang cocok.</td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              )}
            </QueryState>
          </Panel>

          <div className="stack">
            <Panel>
              <PanelHead title="Periode sewa" description={`Zona waktu ${timezone}`} />
              <PanelBody>
                <div className="stack">
                  <TextInput
                    label="Mulai"
                    type="datetime-local"
                    required
                    value={start}
                    onChange={(event) => setStart(event.target.value)}
                  />
                  <TextInput
                    label="Selesai"
                    type="datetime-local"
                    required
                    value={end}
                    onChange={(event) => setEnd(event.target.value)}
                  />
                  <p className="text-xs text-muted">
                    {days > 0 ? `${days} hari sewa. ` : "Periode belum valid. "}
                    Rentang half-open [mulai, selesai).
                  </p>
                </div>
              </PanelBody>
            </Panel>

            <Panel flush>
              <PanelHead title={`Keranjang (${lines.length})`} />
              {lines.length === 0 ? (
                <p className="panel-body text-muted">Belum ada item. Pilih produk di kiri.</p>
              ) : (
                <>
                  {lines.map((line) => {
                    const product = products.find((item) => item.id === line.productId);
                    return (
                      <div className="cart-line" key={line.key}>
                        <div>
                          <div>{product?.name ?? "Produk"}</div>
                          <div className="text-xs text-muted">
                            {formatIDR(product?.rate?.perDayAmount)} / hari
                          </div>
                        </div>
                        <div className="row">
                          <TextInput
                            label="Jumlah"
                            inputMode="numeric"
                            value={String(line.quantity)}
                            onChange={(event) =>
                              updateQuantity(
                                line.key,
                                Number.parseInt(event.target.value.replace(/\D/g, "") || "1", 10),
                              )
                            }
                            wrapperClassName="hide-label"
                          />
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Hapus ${product?.name ?? "item"}`}
                            onClick={() =>
                              setLines((current) => current.filter((item) => item.key !== line.key))
                            }
                          >
                            Hapus
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                  <div className="panel-body stack-sm">
                    <div className="total-row">
                      <span>Estimasi biaya</span>
                      <span className="money">{formatIDR(estimate)}</span>
                    </div>
                    <p className="text-xs text-muted">
                      Estimasi lokal dari tarif harian × {days} hari. Server menghitung ulang total final
                      saat reservasi dikonversi menjadi pesanan.
                    </p>
                    <Button variant="primary" size="lg" block loading={busy} onClick={() => void checkout()}>
                      Periksa & buat transaksi
                    </Button>
                  </div>
                </>
              )}
            </Panel>

            <Panel>
              <PanelHead
                title="Metode pembayaran aktif"
                description="Konfigurasi tenant untuk konteks booking baru."
              />
              <PanelBody>
                {methodsState.initialLoading ? (
                  <LoadingBlock rows={1} />
                ) : (
                  <div className="cluster">
                    {activeMethods.length === 0 ? (
                      <Badge tone="danger">Tidak ada metode aktif</Badge>
                    ) : (
                      activeMethods.map((item) => (
                        <Badge key={item} tone="info">
                          {methodLabel(item).label}
                        </Badge>
                      ))
                    )}
                  </div>
                )}
                <p className="text-xs text-muted" style={{ marginTop: "var(--sw-space-2)" }}>
                  Cash tidak otomatis lunas. Transfer/QRIS dicatat setelah petugas memverifikasi.
                </p>
              </PanelBody>
            </Panel>
          </div>
        </div>
      )}
    </div>
  );
}

function CheckoutSummary({
  result,
  timezone,
  methods,
  method,
  onMethodChange,
  amount,
  onAmountChange,
  reference,
  onReferenceChange,
  onRecordPayment,
  paymentBusy,
  paymentMessage,
  canPayment,
  onReset,
}: {
  result: CheckoutResult;
  timezone: string;
  methods: Method[];
  method: Method | "";
  onMethodChange: (value: Method) => void;
  amount: string;
  onAmountChange: (value: string) => void;
  reference: string;
  onReferenceChange: (value: string) => void;
  onRecordPayment: () => void;
  paymentBusy: boolean;
  paymentMessage: Schema<"WhatsAppMessageResponse"> | null;
  canPayment: boolean;
  onReset: () => void;
}) {
  const order = result.order;
  const reservation = result.reservation;

  return (
    <div className="stack">
      <Panel>
        <PanelHead
          title={order ? `Pesanan ${order.orderNumber ?? ""}` : "Permintaan booking terkirim"}
          actions={
            <div className="cluster">
              {order?.id ? (
                <LinkButton size="sm" href={`/app/orders/${order.id}`}>
                  Buka detail pesanan
                </LinkButton>
              ) : null}
              <Button size="sm" variant="ghost" onClick={onReset}>
                Transaksi baru
              </Button>
            </div>
          }
        />
        <PanelBody>
          <div className="grid-2">
            <div className="stack-sm">
              <h3 className="panel-title">Status terpisah</h3>
              <div className="cluster">
                <span className="text-sm text-muted">Booking:</span>
                <StatusBadge status={{ label: reservation?.status === "CONFIRMED" ? "Terkonfirmasi" : "Menunggu persetujuan", tone: reservation?.status === "CONFIRMED" ? "success" : "warning" }} />
                {order ? (
                  <>
                    <span className="text-sm text-muted">Lifecycle:</span>
                    <StatusBadge status={orderStatus(order.status)} />
                  </>
                ) : null}
                <span className="text-sm text-muted">Pembayaran:</span>
                <Badge tone={Number(order?.paidAmount ?? 0) > 0 ? "success" : "neutral"}>
                  {Number(order?.paidAmount ?? 0) > 0 ? "Ada pembayaran tercatat" : "Belum tercatat"}
                </Badge>
              </div>
              <p className="text-sm text-muted">Periode {formatDateRange(reservation?.startAt, reservation?.endAt, timezone)}</p>
              {reservation?.status !== "CONFIRMED" ? (
                <InlineAlert tone="warning">
                  Booking manual menunggu persetujuan admin. Stok belum dialokasikan permanen dan
                  pesanan belum dibuat.
                </InlineAlert>
              ) : null}
            </div>
            {order ? (
              <div className="stack-sm">
                <div className="total-row">
                  <span>Total tagihan</span>
                  <span className="money">{formatIDR(order.totalAmount)}</span>
                </div>
                <div className="total-row">
                  <span>Sudah dibayar</span>
                  <span className="money">{formatIDR(order.paidAmount)}</span>
                </div>
                <div className="total-row total-row-strong">
                  <span>Sisa tagihan</span>
                  <span className="money">{formatIDR(order.outstandingAmount)}</span>
                </div>
              </div>
            ) : null}
          </div>
        </PanelBody>
      </Panel>

      {result.messages.length > 0 ? (
        <Panel flush>
          <PanelHead
            title="Pesan WhatsApp siap kirim"
            description="Snapshot dari server. Sistem tidak mengirim otomatis; pengguna menekan Kirim di WhatsApp."
          />
          <PanelBody>
            <div className="stack">
              {result.messages.map((message) => (
                <WhatsAppMessageCard key={message.id} message={message} />
              ))}
            </div>
          </PanelBody>
        </Panel>
      ) : null}

      {order && canPayment ? (
        <Panel>
          <PanelHead
            title="Catat pembayaran manual"
            description="Hanya catat setelah uang benar-benar diterima atau transfer diverifikasi."
          />
          <PanelBody>
            <div className="stack">
              {paymentMessage ? <WhatsAppMessageCard message={paymentMessage} /> : null}
              <div className="form-grid">
                <SelectInput
                  label="Metode"
                  required
                  value={method}
                  onChange={(event) => onMethodChange(event.target.value as Method)}
                >
                  <option value="">Pilih metode</option>
                  {methods.map((item) => (
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
                  onChange={(event) => onAmountChange(event.target.value.replace(/\D/g, ""))}
                  hint="Nilai default = sisa tagihan menurut server."
                />
                <TextInput
                  label="Referensi (opsional)"
                  value={reference}
                  onChange={(event) => onReferenceChange(event.target.value)}
                  hint="Nomor referensi transfer/bukti pembayaran."
                />
              </div>
              <p className="text-xs text-muted">
                Konteks pembayaran: {contextLabel("NEW_BOOKING").label}. Metode nonaktif ditolak server
                (422 PAYMENT_METHOD_DISABLED).
              </p>
              <div className="form-actions">
                <Button
                  variant="primary"
                  loading={paymentBusy}
                  disabled={!method || !amount}
                  onClick={onRecordPayment}
                >
                  Catat pembayaran
                </Button>
              </div>
            </div>
          </PanelBody>
        </Panel>
      ) : null}

      <p className="text-xs text-muted">
        {order?.id ? (
          <>
            Butuh ubah jumlah atau perpanjangan? Lanjutkan dari{" "}
            <Link href={`/app/orders/${order.id}`}>detail pesanan</Link>.
          </>
        ) : (
          <>
            Perubahan jumlah dan perpanjangan baru bisa dilakukan setelah pesanan dibuat, yaitu setelah
            booking disetujui di <Link href="/app/orders">daftar pesanan</Link>.
          </>
        )}
      </p>
    </div>
  );
}

