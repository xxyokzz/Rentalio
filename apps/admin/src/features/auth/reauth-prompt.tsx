"use client";

import { useState, type FormEvent } from "react";
import { adminApi, describeRequestError } from "@/shared/api/client";

/**
 * Tindakan berisiko (suspend/reactivate tenant, settle tagihan) menolak sesi
 * yang re-authentication-nya lebih tua dari 10 menit. Alih-alih menyuruh
 * operator memuat ulang halaman dan kehilangan isian, panel ini memverifikasi
 * password + TOTP pada sesi yang sama lalu melanjutkan aksi yang tertunda.
 *
 * Kode TOTP yang sudah dipakai login tidak dapat diulang (proteksi replay di
 * server), jadi operator memakai kode authenticator berikutnya bila perlu.
 */
export function ReauthPrompt({
  actionLabel,
  onVerified,
  onCancel,
}: {
  actionLabel: string;
  onVerified: () => void;
  onCancel?: () => void;
}) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = password.length > 0 && /^\d{6}$/.test(code);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await adminApi.reauthenticate(password, code);
      setPassword("");
      setCode("");
      onVerified();
    } catch (caught) {
      setError(describeRequestError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form-grid" onSubmit={submit} noValidate>
      <p className="alert alert--info" role="status">
        Sesi Anda perlu diverifikasi ulang sebelum {actionLabel}. Masukkan password dan kode
        authenticator (6 digit); aksi yang tertunda akan dilanjutkan otomatis.
      </p>
      {error ? (
        <p className="alert alert--error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="form-row">
        <div className="field">
          <label className="label" htmlFor="reauth-password">
            Password
          </label>
          <input
            className="input"
            id="reauth-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={256}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        <div className="field field--narrow">
          <label className="label" htmlFor="reauth-code">
            Kode MFA
          </label>
          <input
            className="input mono"
            id="reauth-code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            maxLength={6}
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/[^\d]/g, "").slice(0, 6))}
            placeholder="123456"
          />
        </div>
      </div>
      <div className="form-row">
        <button className="btn btn--primary" type="submit" disabled={busy || !ready}>
          {busy ? "Memverifikasi…" : "Verifikasi & lanjutkan"}
        </button>
        {onCancel ? (
          <button className="btn" type="button" onClick={onCancel} disabled={busy}>
            Batal
          </button>
        ) : null}
      </div>
    </form>
  );
}
