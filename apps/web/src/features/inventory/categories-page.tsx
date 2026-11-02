"use client";

import { useState } from "react";
import { catalogApi, type Schema } from "@/shared/api/endpoints";
import { describeApiError } from "@/shared/api/errors";
import { can, type Role } from "@/shared/auth/permissions";
import { useSession } from "@/shared/auth/session";
import { useApi } from "@/shared/hooks/useApi";
import { Button } from "@/shared/ui/buttons";
import { TextInput } from "@/shared/ui/form";
import { ConfirmDialog, Dialog, useToast } from "@/shared/ui/overlays";
import { Badge, PageHeader, Panel, PanelHead } from "@/shared/ui/surfaces";
import { EmptyState, InlineAlert, QueryState } from "@/shared/ui/states";

type Category = Schema<"CategoryResponse">;

export function CategoriesPage() {
  const { tenantId, role } = useSession();
  const { notify } = useToast();
  const canWrite = can(role as Role | undefined, "catalog.write");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Category | null>(null);
  const [deleting, setDeleting] = useState<Category | null>(null);

  const state = useApi<Category[]>(
    tenantId ? () => catalogApi.listCategories(tenantId) : null,
    [tenantId],
  );

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!tenantId) return;
    if (!name.trim()) {
      notify("Nama kategori wajib diisi.", "error");
      return;
    }
    setBusy(true);
    try {
      await catalogApi.createCategory(tenantId, { name: name.trim() });
      setName("");
      notify("Kategori dibuat.", "success");
      state.reload();
    } catch (error) {
      notify(describeApiError(error), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="Kategori"
        subtitle="Kelompokkan produk biar pelanggan lebih gampang cari barang yang mau disewa."
        actions={canWrite ? null : <Badge tone="neutral">Hanya baca</Badge>}
      />

      {canWrite ? (
        <Panel>
          <PanelHead title="Tambah kategori" />
          <form className="panel-body" onSubmit={create}>
            <div className="row" style={{ alignItems: "flex-end" }}>
              <TextInput
                label="Nama kategori"
                value={name}
                onChange={(event) => setName(event.target.value)}
                wrapperClassName="field-grow"
              />
              <Button type="submit" variant="primary" loading={busy}>
                Tambah
              </Button>
            </div>
          </form>
        </Panel>
      ) : (
        <InlineAlert tone="info">Akun kamu cuma punya akses lihat kategori ya.</InlineAlert>
      )}

      <Panel flush>
        <PanelHead title="Daftar kategori" />
        <QueryState
          state={state}
          loadingRows={4}
          isEmpty={(items) => items.length === 0}
          empty={<EmptyState title="Belum ada kategori" description="Tambahkan kategori agar katalog lebih mudah ditelusuri." />}
        >
          {(items) => (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Nama</th>
                    <th scope="col" className="text-right">
                      Aksi
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((category) => (
                    <tr key={category.id}>
                      <td>{category.name}</td>
                      <td>
                        <div className="table-actions">
                          {canWrite ? (
                            <>
                              <Button size="sm" onClick={() => setEditing(category)}>
                                Ubah
                              </Button>
                              <Button size="sm" variant="danger" onClick={() => setDeleting(category)}>
                                Hapus
                              </Button>
                            </>
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

      <RenameCategoryDialog
        key={editing?.id ?? "none"}
        category={editing}
        tenantId={tenantId}
        onClose={() => setEditing(null)}
        onSaved={() => {
          notify("Kategori diperbarui.", "success");
          setEditing(null);
          state.reload();
        }}
        onError={(message) => notify(message, "error")}
      />

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!tenantId || !deleting?.id) return;
          try {
            await catalogApi.deleteCategory(tenantId, deleting.id);
            notify("Kategori dihapus.", "success");
            setDeleting(null);
            state.reload();
          } catch (error) {
            notify(describeApiError(error), "error");
          }
        }}
        title={`Hapus kategori "${deleting?.name ?? ""}"?`}
        consequence="Penghapusan gagal bila masih ada produk di kategori ini. Pindahkan produk terlebih dahulu; tindakan ini tidak dapat dibatalkan."
        confirmLabel="Hapus kategori"
        destructive
      />
    </div>
  );
}

function RenameCategoryDialog({
  category,
  tenantId,
  onClose,
  onSaved,
  onError,
}: {
  category: Category | null;
  tenantId: string | null;
  onClose: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [value, setValue] = useState(category?.name ?? "");
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!tenantId || !category?.id) return;
    setBusy(true);
    try {
      await catalogApi.updateCategory(tenantId, category.id, { name: value.trim() });
      onSaved();
    } catch (error) {
      onError(describeApiError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={Boolean(category)}
      onClose={onClose}
      title="Ubah nama kategori"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Batal
          </Button>
          <Button type="submit" form="rename-category" variant="primary" loading={busy}>
            Simpan
          </Button>
        </>
      }
    >
      <form id="rename-category" className="stack" onSubmit={submit}>
        <TextInput label="Nama kategori" required value={value} onChange={(event) => setValue(event.target.value)} />
      </form>
    </Dialog>
  );
}
