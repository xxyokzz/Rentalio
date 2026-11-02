"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { authApi } from "@/shared/api/endpoints";
import { describeApiError, isApiRequestError } from "@/shared/api/errors";
import { Button } from "@/shared/ui/buttons";
import { TextInput } from "@/shared/ui/form";
import { InlineAlert } from "@/shared/ui/states";
import { emailSchema, firstError, passwordSchema } from "@/shared/validation/schemas";
import { AuthCard } from "./auth-card";

export function PasswordResetRequestForm() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) {
      setFieldError(firstError(parsed));
      return;
    }
    setFieldError(null);
    setBusy(true);
    try {
      await authApi.requestPasswordReset({ email: parsed.data });
      setSent(true);
    } catch (caught) {
      // Respons reset juga generik; jangan bocorkan status pendaftaran email.
      setError(describeApiError(caught));
      setSent(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard
      title="Lupa kata sandi"
      subtitle="Kami akan mengirim tautan reset jika alamat email terdaftar. Tautan berlaku 30 menit dan hanya bisa dipakai sekali."
      footer={
        <>
          Ingat kata sandi? <Link href="/login">Masuk</Link>
        </>
      }
    >
      {sent ? (
        <div className="stack">
          <InlineAlert tone="info">
            Jika email tersebut terdaftar, tautan reset akan dikirim. Periksa inbox dan folder spam.
            Demi keamanan, kami tidak mengonfirmasi apakah email terdaftar.
          </InlineAlert>
          <Link href="/login" className="btn btn-secondary btn-block">
            Kembali ke halaman masuk
          </Link>
        </div>
      ) : (
        <form className="stack" onSubmit={submit} noValidate>
          {error ? (
            <InlineAlert tone="danger">
              <span role="alert">{error}</span>
            </InlineAlert>
          ) : null}
          <TextInput
            label="Email"
            type="email"
            autoComplete="email"
            required
            value={email}
            error={fieldError ?? undefined}
            onChange={(event) => setEmail(event.target.value)}
          />
          <Button type="submit" variant="primary" size="lg" block loading={busy}>
            Kirim tautan reset
          </Button>
        </form>
      )}
    </AuthCard>
  );
}

export function PasswordResetCompleteForm({ token }: { token: string | null }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!token) {
    return (
      <AuthCard title="Tautan reset tidak valid" footer={<Link href="/forgot-password">Minta tautan baru</Link>}>
        <InlineAlert tone="warning">
          Tautan reset tidak memuat token. Minta tautan baru; token lama tidak dapat dipakai ulang.
        </InlineAlert>
      </AuthCard>
    );
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    const nextErrors: Record<string, string | undefined> = {};
    const parsed = passwordSchema.safeParse(password);
    if (!parsed.success) nextErrors.password = firstError(parsed) ?? undefined;
    if (password !== confirm) nextErrors.confirm = "Konfirmasi kata sandi tidak cocok.";
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setBusy(true);
    try {
      await authApi.completePasswordReset({ token, newPassword: password });
      router.push("/login?reset=1");
    } catch (caught) {
      setError(
        isApiRequestError(caught) && caught.code === "RESET_TOKEN_INVALID_OR_EXPIRED"
          ? "Tautan reset sudah kedaluwarsa atau sudah dipakai. Minta tautan baru."
          : describeApiError(caught),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard
      title="Atur kata sandi baru"
      subtitle="Setelah berhasil, semua sesi lama dicabut dan Anda harus masuk kembali."
    >
      <form className="stack" onSubmit={submit} noValidate>
        {error ? (
          <InlineAlert tone="danger">
            <span role="alert">{error}</span>
          </InlineAlert>
        ) : null}
        <TextInput
          label="Kata sandi baru"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          error={errors.password}
          onChange={(event) => setPassword(event.target.value)}
          hint="Minimal 12 karakter, maksimal 128 karakter."
        />
        <TextInput
          label="Konfirmasi kata sandi baru"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          error={errors.confirm}
          onChange={(event) => setConfirm(event.target.value)}
        />
        <Button type="submit" variant="primary" size="lg" block loading={busy}>
          Simpan kata sandi
        </Button>
      </form>
    </AuthCard>
  );
}
