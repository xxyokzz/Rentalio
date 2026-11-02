"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { adminApi, describeRequestError } from "@/shared/api/client";
import { PLATFORM_ROLES } from "@/shared/labels";

interface RoleActionsProps {
  adminId: string;
  permissions: string[];
}

/**
 * Assign dan revoke adalah dua permission berbeda: role Support boleh melihat
 * daftar tanpa boleh mengubahnya. API juga menolak menugaskan role ke diri
 * sendiri dan mencabut SUPER_ADMIN terakhir; pesannya diteruskan apa adanya.
 */
export function RoleActions({ adminId, permissions }: RoleActionsProps) {
  const router = useRouter();
  const [roleCode, setRoleCode] = useState<string>(PLATFORM_ROLES[0].code);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<"assign" | "revoke" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const canAssign = permissions.includes("platform.roles.assign");
  const canRevoke = permissions.includes("platform.roles.revoke");
  const ready = reason.trim().length >= 10 && roleCode !== "";

  async function run(action: "assign" | "revoke") {
    setBusy(action);
    setError(null);
    setNotice(null);
    try {
      if (action === "assign") await adminApi.assignRole(adminId, roleCode, reason.trim());
      else await adminApi.revokeRole(adminId, roleCode, reason.trim());
      setNotice(
        action === "assign"
          ? `Role ${roleCode} ditugaskan dan dicatat pada audit.`
          : `Role ${roleCode} dicabut dan dicatat pada audit.`,
      );
      setReason("");
      router.refresh();
    } catch (caught) {
      setError(describeRequestError(caught));
    } finally {
      setBusy(null);
    }
  }

  function onAssign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run("assign");
  }

  if (!canAssign && !canRevoke) {
    return (
      <div className="panel">
        <div className="panel__head">
          <h2 className="panel__title">Ubah role</h2>
        </div>
        <div className="panel__body">
          <p className="alert alert--info">
            Role Anda tidak memiliki izin assign/revoke. Halaman ini hanya dapat dibaca.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel__head">
        <h2 className="panel__title">Ubah role</h2>
      </div>
      <div className="panel__body">
        <form className="form-grid" onSubmit={onAssign} noValidate>
          {error ? (
            <p className="alert alert--error" role="alert">
              {error}
            </p>
          ) : null}
          {notice ? (
            <p className="alert alert--success" role="status">
              {notice}
            </p>
          ) : null}
          <div className="form-row">
            <div className="field">
              <label className="label" htmlFor="role-code">
                Role
              </label>
              <select
                className="select"
                id="role-code"
                name="roleCode"
                value={roleCode}
                onChange={(event) => setRoleCode(event.target.value)}
              >
                {PLATFORM_ROLES.map((role) => (
                  <option key={role.code} value={role.code}>
                    {role.name} ({role.code})
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="field">
            <label className="label" htmlFor="role-reason">
              Alasan
            </label>
            <textarea
              className="textarea"
              id="role-reason"
              name="reason"
              required
              minLength={10}
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="mis. penambahan operator billing untuk rekonsiliasi QRIS"
            />
            <span className="hint">{reason.trim().length}/500 karakter (minimal 10).</span>
          </div>
          <div className="form-row">
            {canAssign ? (
              <button className="btn btn--primary" type="submit" disabled={busy !== null || !ready}>
                {busy === "assign" ? "Menugaskan…" : "Tugaskan role"}
              </button>
            ) : null}
            {canRevoke ? (
              <button
                className="btn btn--danger"
                type="button"
                disabled={busy !== null || !ready}
                onClick={() => void run("revoke")}
              >
                {busy === "revoke" ? "Mencabut…" : "Cabut role"}
              </button>
            ) : null}
          </div>
        </form>
      </div>
    </div>
  );
}
