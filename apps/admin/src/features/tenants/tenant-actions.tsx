"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { adminApi, describeRequestError, isReauthenticationRequired } from "@/shared/api/client";
import { ReauthPrompt } from "@/features/auth/reauth-prompt";
import type { TenantStatus } from "@/shared/api/types";

interface ActionProps {
  tenantId: string;
  status: TenantStatus;
  permissions: string[];
}

/**
 * Aksi status sengaja meminta alasan tertulis: API menyimpannya pada audit
 * append-only, jadi tombol tidak boleh menjadi satu klik tanpa jejak.
 */
export function TenantStatusPanel({ tenantId, status, permissions }: ActionProps) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reauthNeeded, setReauthNeeded] = useState(false);

  const canSuspend = permissions.includes("platform.tenants.suspend");
  const canReactivate = permissions.includes("platform.tenants.reactivate");
  const mode: "suspend" | "reactivate" | null =
    status === "SUSPENDED"
      ? canReactivate
        ? "reactivate"
        : null
      : status === "ACTIVE" || status === "PENDING_ACTIVATION"
        ? canSuspend
          ? "suspend"
          : null
        : null;

  const blockedReason =
    status === "CLOSED"
      ? "Tenant berstatus CLOSED bersifat final; tidak ada perubahan status yang diizinkan."
      : status === "SUSPENDED" && !canReactivate
        ? "Role Anda tidak memiliki izin mengaktifkan kembali tenant."
        : (status === "ACTIVE" || status === "PENDING_ACTIVATION") && !canSuspend
          ? "Role Anda tidak memiliki izin menangguhkan tenant."
          : null;

  async function run() {
    if (!mode) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === "suspend") await adminApi.suspendTenant(tenantId, reason.trim());
      else await adminApi.reactivateTenant(tenantId, reason.trim());
      setNotice(
        mode === "suspend" ? "Tenant ditangguhkan dan dicatat pada audit." : "Tenant diaktifkan kembali.",
      );
      setReauthNeeded(false);
      setReason("");
      router.refresh();
    } catch (caught) {
      // Sesi yang re-auth-nya lebih tua dari 10 menit ditolak API; minta
      // verifikasi ulang lalu ulangi aksi yang sama tanpa kehilangan isian.
      if (isReauthenticationRequired(caught)) setReauthNeeded(true);
      else setError(describeRequestError(caught));
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run();
  }

  return (
    <div className="panel">
      <div className="panel__head">
        <h2 className="panel__title">Status tenant</h2>
      </div>
      <div className="panel__body">
        {blockedReason ? (
          <p className="alert alert--info">{blockedReason}</p>
        ) : (
          <form className="form-grid" onSubmit={submit} noValidate>
            <p className="subtle">
              {mode === "suspend"
                ? "Menangguhkan tenant menghentikan operasi baru bagi seluruh penggunanya. Alasan wajib diisi (minimal 10 karakter) dan tersimpan pada audit."
                : "Mengaktifkan kembali tenant memulihkan akses penggunanya. Alasan wajib diisi (minimal 10 karakter)."}
            </p>
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
            <div className="field">
              <label className="label" htmlFor="status-reason">
                Alasan
              </label>
              <textarea
                className="textarea"
                id="status-reason"
                name="reason"
                required
                minLength={10}
                maxLength={500}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="mis. tunggakan langganan belum diselesaikan sejak 12 Okt"
              />
              <span className="hint">{reason.trim().length}/500 karakter (minimal 10).</span>
            </div>
            {reauthNeeded ? (
              <ReauthPrompt
                actionLabel={mode === "suspend" ? "menangguhkan tenant" : "mengaktifkan kembali tenant"}
                onVerified={() => {
                  setReauthNeeded(false);
                  void run();
                }}
                onCancel={() => setReauthNeeded(false)}
              />
            ) : (
              <div className="form-row">
                <button
                  className={mode === "suspend" ? "btn btn--danger" : "btn btn--primary"}
                  type="submit"
                  disabled={busy || reason.trim().length < 10}
                >
                  {busy
                    ? "Memproses…"
                    : mode === "suspend"
                      ? "Tangguhkan tenant"
                      : "Aktifkan kembali tenant"}
                </button>
              </div>
            )}
          </form>
        )}
      </div>
    </div>
  );
}

