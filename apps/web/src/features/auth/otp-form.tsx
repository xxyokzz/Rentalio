"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { authApi } from "@/shared/api/endpoints";
import { describeApiError, isApiRequestError } from "@/shared/api/errors";
import { Button } from "@/shared/ui/buttons";
import { TextInput } from "@/shared/ui/form";
import { InlineAlert } from "@/shared/ui/states";
import { firstError, otpCodeSchema } from "@/shared/validation/schemas";
import { AuthCard } from "./auth-card";
import { clearPendingEmail, getPendingEmail, maskEmail } from "./pending";

const OTP_TTL_SECONDS = 10 * 60;
const RESEND_COOLDOWN_SECONDS = 60;
const MAX_ATTEMPTS = 5;

function formatClock(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

export function OtpForm() {
  const router = useRouter();
  const email = getPendingEmail();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(OTP_TTL_SECONDS);
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_SECONDS);
  const [attempts, setAttempts] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setSecondsLeft((value) => (value > 0 ? value - 1 : 0));
      setCooldown((value) => (value > 0 ? value - 1 : 0));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  if (!email) {
    return (
      <AuthCard
        title="Verifikasi email"
        subtitle="Sesi pendaftaran tidak ditemukan di tab ini."
        footer={
          <>
            <Link href="/register">Kembali ke pendaftaran</Link>
          </>
        }
      >
        <InlineAlert tone="warning">
          Demi keamanan, email pendaftaran tidak disimpan di browser. Ulangi pendaftaran atau buka
          tab yang masih memuat langkah verifikasi.
        </InlineAlert>
      </AuthCard>
    );
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    const parsed = otpCodeSchema.safeParse(code);
    if (!parsed.success) {
      setError(firstError(parsed));
      return;
    }
    setBusy(true);
    try {
      await authApi.verifyEmail({ email, code: parsed.data });
      clearPendingEmail();
      router.push("/login?verified=1");
    } catch (caught) {
      setAttempts((value) => value + 1);
      setError(
        isApiRequestError(caught) && caught.code === "OTP_INVALID_OR_EXPIRED"
          ? "Kode salah atau sudah kedaluwarsa. Periksa email terbaru, atau kirim ulang kode."
          : describeApiError(caught),
      );
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    if (cooldown > 0) return;
    setBusy(true);
    setError(null);
    try {
      await authApi.resendOtp({ email });
      setSecondsLeft(OTP_TTL_SECONDS);
      setCooldown(RESEND_COOLDOWN_SECONDS);
      setAttempts(0);
      setNotice("Jika email terdaftar, kode baru telah dikirim. Kode lama tidak berlaku lagi.");
    } catch (caught) {
      const message = describeApiError(caught);
      setError(message);
      if (isApiRequestError(caught) && caught.retryAfterSeconds) {
        setCooldown(caught.retryAfterSeconds);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard
      title="Verifikasi email"
      subtitle={
        <>
          Masukkan kode 6 digit yang dikirim ke <strong>{maskEmail(email)}</strong>. Kode berlaku{" "}
          {formatClock(secondsLeft)} lagi.
        </>
      }
      footer={
        <>
          Salah email? <Link href="/register">Ulangi pendaftaran</Link>
        </>
      }
    >
      <form className="stack" onSubmit={submit} noValidate>
        {error ? (
          <InlineAlert tone="danger">
            <span role="alert">{error}</span>
          </InlineAlert>
        ) : null}
        {notice ? <InlineAlert tone="info">{notice}</InlineAlert> : null}
        {attempts >= MAX_ATTEMPTS ? (
          <InlineAlert tone="warning">
            Percobaan kode sudah mencapai batas UI ({MAX_ATTEMPTS}). Server tetap menegakkan batas
            percobaan; kirim ulang kode untuk memulai hitungan baru.
          </InlineAlert>
        ) : null}
        <TextInput
          label="Kode verifikasi"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={6}
          required
          className="otp-input"
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
          hint="Anda dapat menempel (paste) kode dari email."
        />
        <Button type="submit" variant="primary" size="lg" block loading={busy}>
          Verifikasi email
        </Button>
        <Button onClick={() => void resend()} disabled={cooldown > 0 || busy} block>
          {cooldown > 0 ? `Kirim ulang dalam ${cooldown} detik` : "Kirim ulang kode"}
        </Button>
      </form>
    </AuthCard>
  );
}
