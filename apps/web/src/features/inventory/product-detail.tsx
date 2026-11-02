"use client";

import Link from "next/link";
import { useState } from "react";
import { catalogApi, type Schema } from "@/shared/api/endpoints";
import { describeApiError } from "@/shared/api/errors";
import { can, type Role } from "@/shared/auth/permissions";
import { useSession } from "@/shared/auth/session";
import { formatIDR } from "@/shared/format/currency";
import { formatDateRange } from "@/shared/format/date";
import { assetStatus } from "@/shared/format/status";
import { useApi } from "@/shared/hooks/useApi";
import { Button, LinkButton } from "@/shared/ui/buttons";
import { SelectInput, TextArea, TextInput } from "@/shared/ui/form";
import { ConfirmDialog, Dialog, useToast } from "@/shared/ui/overlays";
import {
  Badge,
  DefinitionList,
  PageHeader,
  Panel,
  PanelBody,
  PanelHead,
  StatusBadge,
} from "@/shared/ui/surfaces";
import { EmptyState, InlineAlert, QueryState } from "@/shared/ui/states";

type Product = Schema<"ProductResponse"> & { assetCount?: number };
type Asset = Schema<"AssetResponse">;

export function ProductDetail({ productId }: { productId: string }) {
  const { tenantId, role, tenant } = useSession();
  const { notify } = useToast();
  const canWrite = can(role as Role | undefined, "catalog.write");
  const timezone = tenant?.timezone ?? "Asia/Jakarta";
  const [editOpen, setEditOpen] = useState(false);
  const [assetOpen, setAssetOpen] = useState(false);
  const [deactivateOpen, setDeactivateOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const productState = useApi<Product>(
    tenantId ? () => catalogApi.getProduct(tenantId, productId) : null,
    [tenantId, productId],
  );
  const rateState = useApi<Schema<"RateResponse"> | null>(
    tenantId ? () => catalogApi.getRate(tenantId, productId) : null,
    [tenantId, productId],
  );
  const assetsState = useApi<Asset[]>(
    tenantId && productState.data?.stockMode === "INDIVIDUAL_UNITS"
      ? () => catalogApi.listAssets(tenantId, productId)
      : null,
    [tenantId, productId, productState.data?.stockMode],
  );

  const product = productState.data;

  const deactivate = async () => {
    if (!tenantId) return;
    setBusy(true);
    try {
      await catalogApi.deactivateProduct(tenantId, productId);
      notify("Produk dinonaktifkan. Riwayat dan pesanan lama tetap tersimpan.", "success");
      setDeactivateOpen(false);
      productState.reload();
    } catch (error) {
      notify(describeApiError(error), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <PageHeader
        breadcrumb={
          <>
            <Link href="/app/inventory">Inventaris</Link>
            <span aria-hidden="true">/</span>
            <span>{product?.name ?? "Produk"}</span>
          </>
        }
        title={product?.name ?? "Detail produk"}
        subtitle={product?.description ?? undefined}
        actions={
          canWrite ? (
            <>
              <Button onClick={() => setEditOpen(true)}>Ubah produk</Button>
              {product?.isActive === false ? null : (
                <Button variant="danger" onClick={() => setDeactivateOpen(true)}>
                  Nonaktifkan
                </Button>
              )}
            </>
          ) : (
            <Badge tone="neutral">Hanya baca</Badge>
          )
        }
      />

      <QueryState state={productState} loadingRows={4}>
        {(data) => (
          <>
            {data.isActive === false ? (
              <InlineAlert tone="warning">
                Produk nonaktif: tidak ditawarkan pada katalog/POS baru, tetapi riwayat pesanan tetap
                tersedia.
              </InlineAlert>
            ) : null}

            <div className="grid-2">
              <Panel>
                <PanelHead title="Informasi produk" />
                <PanelBody>
                  <DefinitionList
                    items={[
                      { term: "Tipe stok", value: data.stockMode === "INDIVIDUAL_UNITS" ? "Unit individual" : "Stok kuantitas" },
                      { term: "Kapasitas", value: data.capacity ?? "—" },
                      { term: "Status", value: <Badge tone={data.isActive === false ? "neutral" : "success"}>{data.isActive === false ? "Nonaktif" : "Aktif"}</Badge> },
                      { term: "Jumlah unit fisik", value: data.assetCount ?? assetsState.data?.length ?? "—" },
                      { term: "Dibuat", value: formatDateRange(data.createdAt, data.createdAt, timezone) },
                    ]}
                  />
                </PanelBody>
              </Panel>

              <Panel>
                <PanelHead
                  title="Tarif sewa"
                  description="Harga dihitung server dari tarif ini; input pengguna tidak dipercaya."
                />
                <PanelBody>
                  {rateState.initialLoading ? null : rateState.error ? (
                    <InlineAlert tone="danger">{describeApiError(rateState.error)}</InlineAlert>
                  ) : (
                    <RateForm
                      tenantId={tenantId}
                      productId={productId}
                      current={rateState.data}
                      canWrite={canWrite}
                      timezone={timezone}
                      onSaved={() => {
                        notify("Tarif disimpan.", "success");
                        rateState.reload();
                        productState.reload();
                      }}
                      onError={(message) => notify(message, "error")}
                    />
                  )}
                </PanelBody>
              </Panel>
            </div>

            {data.stockMode === "INDIVIDUAL_UNITS" ? (
              <Panel flush>
                <PanelHead
                  title="Unit fisik"
                  description="Satu unit hanya boleh dialokasikan pada satu booking aktif per periode."
                  actions={
                    canWrite ? (
                      <Button size="sm" variant="primary" onClick={() => setAssetOpen(true)}>
                        Tambah unit
                      </Button>
                    ) : null
                  }
                />
                <QueryState
                  state={assetsState}
                  loadingRows={3}
                  isEmpty={(assets) => assets.length === 0}
                  empty={
                    <EmptyState
                      title="Belum ada unit fisik"
                      description="Tambahkan unit dengan kode unik agar dapat dialokasikan per unit."
                    />
                  }
                >
                  {(assets) => (
                    <div className="table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th scope="col">Kode unit</th>
                            <th scope="col">Status</th>
                            <th scope="col">Catatan kondisi</th>
                            <th scope="col" className="text-right">
                              Aksi
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {assets.map((asset) => (
                            <AssetRow
                              key={asset.id}
                              asset={asset}
                              tenantId={tenantId}
                              canWrite={canWrite}
                              onSaved={(message) => {
                                notify(message, "success");
                                assetsState.reload();
                              }}
                              onError={(message) => notify(message, "error")}
                            />
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </QueryState>
              </Panel>
            ) : null}

            <InlineAlert tone="info">
              Foto produk dan lampiran inspeksi memerlukan endpoint upload objek storage yang belum
              tersedia di kontrak OpenAPI saat ini; UI tidak menampilkan unggahan palsu.
            </InlineAlert>

            <EditProductDialog
              open={editOpen}
              onClose={() => setEditOpen(false)}
              tenantId={tenantId}
              product={data}
              onSaved={() => {
                notify("Produk diperbarui.", "success");
                setEditOpen(false);
                productState.reload();
              }}
              onError={(message) => notify(message, "error")}
            />

            <CreateAssetDialog
              open={assetOpen}
              onClose={() => setAssetOpen(false)}
              tenantId={tenantId}
              productId={productId}
              onSaved={() => {
                notify("Unit fisik ditambahkan.", "success");
                setAssetOpen(false);
                assetsState.reload();
                productState.reload();
              }}
              onError={(message) => notify(message, "error")}
            />

            <ConfirmDialog
              open={deactivateOpen}
              onClose={() => setDeactivateOpen(false)}
              onConfirm={() => void deactivate()}
              title="Nonaktifkan produk?"
              consequence="Produk tidak akan ditawarkan untuk booking/POS baru dan katalog publik. Pesanan dan riwayat yang sudah ada tidak dihapus."
              confirmLabel="Nonaktifkan produk"
              destructive
              busy={busy}
            />
          </>
        )}
      </QueryState>
    </div>
  );
}

function RateForm({
  tenantId,
  productId,
  current,
  canWrite,
  timezone,
  onSaved,
  onError,
}: {
  tenantId: string | null;
  productId: string;
  current: Schema<"RateResponse"> | null;
  canWrite: boolean;
  timezone: string;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [perDay, setPerDay] = useState(current?.perDayAmount ?? "");
  const [perWeek, setPerWeek] = useState(current?.perWeekAmount ?? "");
  const [perMonth, setPerMonth] = useState(current?.perMonthAmount ?? "");
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!tenantId) return;
    const day = Number.parseInt(perDay || "0", 10);
    if (!Number.isInteger(day) || day <= 0) {
      onError("Tarif per hari wajib bilangan bulat rupiah lebih dari 0.");
      return;
    }
    setBusy(true);
    try {
      await catalogApi.upsertRate(tenantId, productId, {
        perDayAmount: day,
        perWeekAmount: perWeek ? Number.parseInt(perWeek, 10) : null,
        perMonthAmount: perMonth ? Number.parseInt(perMonth, 10) : null,
      });
      onSaved();
    } catch (error) {
      onError(describeApiError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={submit} noValidate>
      <TextInput
        label="Tarif per hari (Rp)"
        inputMode="numeric"
        required
        value={perDay}
        disabled={!canWrite}
        onChange={(event) => setPerDay(event.target.value.replace(/\D/g, ""))}
        hint={current?.perDayAmount ? `Tersimpan: ${formatIDR(current.perDayAmount)}` : "Belum ada tarif."}
      />
      <TextInput
        label="Tarif per minggu (Rp, opsional)"
        inputMode="numeric"
        value={perWeek ?? ""}
        disabled={!canWrite}
        onChange={(event) => setPerWeek(event.target.value.replace(/\D/g, ""))}
      />
      <TextInput
        label="Tarif per bulan (Rp, opsional)"
        inputMode="numeric"
        value={perMonth ?? ""}
        disabled={!canWrite}
        onChange={(event) => setPerMonth(event.target.value.replace(/\D/g, ""))}
      />
      <p className="text-xs text-muted">
        Diperbarui: {current?.updatedAt ? formatDateRange(current.updatedAt, current.updatedAt, timezone) : "—"}
      </p>
      {canWrite ? (
        <div className="form-actions">
          <Button type="submit" variant="primary" loading={busy}>
            Simpan tarif
          </Button>
        </div>
      ) : null}
    </form>
  );
}

function AssetRow({
  asset,
  tenantId,
  canWrite,
  onSaved,
  onError,
}: {
  asset: Asset;
  tenantId: string | null;
  canWrite: boolean;
  onSaved: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);

  return (
    <>
      <tr>
        <td className="mono">{asset.code ?? "—"}</td>
        <td>
          <StatusBadge status={assetStatus(asset.status)} />
        </td>
        <td>{asset.conditionNote ?? "—"}</td>
        <td>
          <div className="table-actions">
            {canWrite ? (
              <>
                <Button size="sm" onClick={() => setEditOpen(true)}>
                  Ubah
                </Button>
                <Button size="sm" onClick={() => setMaintenanceOpen(true)}>
                  Maintenance
                </Button>
              </>
            ) : null}
          </div>
        </td>
      </tr>
      <AssetEditDialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        tenantId={tenantId}
        asset={asset}
        onSaved={onSaved}
        onError={onError}
      />
      <MaintenanceDialog
        open={maintenanceOpen}
        onClose={() => setMaintenanceOpen(false)}
        tenantId={tenantId}
        asset={asset}
        onSaved={onSaved}
        onError={onError}
      />
    </>
  );
}

function AssetEditDialog({
  open,
  onClose,
  tenantId,
  asset,
  onSaved,
  onError,
}: {
  open: boolean;
  onClose: () => void;
  tenantId: string | null;
  asset: Asset;
  onSaved: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [status, setStatus] = useState(asset.status ?? "AVAILABLE");
  const [note, setNote] = useState(asset.conditionNote ?? "");
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!tenantId || !asset.id) return;
    setBusy(true);
    try {
      await catalogApi.updateAsset(tenantId, asset.id, {
        status: status as NonNullable<Asset["status"]>,
        conditionNote: note.trim() || null,
      });
      onSaved("Status unit diperbarui.");
      onClose();
    } catch (error) {
      onError(describeApiError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Ubah unit ${asset.code ?? ""}`}
      description="Status unit memengaruhi ketersediaan. Unit RESERVED dikelola oleh alokasi booking."
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Batal
          </Button>
          <Button variant="primary" form={`asset-${asset.id}`} type="submit" loading={busy}>
            Simpan
          </Button>
        </>
      }
    >
      <form id={`asset-${asset.id}`} className="stack" onSubmit={submit}>
        <SelectInput label="Status" value={status} onChange={(event) => setStatus(event.target.value as NonNullable<Asset["status"]>)}>
          <option value="AVAILABLE">Tersedia</option>
          <option value="MAINTENANCE">Maintenance</option>
          <option value="DAMAGED">Rusak</option>
          <option value="RETIRED">Pensiun</option>
          <option value="RESERVED">Dipesan</option>
        </SelectInput>
        <TextArea
          label="Catatan kondisi"
          rows={2}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          hint="Catatan ini membantu inspeksi serah-terima dan pengembalian."
        />
      </form>
    </Dialog>
  );
}

function MaintenanceDialog({
  open,
  onClose,
  tenantId,
  asset,
  onSaved,
  onError,
}: {
  open: boolean;
  onClose: () => void;
  tenantId: string | null;
  asset: Asset;
  onSaved: (message: string) => void;
  onError: (message: string) => void;
}) {
  const timezone = useSession().tenant?.timezone ?? "Asia/Jakarta";
  const history = useApi<Schema<"MaintenanceResponse">[]>(
    open && tenantId && asset.id ? () => catalogApi.listMaintenance(tenantId, asset.id!) : null,
    [open, tenantId, asset.id],
  );
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!tenantId || !asset.id) return;
    if (!startAt || !endAt) {
      onError("Tanggal mulai dan selesai maintenance wajib diisi.");
      return;
    }
    if (new Date(endAt) <= new Date(startAt)) {
      onError("Waktu selesai harus setelah waktu mulai.");
      return;
    }
    setBusy(true);
    try {
      await catalogApi.createMaintenance(tenantId, asset.id, {
        startAt: new Date(startAt).toISOString(),
        endAt: new Date(endAt).toISOString(),
        reason: reason.trim() || undefined,
      });
      onSaved("Periode maintenance dicatat.");
      setStartAt("");
      setEndAt("");
      setReason("");
      history.reload();
    } catch (error) {
      onError(describeApiError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={`Maintenance ${asset.code ?? ""}`} wide>
      <div className="stack">
        <form className="stack" onSubmit={submit}>
          <div className="form-grid">
            <TextInput
              label="Mulai"
              type="datetime-local"
              required
              value={startAt}
              onChange={(event) => setStartAt(event.target.value)}
            />
            <TextInput
              label="Selesai"
              type="datetime-local"
              required
              value={endAt}
              onChange={(event) => setEndAt(event.target.value)}
            />
          </div>
          <TextInput label="Alasan" value={reason} onChange={(event) => setReason(event.target.value)} />
          <div className="form-actions">
            <Button type="submit" variant="primary" size="sm" loading={busy}>
              Catat maintenance
            </Button>
          </div>
        </form>
        <div>
          <h3 className="panel-title" style={{ marginBottom: "var(--sw-space-2)" }}>
            Riwayat maintenance
          </h3>
          <QueryState state={history} loadingRows={2} isEmpty={(items) => items.length === 0} empty={<EmptyState title="Belum ada maintenance" />}>
            {(items) => (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Periode</th>
                      <th scope="col">Alasan</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.id}>
                        <td>{formatDateRange(item.startAt, item.endAt, timezone)}</td>
                        <td>{item.reason ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </QueryState>
        </div>
      </div>
    </Dialog>
  );
}

function CreateAssetDialog({
  open,
  onClose,
  tenantId,
  productId,
  onSaved,
  onError,
}: {
  open: boolean;
  onClose: () => void;
  tenantId: string | null;
  productId: string;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [code, setCode] = useState("");
  const [status, setStatus] = useState("AVAILABLE");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!tenantId) return;
    if (!code.trim()) {
      onError("Kode unit wajib diisi dan unik per tenant.");
      return;
    }
    setBusy(true);
    try {
      await catalogApi.createAsset(tenantId, productId, {
        code: code.trim(),
        status: status as "AVAILABLE" | "RESERVED" | "MAINTENANCE" | "DAMAGED" | "RETIRED",
        conditionNote: note.trim() || undefined,
      });
      setCode("");
      setNote("");
      onSaved();
    } catch (error) {
      onError(describeApiError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Tambah unit fisik"
      description="Kode unit harus unik dalam tenant, misalnya nomor seri atau label rak."
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Batal
          </Button>
          <Button type="submit" form="create-asset" variant="primary" loading={busy}>
            Tambah unit
          </Button>
        </>
      }
    >
      <form id="create-asset" className="stack" onSubmit={submit}>
        <TextInput label="Kode unit" required value={code} onChange={(event) => setCode(event.target.value)} />
        <SelectInput label="Status awal" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="AVAILABLE">Tersedia</option>
          <option value="MAINTENANCE">Maintenance</option>
          <option value="DAMAGED">Rusak</option>
          <option value="RETIRED">Pensiun</option>
        </SelectInput>
        <TextArea
          label="Catatan kondisi awal"
          rows={2}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          hint="Dipakai sebagai pembanding saat inspeksi pengembalian."
        />
      </form>
    </Dialog>
  );
}

function EditProductDialog({
  open,
  onClose,
  tenantId,
  product,
  onSaved,
  onError,
}: {
  open: boolean;
  onClose: () => void;
  tenantId: string | null;
  product: Product;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState(product.name ?? "");
  const [description, setDescription] = useState(product.description ?? "");
  const [capacity, setCapacity] = useState(String(product.capacity ?? 0));
  const [isActive, setIsActive] = useState(product.isActive !== false);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!tenantId || !product.id) return;
    setBusy(true);
    try {
      await catalogApi.updateProduct(tenantId, product.id, {
        name: name.trim(),
        description: description.trim() || undefined,
        capacity: Number.parseInt(capacity || "0", 10),
        isActive,
      });
      onSaved();
    } catch (error) {
      onError(describeApiError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Ubah produk"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Batal
          </Button>
          <Button type="submit" form="edit-product" variant="primary" loading={busy}>
            Simpan
          </Button>
        </>
      }
    >
      <form id="edit-product" className="stack" onSubmit={submit}>
        <TextInput label="Nama produk" required value={name} onChange={(event) => setName(event.target.value)} />
        <TextArea label="Deskripsi" rows={2} value={description} onChange={(event) => setDescription(event.target.value)} />
        <TextInput
          label="Kapasitas"
          inputMode="numeric"
          value={capacity}
          onChange={(event) => setCapacity(event.target.value.replace(/\D/g, ""))}
          hint="Untuk unit individual, kapasitas mengikuti jumlah unit yang ada."
        />
        <SelectInput
          label="Status penawaran"
          value={isActive ? "ACTIVE" : "INACTIVE"}
          onChange={(event) => setIsActive(event.target.value === "ACTIVE")}
        >
          <option value="ACTIVE">Aktif — tampil di katalog/POS</option>
          <option value="INACTIVE">Nonaktif</option>
        </SelectInput>
        <p className="text-xs text-muted">
          Tipe stok tidak dapat diubah setelah produk dibuat: riwayat alokasi bergantung padanya.
        </p>
      </form>
    </Dialog>
  );
}
