"use client";

import { useMemo, useState } from "react";
import { paymentSettingsApi, type PaymentContext, type PaymentMethod } from "@/shared/api/endpoints";
import { describeApiError } from "@/shared/api/errors";
import { useSession } from "@/shared/auth/session";
import { contextLabel, methodLabel } from "@/shared/format/status";
import { useApi } from "@/shared/hooks/useApi";
import { Button } from "@/shared/ui/buttons";
import { useToast } from "@/shared/ui/overlays";
import { PageHeader, Panel, PanelHead } from "@/shared/ui/surfaces";
import { InlineAlert, LoadingBlock } from "@/shared/ui/states";

const CONTEXTS: PaymentContext[] = ["NEW_BOOKING", "ADD_UNIT", "EXTENSION"];
const METHODS: PaymentMethod[] = ["CASH", "BANK_TRANSFER", "QRIS"];

type Matrix = Record<PaymentContext, Record<PaymentMethod, boolean>>;

const DEFAULT_MATRIX: Matrix = {
  NEW_BOOKING: { CASH: true, BANK_TRANSFER: true, QRIS: true },
  ADD_UNIT: { CASH: true, BANK_TRANSFER: true, QRIS: true },
  EXTENSION: { CASH: true, BANK_TRANSFER: true, QRIS: true },
};

export function PaymentMethodsPage() {
  const { tenantId } = useSession();
  const { notify } = useToast();
  const [edits, setEdits] = useState<
    Partial<Record<PaymentContext, Partial<Record<PaymentMethod, boolean>>>>
  >({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const state = useApi(
    tenantId ? () => paymentSettingsApi.list(tenantId) : null,
    [tenantId],
  );

  // Matriks diturunkan dari respons server + perubahan lokal yang belum
  // disimpan. Tidak ada penyalinan state di effect, jadi reload data tetap benar.
  const matrix = useMemo<Matrix>(() => {
    const next: Matrix = {
      NEW_BOOKING: { ...DEFAULT_MATRIX.NEW_BOOKING },
      ADD_UNIT: { ...DEFAULT_MATRIX.ADD_UNIT },
      EXTENSION: { ...DEFAULT_MATRIX.EXTENSION },
    };
    for (const row of state.data?.settings ?? []) {
      if (!row.context || !row.method) continue;
      next[row.context][row.method] = row.enabled !== false;
    }
    for (const context of CONTEXTS) {
      for (const method of METHODS) {
        const edited = edits[context]?.[method];
        if (edited !== undefined) next[context][method] = edited;
      }
    }
    return next;
  }, [state.data, edits]);

  const invalidContexts = useMemo(
    () => CONTEXTS.filter((context) => METHODS.every((method) => !matrix[context][method])),
    [matrix],
  );

  const toggle = (context: PaymentContext, method: PaymentMethod) => {
    const next = !matrix[context][method];
    setEdits((current) => ({ ...current, [context]: { ...current[context], [method]: next } }));
    setError(null);
  };

  const save = async () => {
    if (!tenantId) return;
    if (invalidContexts.length > 0) {
      setError(
        `Setiap jenis transaksi wajib memiliki minimal satu metode aktif. Periksa: ${invalidContexts
          .map((context) => contextLabel(context).label)
          .join(", ")}.`,
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await paymentSettingsApi.update(tenantId, {
        settings: CONTEXTS.flatMap((context) =>
          METHODS.map((method) => ({ context, method, enabled: matrix[context][method] })),
        ),
      });
      notify("Matriks metode pembayaran disimpan.", "success");
      state.reload();
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="Metode pembayaran"
        subtitle="Atur cara pembayaran yang diterima toko kamu: Tunai (Cash), Transfer Bank, dan QRIS."
      />

      <InlineAlert tone="info">
        Perubahan ini otomatis berlaku untuk transaksi baru ya. Riwayat pembayaran pesanan lama tetap aman dan tidak berubah.
      </InlineAlert>

      {error ? (
        <InlineAlert tone="danger">
          <span role="alert">{error}</span>
        </InlineAlert>
      ) : null}

      <Panel flush>
        <PanelHead
          title="Matriks konteks × metode"
          description="Baris yang belum pernah disimpan ditampilkan aktif (default backend)."
        />
        {state.initialLoading ? (
          <div className="panel-body">
            <LoadingBlock rows={3} />
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Jenis transaksi</th>
                  {METHODS.map((method) => (
                    <th key={method} scope="col">
                      {methodLabel(method).label}
                    </th>
                  ))}
                  <th scope="col">Status konteks</th>
                </tr>
              </thead>
              <tbody>
                {CONTEXTS.map((context) => {
                  const invalid = invalidContexts.includes(context);
                  return (
                    <tr key={context}>
                      <th scope="row" style={{ textTransform: "none", letterSpacing: 0 }}>
                        {contextLabel(context).label}
                      </th>
                      {METHODS.map((method) => (
                        <td key={method}>
                          <label className="switch">
                            <input
                              type="checkbox"
                              checked={matrix[context][method]}
                              onChange={() => toggle(context, method)}
                              aria-label={`${methodLabel(method).label} untuk ${contextLabel(context).label}`}
                            />
                            <span className="text-sm">{matrix[context][method] ? "Aktif" : "Nonaktif"}</span>
                          </label>
                        </td>
                      ))}
                      <td>
                        {invalid ? (
                          <span className="badge badge-danger">Tidak ada metode aktif</span>
                        ) : (
                          <span className="badge badge-success">Valid</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div className="form-actions">
        <Button variant="primary" loading={busy} onClick={() => void save()}>
          Simpan matriks
        </Button>
      </div>

      <p className="text-xs text-muted">
        Status pembayaran tetap terpisah. Memilih Cash tidak membuat lunas; transfer/QRIS dicatat setelah
        petugas memverifikasi. Membuka WhatsApp tidak pernah mengubah status pembayaran.
      </p>
    </div>
  );
}
