"use client";

import { useState } from "react";
import {
  whatsappTemplateApi,
  type PaymentContext,
  type PaymentMethod,
  type Schema,
} from "@/shared/api/endpoints";
import { describeApiError } from "@/shared/api/errors";
import { useSession } from "@/shared/auth/session";
import { contextLabel, methodLabel, purposeLabel } from "@/shared/format/status";
import { useApi } from "@/shared/hooks/useApi";
import { Button } from "@/shared/ui/buttons";
import { CheckboxField, SelectInput, TextArea, TextInput } from "@/shared/ui/form";
import { ConfirmDialog, Dialog, useToast } from "@/shared/ui/overlays";
import { Badge, PageHeader, Panel, PanelHead } from "@/shared/ui/surfaces";
import { EmptyState, InlineAlert, QueryState } from "@/shared/ui/states";

type Template = Schema<"WhatsAppTemplateResponse">;
type Purpose = "PAYMENT_INSTRUCTION" | "PAYMENT_CONFIRMATION";

const CONTEXTS: PaymentContext[] = ["NEW_BOOKING", "ADD_UNIT", "EXTENSION"];
const METHODS: PaymentMethod[] = ["CASH", "BANK_TRANSFER", "QRIS"];
const PURPOSES: Purpose[] = ["PAYMENT_INSTRUCTION", "PAYMENT_CONFIRMATION"];
const PLACEHOLDERS = [
  "nama_bisnis",
  "nama_penyewa",
  "nomor_pesanan",
  "daftar_barang",
  "periode",
  "nominal_tagihan",
  "jenis_transaksi",
  "waktu_pembayaran",
];