/**
 * QRIS dinamis tidak punya callback: operator menandai tagihan lunas setelah
 * dana terverifikasi. API memvalidasi status PENDING dan mencatat referensi.
 */
export function SettleInvoicePanel({ tenantId, permissions }: Omit<ActionProps, "status">) {
  const router = useRouter();
  const [invoiceId, setInvoiceId] = useState("");
  const [paidAmount, setPaidAmount] = useState("");
  const [channel, setChannel] = useState("QRIS");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reauthNeeded, setReauthNeeded] = useState(false);

  const allowed = permissions.includes("platform.subscriptions.settle");

  if (!allowed) {
    return (
      <div className="panel">
        <div className="panel__head">
          <h2 className="panel__title">Tagihan langganan</h2>
        </div>
        <div className="panel__body">
          <p className="alert alert--info">
            Role Anda tidak memiliki izin <span className="mono">platform.subscriptions.settle</span>{" "}
            untuk menandai tagihan lunas.
          </p>
        </div>
      </div>
    );
  }

  async function run() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const amount = paidAmount.trim() === "" ? undefined : Number(paidAmount);
      await adminApi.settleInvoice(tenantId, invoiceId.trim(), {
        ...(amount !== undefined && Number.isFinite(amount) ? { paidAmount: Math.trunc(amount) } : {}),
        channel: channel.trim() || undefined,
        reason: reason.trim(),
      });
      setNotice("Tagihan ditandai lunas; langganan diperpanjang dan audit tercatat.");
      setReauthNeeded(false);
      setInvoiceId("");
      setPaidAmount("");
      setReason("");
      router.refresh();
    } catch (caught) {
      // Settle adalah tindakan berisiko: API meminta re-auth yang masih segar.
      if (isReauthenticationRequired(caught)) setReauthNeeded(true);
      else setError(describeRequestError(caught));
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run();
  }

  return (
    <div className="panel">
      <div className="panel__head">
        <h2 className="panel__title">Tagihan langganan</h2>
        <span className="subtle">Hanya tagihan berstatus PENDING</span>
      </div>
      <div className="panel__body">
        <form className="form-grid" onSubmit={submit} noValidate>
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
              <label className="label" htmlFor="invoice-id">
                ID tagihan
              </label>
              <input
                className="input mono"
                id="invoice-id"
                name="invoiceId"
                required
                value={invoiceId}
                onChange={(event) => setInvoiceId(event.target.value)}
                placeholder="uuid tagihan"
              />
            </div>
            <div className="field field--narrow">
              <label className="label" htmlFor="paid-amount">
                Nominal diterima (IDR)
              </label>
              <input
                className="input mono"
                id="paid-amount"
                name="paidAmount"
                inputMode="numeric"
                value={paidAmount}
                onChange={(event) => setPaidAmount(event.target.value.replace(/[^\d]/g, ""))}
                placeholder="kosong = nilai tagihan"
              />
            </div>
            <div className="field field--narrow">
              <label className="label" htmlFor="channel">
                Channel
              </label>
              <input
                className="input"
                id="channel"
                name="channel"
                maxLength={60}
                value={channel}
                onChange={(event) => setChannel(event.target.value)}
              />
            </div>
          </div>
          <div className="field">
            <label className="label" htmlFor="settle-reason">
              Referensi pembayaran
            </label>
            <textarea
              className="textarea"
              id="settle-reason"
              name="reason"
              required
              minLength={10}
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="mis. mutasi BCA 2 Nov 2026, ref 88231009"
            />
            <span className="hint">
              Wajib, minimal 10 karakter. Simpan id mutasi/berita transfer sebagai jejak audit.
            </span>
          </div>
          {reauthNeeded ? (
            <ReauthPrompt
              actionLabel="menandai tagihan lunas"
              onVerified={() => {
                setReauthNeeded(false);
                void run();
              }}
              onCancel={() => setReauthNeeded(false)}
            />
          ) : (
            <div className="form-row">
              <button
                className="btn btn--primary"
                type="submit"
                disabled={busy || invoiceId.trim() === "" || reason.trim().length < 10}
              >
                {busy ? "Memproses…" : "Tandai lunas"}
              </button>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
