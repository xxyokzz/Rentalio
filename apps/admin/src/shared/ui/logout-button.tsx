"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { adminApi, describeRequestError } from "@/shared/api/client";

/**
 * Logout membutuhkan CSRF + Origin admin; keduanya ditangani klien API.
 * Setelah sesi dicabut, cookie dihapus oleh server dan halaman kembali ke login.
 */
export function LogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setBusy(true);
    setError(null);
    try {
      await adminApi.logout();
      router.replace("/login");
      router.refresh();
    } catch (caught) {
      setError(describeRequestError(caught));
      setBusy(false);
    }
  }

  return (
    <div className="sidebar__action">
      <button type="button" className="btn btn--sm" onClick={onClick} disabled={busy}>
        {busy ? "Keluar…" : "Keluar"}
      </button>
      {error ? <p className="sidebar__error">{error}</p> : null}
    </div>
  );
}
