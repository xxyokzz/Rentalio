"use client";

import { useState } from "react";
import {
  availabilityApi,
  reservationApi,
  type Schema,
} from "@/shared/api/endpoints";
import { describeApiError, extractConflicts, isConflict } from "@/shared/api/errors";
import { formatDateRange, isoToZonedLocal, zonedLocalToIso } from "@/shared/format/date";
import { Button } from "@/shared/ui/buttons";
import { SelectInput, TextInput } from "@/shared/ui/form";
import { Dialog } from "@/shared/ui/overlays";
import { InlineAlert } from "@/shared/ui/states";

type Product = Schema<"ProductResponse">;
type Availability = Schema<"AvailabilityResponse">;

interface CartItem {
  key: string;
  productId: string;
  quantity: number;
}

function defaultPeriod(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(now.getTime() + 60 * 60 * 1000);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return {
    start: isoToZonedLocal(start.toISOString()),
    end: isoToZonedLocal(end.toISOString()),
  };
}

export function CreateReservationDialog({
  open,
  onClose,
  tenantId,
  products,
  timezone,
  bookingMode,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  tenantId: string | null;
  products: Product[];
  timezone: string;
  bookingMode?: string;
  onCreated: (reservation: Schema<"ReservationResponse">) => void;
}) {
  const initial = defaultPeriod();
  const [start, setStart] = useState(initial.start);
  const [end, setEnd] = useState(initial.end);
  const [items, setItems] = useState<CartItem[]>([
    { key: crypto.randomUUID(), productId: "", quantity: 1 },
  ]);
  const [availability, setAvailability] = useState<Record<string, Availability | null>>({});
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<ReturnType<typeof extractConflicts>>([]);

  const startIso = zonedLocalToIso(start, timezone);
  const endIso = zonedLocalToIso(end, timezone);

  const updateItem = (key: string, patch: Partial<CartItem>) => {
    setItems((current) => current.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  };

  const checkAvailability = async () => {
    setError(null);
    setAvailability({});
    if (!tenantId || !startIso || !endIso) {
      setError("Isi periode sewa terlebih dahulu.");
      return;
    }
    if (new Date(endIso) <= new Date(startIso)) {
      setError("Waktu selesai harus setelah waktu mulai.");
      return;
    }
    const valid = items.filter((item) => item.productId);
    if (valid.length === 0) {
      setError("Pilih minimal satu produk.");
      return;
    }
    setChecking(true);
    try {
      const results = await Promise.all(
        valid.map((item) =>
          availabilityApi
            .check(tenantId, { productId: item.productId, startAt: startIso, endAt: endIso })
            .then((value) => [item.productId, value] as const)
            .catch(() => [item.productId, null] as const),
        ),
      );
      setAvailability(Object.fromEntries(results));
    } finally {
      setChecking(false);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setConflicts([]);
    if (!tenantId || !startIso || !endIso) {
      setError("Periode sewa tidak valid.");
      return;
    }
    const validItems = items
      .filter((item) => item.productId && item.quantity > 0)
      .map((item) => ({ productId: item.productId, quantity: item.quantity }));
    if (validItems.length === 0) {
      setError("Pilih minimal satu produk dengan jumlah lebih dari 0.");
      return;
    }
    setBusy(true);
    try {
      const reservation = await reservationApi.create(
        tenantId,
        { startAt: startIso, endAt: endIso, items: validItems },
        crypto.randomUUID(),
      );
      onCreated(reservation);
    } catch (caught) {
      setError(describeApiError(caught));
      if (isConflict(caught)) {
        setConflicts(extractConflicts(caught));
        void checkAvailability();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Buat booking baru"
      description={`Mode booking toko: ${bookingMode === "MANUAL" ? "manual (perlu persetujuan admin)" : "otomatis (langsung terkonfirmasi jika barang tersedia)"}.`}
      wide
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Batal
          </Button>
          <Button onClick={() => void checkAvailability()} loading={checking}>
            Cek ketersediaan
          </Button>
          <Button type="submit" form="create-reservation" variant="primary" loading={busy}>
            Simpan booking
          </Button>
        </>
      }
    >
      <form id="create-reservation" className="stack" onSubmit={submit} noValidate>
        {error ? (
          <InlineAlert tone="danger">
            <span role="alert">{error}</span>
          </InlineAlert>
        ) : null}
        {conflicts.length > 0 ? (
          <div className="inline-alert inline-alert-warning">
            <div className="stack-sm">
              <strong>Jadwal sewa bentrok dengan booking lain</strong>
              <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
                {conflicts.map((conflict, index) => (
                  <li key={`${conflict.allocationId ?? index}`}>
                    {conflict.productName ?? "Produk"} ·{" "}
                    {formatDateRange(conflict.startAt, conflict.endAt, timezone)}
                    {conflict.reason === "CAPACITY_EXCEEDED" ? " · kapasitas unit penuh" : " · unit tumpang tindih"}
                  </li>
                ))}
              </ul>
              <span className="text-sm">Ubah tanggal sewa atau pilih produk lain, lalu coba lagi.</span>
            </div>
          </div>
        ) : null}

        <div className="form-grid">
          <TextInput
            label={`Mulai (${timezone})`}
            type="datetime-local"
            required
            value={start}
            onChange={(event) => setStart(event.target.value)}
            hint="Tentukan tanggal dan jam mulai sewa."
          />
          <TextInput
            label={`Selesai (${timezone})`}
            type="datetime-local"
            required
            value={end}
            onChange={(event) => setEnd(event.target.value)}
            hint="Tentukan tanggal dan jam selesai sewa."
          />
        </div>

        <div className="stack-sm">
          <span className="label">Item sewaan</span>
          {items.map((item) => {
            const info = availability[item.productId];
            return (
              <div className="row" key={item.key}>
                <SelectInput
                  label="Produk"
                  value={item.productId}
                  onChange={(event) => updateItem(item.key, { productId: event.target.value })}
                  wrapperClassName="field-grow"
                >
                  <option value="">Pilih produk</option>
                  {products
                    .filter((product) => product.isActive !== false)
                    .map((product) => (
                      <option key={product.id} value={product.id}>
                        {product.name}
                      </option>
                    ))}
                </SelectInput>
                <TextInput
                  label="Jumlah"
                  inputMode="numeric"
                  value={String(item.quantity)}
                  onChange={(event) =>
                    updateItem(item.key, {
                      quantity: Math.max(1, Number.parseInt(event.target.value.replace(/\D/g, "") || "1", 10)),
                    })
                  }
                />
                {items.length > 1 ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setItems((current) => current.filter((entry) => entry.key !== item.key))}
                    aria-label="Hapus item"
                  >
                    Hapus
                  </Button>
                ) : null}
                {item.productId ? (
                  <span className="text-xs text-muted">
                    {info
                      ? `Tersedia ${info.available ?? 0} dari total ${info.capacity ?? 0}`
                      : "Belum dicek ketersediaannya"}
                  </span>
                ) : null}
              </div>
            );
          })}
          <div>
            <Button
              size="sm"
              onClick={() =>
                setItems((current) => [
                  ...current,
                  { key: crypto.randomUUID(), productId: "", quantity: 1 },
                ])
              }
            >
              Tambah item
            </Button>
          </div>
        </div>

        <p className="text-xs text-muted">
          Ketersediaan unit akan langsung diamankan saat kamu menyimpan booking ini.
        </p>
      </form>
    </Dialog>
  );
}
