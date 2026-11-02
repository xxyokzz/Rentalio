"use client";

import Link from "next/link";
import { useId, useMemo, useState } from "react";
import { catalogApi, type Schema } from "@/shared/api/endpoints";
import { describeApiError } from "@/shared/api/errors";
import { can, type Role } from "@/shared/auth/permissions";
import { useSession } from "@/shared/auth/session";
import { formatIDR } from "@/shared/format/currency";
import { useApi } from "@/shared/hooks/useApi";
import { Button, LinkButton } from "@/shared/ui/buttons";
import { Dialog, useToast } from "@/shared/ui/overlays";
import { SelectInput, TextArea, TextInput } from "@/shared/ui/form";
import { Badge, PageHeader, Panel, PanelHead } from "@/shared/ui/surfaces";
import { EmptyState, InlineAlert, QueryState } from "@/shared/ui/states";

type Product = Schema<"ProductResponse">;

export function ProductsPage() {
  const { tenantId, role } = useSession();
  const { notify } = useToast();
  const canWrite = can(role as Role | undefined, "catalog.write");
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [activeFilter, setActiveFilter] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

  const productsState = useApi<Product[]>(
    tenantId ? () => catalogApi.listProducts(tenantId) : null,
    [tenantId],
  );
  const categoriesState = useApi(
    tenantId ? () => catalogApi.listCategories(tenantId) : null,
    [tenantId],
  );

  const categories = useMemo(() => categoriesState.data ?? [], [categoriesState.data]);
  const categoryName = useMemo(() => {
    const map = new Map<string, string>();
    for (const category of categories) {
      if (category.id) map.set(category.id, category.name ?? category.id);
    }
    return map;
  }, [categories]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (productsState.data ?? []).filter((product) => {
      if (term && !(product.name ?? "").toLowerCase().includes(term)) return false;
      if (categoryId && product.categoryId !== categoryId) return false;
      if (activeFilter === "ACTIVE" && product.isActive === false) return false;
      if (activeFilter === "INACTIVE" && product.isActive !== false) return false;
      return true;
    });
  }, [productsState.data, search, categoryId, activeFilter]);

  return (
    <div className="page">
      <PageHeader
        title="Inventaris"
        subtitle="Kelola produk, harga sewa, dan unit barang tokomu dengan rapi."
        actions={
          canWrite ? (
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              Tambah produk
            </Button>
          ) : (
            <Badge tone="neutral">Hanya baca</Badge>
          )
        }
      />

      {!canWrite ? (
        <InlineAlert tone="info">
          Akun kamu cuma punya akses lihat barang, tidak bisa menambah atau mengubah produk ya.
        </InlineAlert>
      ) : null}

      <div className="toolbar">
        <TextInput
          label="Cari produk"
          placeholder="Nama produk"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          wrapperClassName="field-grow"
        />
        <SelectInput label="Kategori" value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
          <option value="">Semua kategori</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </SelectInput>
        <SelectInput
          label="Status"
          value={activeFilter}
          onChange={(event) => setActiveFilter(event.target.value)}
        >
          <option value="">Semua</option>
          <option value="ACTIVE">Aktif</option>
          <option value="INACTIVE">Nonaktif</option>
        </SelectInput>
      </div>

      <Panel flush>
        <PanelHead
          title={`Daftar produk (${filtered.length})`}
          description="Filter di atas berjalan pada data yang dimuat dari server."
        />
        <QueryState
          state={productsState}
          loadingRows={5}
          isEmpty={(data) => data.length === 0}
          empty={
            <EmptyState
              title="Belum ada produk"
              description="Produk adalah dasar booking, POS, dan katalog publik. Tambahkan produk pertama Anda."
              action={
                canWrite ? (
                  <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
                    Tambah produk
                  </Button>
                ) : null
              }
            />
          }
        >
          {() => (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Produk</th>
                    <th scope="col">Kategori</th>
                    <th scope="col">Tipe stok</th>
                    <th scope="col" className="num">
                      Kapasitas
                    </th>
                    <th scope="col" className="num">
                      Tarif / hari
                    </th>
                    <th scope="col">Status</th>
                    <th scope="col" className="text-right">
                      Aksi
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 ? (
                    <tr className="table-empty">
                      <td colSpan={7}>Tidak ada produk yang cocok dengan filter.</td>
                    </tr>
                  ) : (
                    filtered.map((product) => (
                      <tr key={product.id}>
                        <td>
                          <Link href={`/app/inventory/${product.id}`}>{product.name}</Link>
                          {product.description ? (
                            <div className="text-xs text-muted truncate">{product.description}</div>
                          ) : null}
                        </td>
                        <td>{product.categoryId ? categoryName.get(product.categoryId) ?? "—" : "—"}</td>
                        <td>
                          {product.stockMode === "INDIVIDUAL_UNITS" ? "Unit individual" : "Stok kuantitas"}
                        </td>
                        <td className="num">{product.capacity ?? "—"}</td>
                        <td className="num money">
                          {product.rate?.perDayAmount ? formatIDR(product.rate.perDayAmount) : "Belum diatur"}
                        </td>
                        <td>
                          <Badge tone={product.isActive === false ? "neutral" : "success"}>
                            {product.isActive === false ? "Nonaktif" : "Aktif"}
                          </Badge>
                        </td>
                        <td>
                          <div className="table-actions">
                            <LinkButton size="sm" href={`/app/inventory/${product.id}`}>
                              Detail
                            </LinkButton>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </QueryState>
      </Panel>

      <CreateProductDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        tenantId={tenantId}
        categories={categories}
        onCreated={(message) => {
          notify(message, "success");
          productsState.reload();
          setCreateOpen(false);
        }}
        onError={(message) => notify(message, "error")}
      />
    </div>
  );
}

function CreateProductDialog({
  open,
  onClose,
  tenantId,
  categories,
  onCreated,
  onError,
}: {
  open: boolean;
  onClose: () => void;
  tenantId: string | null;
  categories: Array<Schema<"CategoryResponse">>;
  onCreated: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [stockMode, setStockMode] = useState<"QUANTITY" | "INDIVIDUAL_UNITS">("QUANTITY");
  const [capacity, setCapacity] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formId = useId();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!tenantId) return;
    const capacityValue = Number.parseInt(capacity, 10);
    if (!name.trim()) {
      setError("Nama produk wajib diisi.");
      return;
    }
    if (!Number.isInteger(capacityValue) || capacityValue < 0) {
      setError("Kapasitas harus bilangan bulat 0 atau lebih.");
      return;
    }
    setBusy(true);
    try {
      await catalogApi.createProduct(tenantId, {
        name: name.trim(),
        description: description.trim() || undefined,
        categoryId: categoryId || undefined,
        stockMode,
        capacity: capacityValue,
        isActive: true,
      });
      onCreated("Produk dibuat. Atur tarif agar dapat dipesan.");
      setName("");
      setDescription("");
      setCapacity("1");
    } catch (caught) {
      const message = describeApiError(caught);
      setError(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Tambah produk"
      description="Tarif dan unit fisik diatur setelah produk dibuat."
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Batal
          </Button>
          <Button type="submit" form={formId} variant="primary" loading={busy}>
            Simpan produk
          </Button>
        </>
      }
    >
      <form id={formId} className="stack" onSubmit={submit} noValidate>
        {error ? (
          <InlineAlert tone="danger">
            <span role="alert">{error}</span>
          </InlineAlert>
        ) : null}
        <TextInput label="Nama produk" required value={name} onChange={(event) => setName(event.target.value)} />
        <TextArea
          label="Deskripsi"
          value={description}
          rows={2}
          onChange={(event) => setDescription(event.target.value)}
          hint="Tampil pada katalog publik sebagai informasi produk."
        />
        <SelectInput label="Kategori" value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
          <option value="">Tanpa kategori</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </SelectInput>
        <SelectInput
          label="Tipe stok"
          required
          value={stockMode}
          onChange={(event) => setStockMode(event.target.value as "QUANTITY" | "INDIVIDUAL_UNITS")}
          hint="Unit individual memerlukan kode unit dan tidak boleh dobel pada periode yang sama."
        >
          <option value="QUANTITY">Stok kuantitas</option>
          <option value="INDIVIDUAL_UNITS">Unit individual</option>
        </SelectInput>
        <TextInput
          label={stockMode === "QUANTITY" ? "Kapasitas stok" : "Jumlah unit yang direncanakan"}
          inputMode="numeric"
          value={capacity}
          onChange={(event) => setCapacity(event.target.value.replace(/\D/g, ""))}
          hint={
            stockMode === "QUANTITY"
              ? "Jumlah unit yang dapat disewa bersamaan."
              : "Tambahkan unit fisik satu per satu di halaman detail."
          }
        />
      </form>
    </Dialog>
  );
}
