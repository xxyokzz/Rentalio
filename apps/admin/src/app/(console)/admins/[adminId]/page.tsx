import type { Metadata } from "next";
import Link from "next/link";
import { AdminApiError, getAdmin, getAdminSession } from "@/shared/api/server";
import { describeApiError } from "@/shared/api/errors";
import type { PlatformAdminDetail } from "@/shared/api/types";
import { ADMIN_STATUS_LABELS } from "@/shared/labels";
import { formatDateTime, shortId } from "@/shared/format";
import { ErrorPanel } from "@/shared/ui/states";
import { RoleActions } from "@/features/admins/role-actions";

export const metadata: Metadata = { title: "Detail admin" };
export const dynamic = "force-dynamic";

export default async function AdminDetailPage({ params }: { params: Promise<{ adminId: string }> }) {
  const { adminId } = await params;

  let admin: PlatformAdminDetail | null = null;
  let failure: string | null = null;

  try {
    admin = await getAdmin(adminId);
  } catch (error) {
    if (error instanceof AdminApiError) failure = describeApiError(error);
    else throw error;
  }

  const session = await getAdminSession();
  const isSelf = session?.id === admin?.id;

  return (
    <div className="page">
      <nav className="breadcrumb" aria-label="Remah roti">
        <Link href="/admins">Admin & role</Link>
        <span aria-hidden="true">/</span>
        <span>{admin ? admin.email : "Detail"}</span>
      </nav>

      {failure || !admin ? (
        <ErrorPanel
          title="Admin tidak dapat dimuat"
          message={failure ?? "Data admin tidak tersedia."}
        />
      ) : (
        <>
          <header className="page__head">
            <div>
              <h1 className="page__title">{admin.email}</h1>
              <p className="page__sub">
                <span className="mono">{shortId(admin.id)}</span> · dibuat{" "}
                {formatDateTime(admin.createdAt)}
              </p>
            </div>
            <div className="form-row">
              <span
                className={admin.status === "ACTIVE" ? "pill pill--active" : "pill pill--closed"}
              >
                {ADMIN_STATUS_LABELS[admin.status] ?? admin.status}
              </span>
              {isSelf ? <span className="pill pill--info">Akun Anda</span> : null}
            </div>
          </header>

          <div className="panel">
            <div className="panel__head">
              <h2 className="panel__title">Identitas & keamanan</h2>
            </div>
            <div className="panel__body">
              <dl className="dl">
                <dt>ID admin</dt>
                <dd className="mono">{admin.id}</dd>
                <dt>Status</dt>
                <dd>{ADMIN_STATUS_LABELS[admin.status] ?? admin.status}</dd>
                <dt>MFA terdaftar</dt>
                <dd>{formatDateTime(admin.mfaEnrolledAt)}</dd>
                <dt>Login terakhir</dt>
                <dd>{formatDateTime(admin.lastLoginAt)}</dd>
              </dl>
            </div>
          </div>

          <div className="panel">
            <div className="panel__head">
              <h2 className="panel__title">Role aktif</h2>
              <span className="subtle">{admin.roles.length} penugasan</span>
            </div>
            <div className="panel__body panel__body--flush">
              {admin.roles.length === 0 ? (
                <p className="empty">Admin ini belum memiliki role aktif.</p>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Kode role</th>
                        <th scope="col">Nama</th>
                        <th scope="col">Ditugaskan</th>
                      </tr>
                    </thead>
                    <tbody>
                      {admin.roles.map((role) => (
                        <tr key={role.roleCode}>
                          <td className="mono">{role.roleCode}</td>
                          <td>{role.roleName}</td>
                          <td>{formatDateTime(role.assignedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panel__head">
              <h2 className="panel__title">Permission efektif</h2>
              <span className="subtle">{admin.permissions.length} izin</span>
            </div>
            <div className="panel__body">
              {admin.permissions.length === 0 ? (
                <p className="subtle">Tidak ada permission; sesi admin ini tidak akan sah.</p>
              ) : (
                <div className="chips">
                  {admin.permissions.map((permission) => (
                    <span className="chip" key={permission}>
                      {permission}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          <RoleActions adminId={admin.id} permissions={session?.permissions ?? []} />
        </>
      )}
    </div>
  );
}
