"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { describeApiError, isApiRequestError } from "@/shared/api/errors";
import { useSession } from "@/shared/auth/session";
import { Button } from "@/shared/ui/buttons";
import { TextInput } from "@/shared/ui/form";
import { InlineAlert } from "@/shared/ui/states";
import { emailSchema, firstError } from "@/shared/validation/schemas";
import { AuthCard } from "./auth-card";

export function LoginForm({ next, verified }: { next?: string; verified?: boolean }) {
  const router = useRouter();
  const { signIn } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    const emailCheck = emailSchema.safeParse(email);
    if (!emailCheck.success) {
      setFieldError(firstError(emailCheck));
      return;
    }
    setFieldError(null);
    setBusy(true);
    try {
      await signIn(emailCheck.data, password);
      const target = next && next.startsWith("/") ? next : "/app";
      router.replace(target);
    } catch (caught) {
      setError(
        isApiRequestError(caught) && caught.status === 401
          ? "Email atau kata sandi salah, atau akun kamu belum diverifikasi."
          : describeApiError(caught),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard
      title="Masuk ke Rentalio"
      subtitle="Silakan masuk pakai akun pemilik toko atau staf kamu."
      footer={
        <>
          Belum punya akun? <Link href="/register">Daftar sebagai owner</Link>
          <br />
          <Link href="/forgot-password">Lupa kata sandi?</Link>
        </>
      }
    >
      {verified ? (
        <InlineAlert tone="info">
          Email berhasil diverifikasi! Silakan masuk untuk lanjut atur toko kamu.
        </InlineAlert>
      ) : null}
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
        <TextInput
          label="Kata sandi"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <Button type="submit" variant="primary" size="lg" block loading={busy}>
          Masuk
        </Button>
      </form>
    </AuthCard>
  );
}