export function WhatsAppTemplatesPage() {
  const { tenantId } = useSession();
  const { notify } = useToast();
  const [context, setContext] = useState<PaymentContext | "">("");
  const [method, setMethod] = useState<PaymentMethod | "">("");
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Template | null>(null);
  const [restoring, setRestoring] = useState<Template | null>(null);

  const state = useApi<Template[]>(
    tenantId
      ? () =>
          whatsappTemplateApi.list(tenantId, {
            ...(context ? { context } : {}),
            ...(method ? { paymentMethod: method } : {}),
          })
      : null,
    [tenantId, context, method],
  );

  return (
    <div className="page">
      <PageHeader
        title="Template WhatsApp"
        subtitle="Atur pesan WhatsApp otomatis untuk kirim rincian sewa dan konfirmasi pembayaran ke pelanggan."
        actions={
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            Buat template baru
          </Button>
        }
      />

      <div className="toolbar">
        <SelectInput
          label="Jenis transaksi"
          value={context}
          onChange={(event) => setContext(event.target.value as PaymentContext | "")}
        >
          <option value="">Semua</option>
          {CONTEXTS.map((item) => (
            <option key={item} value={item}>
              {contextLabel(item).label}
            </option>
          ))}
        </SelectInput>
        <SelectInput
          label="Metode"
          value={method}
          onChange={(event) => setMethod(event.target.value as PaymentMethod | "")}
        >
          <option value="">Semua</option>
          {METHODS.map((item) => (
            <option key={item} value={item}>
              {methodLabel(item).label}
            </option>
          ))}
        </SelectInput>
        <Button onClick={() => state.reload()} loading={state.loading}>
          Muat ulang
        </Button>
      </div>

      <Panel flush>
        <PanelHead
          title="Daftar template"
          description="Template bawaan boleh diedit; versi baru dibuat setiap perubahan body."
        />
        <QueryState
          state={state}
          loadingRows={5}
          isEmpty={(items) => items.length === 0}
          empty={<EmptyState title="Belum ada template" description="Buat template pertama untuk konteks dan metode yang dibutuhkan." />}
        >
          {(items) => (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Nama</th>
                    <th scope="col">Kombinasi</th>
                    <th scope="col" className="num">
                      Versi
                    </th>
                    <th scope="col">Status</th>
                    <th scope="col" className="text-right">
                      Aksi
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((template) => (
                    <tr key={template.id}>
                      <td>
                        {template.name}
                        <div className="text-xs text-muted truncate">{template.body}</div>
                      </td>
                      <td className="text-sm">
                        {contextLabel(template.context).label} · {methodLabel(template.paymentMethod).label}
                        <div className="text-xs text-muted">
                          {purposeLabel(template.purpose).label}
                          {template.isSystemDefault ? " · bawaan" : ""}
                        </div>
                      </td>
                      <td className="num">{template.currentVersion ?? 1}</td>
                      <td>
                        <Badge tone={template.isActive === false ? "neutral" : "success"}>
                          {template.isActive === false ? "Nonaktif" : "Aktif"}
                        </Badge>
                      </td>
                      <td>
                        <div className="table-actions">
                          <Button size="sm" onClick={() => setEditing(template)}>
                            Ubah
                          </Button>
                          {template.isSystemDefault ? (
                            <Button size="sm" variant="ghost" onClick={() => setRestoring(template)}>
                              Pulihkan bawaan
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
        </QueryState>
      </Panel>

      <InlineAlert tone="info">
        Placeholder resmi: {PLACEHOLDERS.map((item) => `{{${item}}}`).join(", ")}. Placeholder lain
        ditolak server (400). Variabel opsional yang tidak tersedia dihilangkan dengan aman, tidak
        menghasilkan “undefined”.
      </InlineAlert>

      <CreateTemplateDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        tenantId={tenantId}
        onSaved={() => {
          notify("Template dibuat (versi 1).", "success");
          setCreateOpen(false);
          state.reload();
        }}
        onError={(message) => notify(message, "error")}
      />

      <EditTemplateDialog
        key={editing?.id ?? "none"}
        template={editing}
        tenantId={tenantId}
        onClose={() => setEditing(null)}
        onSaved={() => {
          notify("Template diperbarui; versi baru dicatat.", "success");
          setEditing(null);
          state.reload();
        }}
        onError={(message) => notify(message, "error")}
      />

      <ConfirmDialog
        open={Boolean(restoring)}
        onClose={() => setRestoring(null)}
        onConfirm={async () => {
          if (!tenantId || !restoring?.id) return;
          try {
            await whatsappTemplateApi.restoreDefault(tenantId, restoring.id);
            notify("Template dipulihkan ke bawaan sebagai versi baru.", "success");
            setRestoring(null);
            state.reload();
          } catch (caught) {
            notify(describeApiError(caught), "error");
          }
        }}
        title="Pulihkan template bawaan?"
        consequence="Isi template dikembalikan ke versi bawaan platform sebagai versi baru. Snapshot pesan pada transaksi lama tidak berubah."
        confirmLabel="Pulihkan bawaan"
      />
    </div>
  );
}

function PreviewBlock({ tenantId, body }: { tenantId: string | null; body: string }) {
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (!tenantId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await whatsappTemplateApi.preview(tenantId, {
        body,
        values: {
          nama_bisnis: "Contoh Rental",
          nama_penyewa: "Budi",
          nomor_pesanan: "ORD-2026-0001",
          daftar_barang: "Tenda 4 orang × 1",
          periode: "20 Okt 2026 09.00 – 21 Okt 2026 09.00",
          nominal_tagihan: "Rp 150.000",
          jenis_transaksi: "Booking baru",
          waktu_pembayaran: "20 Okt 2026 08.30",
        },
      });
      setPreview(result.body ?? null);
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack-sm">
      <div className="row-between">
        <span className="label">Pratinjau dengan data contoh</span>
        <Button size="sm" loading={busy} onClick={() => void run()}>
          Muat pratinjau
        </Button>
      </div>
      {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
      {preview ? (
        <pre
          className="text-sm"
          style={{
            whiteSpace: "pre-wrap",
            margin: 0,
            padding: "var(--sw-space-3)",
            background: "var(--sw-panel-muted)",
            borderRadius: "var(--sw-radius-sm)",
            border: "1px solid var(--sw-border)",
            fontFamily: "var(--sw-font-sans)",
          }}
        >
          {preview}
        </pre>
      ) : (
        <p className="text-xs text-muted">Pratinjau tidak mengirim pesan dan tidak mengubah data.</p>
      )}
    </div>
  );
}

function CreateTemplateDialog({
  open,
  onClose,
  tenantId,
  onSaved,
  onError,
}: {
  open: boolean;
  onClose: () => void;
  tenantId: string | null;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [context, setContext] = useState<PaymentContext>("NEW_BOOKING");
  const [method, setMethod] = useState<PaymentMethod>("BANK_TRANSFER");
  const [purpose, setPurpose] = useState<Purpose>("PAYMENT_INSTRUCTION");
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!tenantId) return;
    setBusy(true);
    try {
      await whatsappTemplateApi.create(tenantId, {
        context,
        paymentMethod: method,
        purpose,
        name: name.trim(),
        body,
        isActive,
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
      title="Buat template WhatsApp"
      description="Kombinasi konteks+metode+tujuan harus unik dalam tenant."
      wide
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Batal
          </Button>
          <Button type="submit" form="create-template" variant="primary" loading={busy}>
            Simpan template
          </Button>
        </>
      }
    >
      <form id="create-template" className="stack" onSubmit={submit}>
        <div className="form-grid">
          <SelectInput
            label="Jenis transaksi"
            value={context}
            onChange={(event) => setContext(event.target.value as PaymentContext)}
          >
            {CONTEXTS.map((item) => (
              <option key={item} value={item}>
                {contextLabel(item).label}
              </option>
            ))}
          </SelectInput>
          <SelectInput
            label="Metode"
            value={method}
            onChange={(event) => setMethod(event.target.value as PaymentMethod)}
          >
            {METHODS.map((item) => (
              <option key={item} value={item}>
                {methodLabel(item).label}
              </option>
            ))}
          </SelectInput>
          <SelectInput
            label="Tujuan pesan"
            value={purpose}
            onChange={(event) => setPurpose(event.target.value as Purpose)}
          >
            {PURPOSES.map((item) => (
              <option key={item} value={item}>
                {purposeLabel(item).label}
              </option>
            ))}
          </SelectInput>
        </div>
        <TextInput
          label="Nama template"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <TextArea
          label="Isi pesan"
          required
          rows={10}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          hint={`Placeholder resmi: ${PLACEHOLDERS.map((item) => `{{${item}}}`).join(", ")}`}
        />
        <CheckboxField label="Aktifkan template" checked={isActive} onChange={setIsActive} />
        <PreviewBlock tenantId={tenantId} body={body} />
      </form>
    </Dialog>
  );
}

function EditTemplateDialog({
  template,
  tenantId,
  onClose,
  onSaved,
  onError,
}: {
  template: Template | null;
  tenantId: string | null;
  onClose: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState(template?.name ?? "");
  const [body, setBody] = useState(template?.body ?? "");
  const [isActive, setIsActive] = useState(template?.isActive !== false);
  const [busy, setBusy] = useState(false);
  const detail = useApi<Template | null>(
    template?.id && tenantId && template.isSystemDefault
      ? () => whatsappTemplateApi.get(tenantId, template.id ?? "")
      : null,
    [template?.id, tenantId],
  );

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!tenantId || !template?.id) return;
    setBusy(true);
    try {
      await whatsappTemplateApi.update(tenantId, template.id, {
        name: name.trim(),
        body,
        isActive,
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
      open={Boolean(template)}
      onClose={onClose}
      title={`Ubah template${template?.name ? `: ${template.name}` : ""}`}
      description="Setiap perubahan body membuat versi baru; histori transaksi tetap merujuk snapshot lama."
      wide
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Batal
          </Button>
          <Button type="submit" form="edit-template" variant="primary" loading={busy}>
            Simpan perubahan
          </Button>
        </>
      }
    >
      <form id="edit-template" className="stack" onSubmit={submit}>
        <TextInput label="Nama template" required value={name} onChange={(event) => setName(event.target.value)} />
        <TextArea
          label="Isi pesan"
          required
          rows={12}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          hint={`Placeholder resmi: ${PLACEHOLDERS.map((item) => `{{${item}}}`).join(", ")}`}
        />
        <CheckboxField
          label="Aktif — tampil pada alur transaksi terkait"
          checked={isActive}
          onChange={setIsActive}
        />
        <PreviewBlock tenantId={tenantId} body={body} />
        {detail.data?.versions && detail.data.versions.length > 0 ? (
          <details>
            <summary className="text-sm">Riwayat versi ({detail.data.versions.length})</summary>
            <ul className="text-sm" style={{ marginTop: "var(--sw-space-2)" }}>
              {detail.data.versions.map((version) => (
                <li key={version.id}>
                  v{version.version} · {version.createdAt ? new Date(version.createdAt).toLocaleString("id-ID") : "—"}
                  {version.changeReason ? ` · ${version.changeReason}` : ""}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        <Badge tone="neutral">Tidak ada pengiriman otomatis</Badge>
      </form>
    </Dialog>
  );
}
