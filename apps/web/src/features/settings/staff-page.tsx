"use client";

import { useState } from "react";
import { tenantApi, type Schema } from "@/shared/api/endpoints";
import { describeApiError } from "@/shared/api/errors";
import { ROLE_LABEL, ROLE_PERMISSIONS, type Role } from "@/shared/auth/permissions";
import { useSession } from "@/shared/auth/session";
import { formatDateTime } from "@/shared/format/date";
import { useApi } from "@/shared/hooks/useApi";
import { Button } from "@/shared/ui/buttons";
import { SelectInput, TextArea, TextInput } from "@/shared/ui/form";
import { Dialog, useToast } from "@/shared/ui/overlays";
import { Badge, PageHeader, Panel, PanelHead, StatusBadge } from "@/shared/ui/surfaces";
import { EmptyState, InlineAlert, QueryState } from "@/shared/ui/states";

type Member = Schema<"MemberResponse">;
type InviteRole = "MANAGER" | "STAFF" | "CASHIER";

export function StaffPage() {
  const { tenantId } = useSession();
  const { notify } = useToast();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editing, setEditing] = useState<Member | null>(null);

  const state = useApi<Member[]>(tenantId ? () => tenantApi.listMembers(tenantId) : null, [tenantId]);

  return (
    <div className="page">
      <PageHeader
        title="Staf & akses"
        subtitle="Undang tim kamu dan atur peran masing-masing (Manajer, Staf, atau Kasir)."
        actions={
          <Button variant="primary" onClick={() => setInviteOpen(true)}>
            Undang staf baru
          </Button>
        }
      />

      <InlineAlert tone="info">
        Tautan undangan berlaku selama 7 hari. Kamu juga bisa langsung membagikan tautan undangan ini ke stafmu lewat WhatsApp.
      </InlineAlert>

      <Panel flush>
        <PanelHead title="Daftar tim toko" description="Kelola siapa saja yang bisa mengakses sistem tokomu." />
        <QueryState
          state={state}
          loadingRows={4}
          isEmpty={(items) => items.length === 0}
          empty={<EmptyState title="Belum ada data anggota" />}
        >
          {(items) => (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Pengguna</th>
                    <th scope="col">Peran</th>
                    <th scope="col">Status</th>
                    <th scope="col">Permission</th>
                    <th scope="col">Aktivasi</th>
                    <th scope="col" className="text-right">
                      Aksi
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((member) => (
                    <tr key={member.userId}>
                      <td className="text-sm">
                        <div className="table__primary">{member.email}</div>
                        {member.ownerName ? <div className="subtle">{member.ownerName}</div> : null}
                      </td>
                      <td>
                        <Badge tone={member.role === "OWNER" ? "info" : "neutral"}>
                          {member.role ? ROLE_LABEL[member.role as Role] : "—"}
                        </Badge>
                      </td>
                      <td>
                        <StatusBadge
                          status={{
                            label:
                              member.status === "ACTIVE"
                                ? "Aktif"
                                : member.status === "INVITED"
                                  ? "Diundang"
                                  : "Dicabut",
                            tone:
                              member.status === "ACTIVE"
                                ? "success"
                                : member.status === "INVITED"
                                  ? "warning"
                                  : "danger",
                          }}
                        />
                      </td>
                      <td className="text-sm">
                        {(member.permissions ?? []).length === 0
                          ? "Default peran"
                          : `${(member.permissions ?? []).length} izin khusus`}
                      </td>
                      <td className="text-sm">
                        {member.activatedAt ? formatDateTime(member.activatedAt) : "—"}
                      </td>
                      <td>
                        <div className="table-actions">
                          {member.role !== "OWNER" ? (
                            <Button size="sm" onClick={() => setEditing(member)}>
                              Ubah akses
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

      <Panel>
        <PanelHead title="Permission default per peran" description="Dipakai bila owner tidak mengirim daftar izin khusus." />
        <div className="panel-body stack-sm">
          {(["MANAGER", "STAFF", "CASHIER"] as const).map((role) => (
            <div key={role} className="stack-sm">
              <strong className="text-sm">{ROLE_LABEL[role]}</strong>
              <div className="cluster">
                {ROLE_PERMISSIONS[role].map((permission) => (
                  <Badge key={permission} tone="neutral" plain>
                    {permission}
                  </Badge>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <InviteDialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        tenantId={tenantId}
        onSaved={(emailDelivered) => {
          notify(
            emailDelivered
              ? "Undangan dibuat dan email dikirim."
              : "Undangan dibuat, tetapi email gagal dikirim. Bagikan tautan undangan secara aman.",
            emailDelivered ? "success" : "error",
          );
          setInviteOpen(false);
          state.reload();
        }}
        onError={(message) => notify(message, "error")}
      />

      <EditMemberDialog
        key={editing?.userId ?? "none"}
        member={editing}
        tenantId={tenantId}
        onClose={() => setEditing(null)}
        onSaved={() => {
          notify("Akses anggota diperbarui.", "success");
          setEditing(null);
          state.reload();
        }}
        onError={(message) => notify(message, "error")}
      />
    </div>
  );
}

function InviteDialog({
  open,
  onClose,
  tenantId,
  onSaved,
  onError,
}: {
  open: boolean;
  onClose: () => void;
  tenantId: string | null;
  onSaved: (emailDelivered: boolean) => void;
  onError: (message: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InviteRole>("STAFF");
  const [permissions, setPermissions] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!tenantId) return;
    setBusy(true);
    try {
      const result = await tenantApi.inviteMember(tenantId, {
        email: email.trim(),
        role,
        ...(permissions.trim()
          ? {
              permissions: permissions
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean),
            }
          : {}),
      });
      onSaved(result.emailDelivered !== false);
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
      title="Undang staf"
      description="Email berisi tautan sekali pakai. Role default sudah membawa permission minimum."
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Batal
          </Button>
          <Button type="submit" form="invite-staff" variant="primary" loading={busy}>
            Kirim undangan
          </Button>
        </>
      }
    >
      <form id="invite-staff" className="stack" onSubmit={submit}>
        <TextInput
          label="Email"
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <SelectInput label="Peran" value={role} onChange={(event) => setRole(event.target.value as InviteRole)}>
          <option value="MANAGER">Manager</option>
          <option value="STAFF">Staf</option>
          <option value="CASHIER">Kasir</option>
        </SelectInput>
        <TextArea
          label="Permission khusus (opsional)"
          rows={3}
          value={permissions}
          onChange={(event) => setPermissions(event.target.value)}
          hint="Pisahkan dengan koma, mis. order.read, payment.record. Kosongkan untuk memakai default peran."
        />
      </form>
    </Dialog>
  );
}

function EditMemberDialog({
  member,
  tenantId,
  onClose,
  onSaved,
  onError,
}: {
  member: Member | null;
  tenantId: string | null;
  onClose: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [role, setRole] = useState<InviteRole>((member?.role as InviteRole) ?? "STAFF");
  const [status, setStatus] = useState<"ACTIVE" | "REVOKED">(
    member?.status === "REVOKED" ? "REVOKED" : "ACTIVE",
  );
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!tenantId || !member?.userId) return;
    setBusy(true);
    try {
      await tenantApi.updateMember(tenantId, member.userId, { role, status });
      onSaved();
    } catch (caught) {
      onError(describeApiError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={Boolean(member)}
      onClose={onClose}
      title="Ubah akses anggota"
      description="Perubahan role/status berlaku langsung di server; sesi berikutnya memakai hak terbaru."
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Batal
          </Button>
          <Button type="submit" form="edit-member" variant="primary" loading={busy}>
            Simpan
          </Button>
        </>
      }
    >
      <form id="edit-member" className="stack" onSubmit={submit}>
        <SelectInput label="Peran" value={role} onChange={(event) => setRole(event.target.value as InviteRole)}>
          <option value="MANAGER">Manager</option>
          <option value="STAFF">Staf</option>
          <option value="CASHIER">Kasir</option>
        </SelectInput>
        <SelectInput
          label="Status membership"
          value={status}
          onChange={(event) => setStatus(event.target.value as "ACTIVE" | "REVOKED")}
          hint="REVOKED mencabut akses ke tenant ini."
        >
          <option value="ACTIVE">Aktif</option>
          <option value="REVOKED">Dicabut</option>
        </SelectInput>
      </form>
    </Dialog>
  );
}
