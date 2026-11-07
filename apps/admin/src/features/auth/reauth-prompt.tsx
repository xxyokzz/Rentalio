"use client";

import { useState } from "react";
import { adminApi, describeRequestError } from "@/shared/api/client";

/**
 * Tindakan berisiko (suspend/reactivate tenant, settle tagihan, assign/revoke
 * role) menolak sesi yang re-authentication-nya lebih tua dari 10 menit.
 * Alih-alih menyuruh operator memuat ulang halaman dan kehilangan isian, panel
 * ini memverifikasi password + TOTP pada sesi yang sama lalu melanjutkan aksi
 * yang tertunda.
 *
 * Sengaja TIDAK memakai elemen `<form>`: komponen ini dirender di dalam form
 * panel aksi, dan form bersarang membuat tombol verifikasi memicu submit native
 * (GET) yang membocorkan password/kode MFA ke URL. Tombolnya bertipe `button`
 * dan Enter ditangani eksplisit.
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

  async function verify() {
    if (!ready || busy) return;
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

  function onKeyDown(event: { key: string; preventDefault: () => void }) {
    if (event.key !== "Enter") return;
    // Enter di sini tidak boleh meneruskan submit ke form panel di atasnya.
    event.preventDefault();
    void verify();
  }

  return (
    <div className="form-grid">
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
            name="reauth-password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={256}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className="field field--narrow">
          <label className="label" htmlFor="reauth-code">
            Kode MFA
          </label>
          <input
            className="input mono"
            id="reauth-code"
            name="reauth-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            maxLength={6}
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/[^\d]/g, "").slice(0, 6))}
            onKeyDown={onKeyDown}
            placeholder="123456"
          />
        </div>
      </div>
      <div className="form-row">
        <button className="btn btn--primary" type="button" disabled={busy || !ready} onClick={() => void verify()}>
          {busy ? "Memverifikasi…" : "Verifikasi & lanjutkan"}
        </button>
        {onCancel ? (
          <button className="btn" type="button" onClick={onCancel} disabled={busy}>
            Batal
          </button>
        ) : null}
      </div>
    </div>
  );
}
