"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { adminApi, describeRequestError } from "@/shared/api/client";

type Stage = "credentials" | "mfa" | "recovery" | "codes";

/** Ekstrak secret base32 dari provisioning URI agar bisa diketik manual. */
function manualSecret(uri: string | null): string | null {
  if (!uri) return null;
  try {
    const secret = new URL(uri).searchParams.get("secret");
    return secret ? secret.replace(/(.{4})/g, "$1 ").trim() : null;
  } catch {
    return null;
  }
}

export function LoginForm({ expired }: { expired: boolean }) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [challengeToken, setChallengeToken] = useState("");
  const [enrollment, setEnrollment] = useState(false);
  const [provisioningUri, setProvisioningUri] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [savedCodes, setSavedCodes] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(
    expired ? "Sesi admin berakhir. Masuk kembali untuk melanjutkan." : null,
  );
  const [notice, setNotice] = useState<string | null>(null);

  const secret = manualSecret(provisioningUri);

  function enterConsole() {
    router.replace("/tenants");
    router.refresh();
  }

  async function submitCredentials(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await adminApi.login(email.trim().toLowerCase(), password);
      setChallengeToken(result.challenge.challengeToken);
      setEnrollment(result.status === "MFA_ENROLLMENT_REQUIRED");
      setProvisioningUri(result.challenge.provisioningUri ?? null);
      setPassword("");
      setStage("mfa");
    } catch (caught) {
      setError(describeRequestError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await adminApi.completeMfa(challengeToken, code.trim());
      if (result.recoveryCodes && result.recoveryCodes.length > 0) {
        setRecoveryCodes(result.recoveryCodes);
        setStage("codes");
      } else {
        enterConsole();
      }
    } catch (caught) {
      setError(describeRequestError(caught));
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  async function submitRecovery(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await adminApi.loginWithRecovery(challengeToken, recoveryCode.trim().toUpperCase());
      enterConsole();
    } catch (caught) {
      setError(describeRequestError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function copyCodes() {
    try {
      await navigator.clipboard.writeText(recoveryCodes.join("\n"));
      setNotice("Semua kode pemulihan disalin ke clipboard.");
    } catch {
      setError("Browser menolak akses clipboard. Salin kode secara manual.");
    }
  }

  function downloadCodes() {
    const content = [
      "Rentalio — Admin Platform",
      `Kode pemulihan untuk ${email}`,
      "Setiap kode hanya dapat dipakai sekali.",
      "",
      ...recoveryCodes,
      "",
    ].join("\n");
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "rentalio-admin-recovery-codes.txt";
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="form-grid">
      {error ? (
        <p className="alert alert--error" role="alert" aria-live="polite">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="alert alert--success" role="status" aria-live="polite">
          {notice}
        </p>
      ) : null}

      {stage === "credentials" ? (
        <form className="form-grid" onSubmit={submitCredentials} noValidate>
          <div className="field">
            <label className="label" htmlFor="email">
              Email admin
            </label>
            <input
              className="input"
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              required
              maxLength={254}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="nama@rentalio.my.id"
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="password">
              Password
            </label>
            <input
              className="input"
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={256}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          <button className="btn btn--primary" type="submit" disabled={busy}>
            {busy ? "Memeriksa…" : "Lanjutkan"}
          </button>
        </form>
      ) : null}

      {stage === "mfa" ? (
        <form className="form-grid" onSubmit={submitCode} noValidate>
          {enrollment ? (
            <>
              <p className="alert alert--info">
                Akun ini belum punya TOTP. Buka aplikasi authenticator (Google Authenticator,
                Authy, 1Password), tambahkan akun, lalu masukkan secret di bawah.
              </p>
              {secret ? (
                <div className="secret">
                  <span className="subtle">Secret TOTP (ketik manual)</span>
                  <span className="secret__value">{secret}</span>
                </div>
              ) : null}
              {provisioningUri ? (
                <details>
                  <summary>URI otentikasi lengkap</summary>
                  <p className="json">{provisioningUri}</p>
                </details>
              ) : null}
            </>
          ) : (
            <p className="subtle">Masukkan 6 digit kode dari aplikasi authenticator.</p>
          )}

          <div className="field">
            <label className="label" htmlFor="code">
              Kode 6 digit
            </label>
            <input
              className="input otp-input"
              id="code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              required
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="000000"
            />
          </div>

          <button className="btn btn--primary" type="submit" disabled={busy || code.length !== 6}>
            {busy ? "Memverifikasi…" : "Masuk"}
          </button>

          <div className="form-row">
            <button
              className="btn btn--ghost btn--sm"
              type="button"
              onClick={() => {
                setError(null);
                setStage("recovery");
              }}
            >
              Kehilangan authenticator? Pakai kode pemulihan
            </button>
            <button
              className="btn btn--ghost btn--sm"
              type="button"
              onClick={() => {
                setError(null);
                setStage("credentials");
                setChallengeToken("");
                setCode("");
              }}
            >
              Mulai ulang
            </button>
          </div>
        </form>
      ) : null}

      {stage === "recovery" ? (
        <form className="form-grid" onSubmit={submitRecovery} noValidate>
          <p className="alert alert--warning">
            Kode pemulihan hanya bisa dipakai sekali. Setelah masuk, daftarkan authenticator baru
            lewat operator lain.
          </p>
          <div className="field">
            <label className="label" htmlFor="recoveryCode">
              Kode pemulihan
            </label>
            <input
              className="input mono"
              id="recoveryCode"
              name="recoveryCode"
              autoComplete="off"
              spellCheck={false}
              required
              maxLength={21}
              value={recoveryCode}
              onChange={(event) => setRecoveryCode(event.target.value.toUpperCase())}
              placeholder="XXXXXXXXXX-XXXXXXXXXX"
            />
            <span className="hint">Format 10 karakter, tanda hubung, 10 karakter.</span>
          </div>
          <button className="btn btn--primary" type="submit" disabled={busy}>
            {busy ? "Memeriksa…" : "Masuk dengan kode pemulihan"}
          </button>
          <button
            className="btn btn--ghost btn--sm"
            type="button"
            onClick={() => {
              setError(null);
              setStage("mfa");
            }}
          >
            Kembali ke kode authenticator
          </button>
        </form>
      ) : null}

      {stage === "codes" ? (
        <div className="form-grid">
          <p className="alert alert--info">
            Simpan 10 kode ini sekarang. Kode hanya ditampilkan sekali dan masing-masing dapat
            dipakai satu kali untuk masuk bila authenticator hilang.
          </p>
          <ul className="codes">
            {recoveryCodes.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <div className="form-row">
            <button className="btn" type="button" onClick={copyCodes}>
              Salin semua
            </button>
            <button className="btn" type="button" onClick={downloadCodes}>
              Unduh .txt
            </button>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={savedCodes}
              onChange={(event) => setSavedCodes(event.target.checked)}
            />
            <span>Saya sudah menyimpan kode pemulihan di tempat aman.</span>
          </label>
          <button className="btn btn--primary" type="button" disabled={!savedCodes} onClick={enterConsole}>
            Masuk ke konsol
          </button>
        </div>
      ) : null}
    </div>
  );
}
