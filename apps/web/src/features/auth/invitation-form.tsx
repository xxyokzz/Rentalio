"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { authApi } from "@/shared/api/endpoints";
import { describeApiError, isApiRequestError } from "@/shared/api/errors";
import { Button } from "@/shared/ui/buttons";
import { TextInput } from "@/shared/ui/form";
import { InlineAlert } from "@/shared/ui/states";
import { firstError, passwordSchema } from "@/shared/validation/schemas";
import { AuthCard } from "./auth-card";

export function InvitationForm({ token }: { token: string | null }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!token) {
    return (
      <AuthCard title="Undangan tidak valid" footer={<Link href="/login">Kembali ke halaman masuk</Link>}>
        <InlineAlert tone="warning">
          Tautan undangan tidak memuat token. Undangan berlaku 7 hari dan hanya dapat dipakai sekali;
          minta owner mengirim ulang bila perlu.
        </InlineAlert>
      </AuthCard>
    );
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    const nextErrors: Record<string, string | undefined> = {};
    if (password) {
      const parsed = passwordSchema.safeParse(password);
      if (!parsed.success) nextErrors.password = firstError(parsed) ?? undefined;
      if (password !== confirm) nextErrors.confirm = "Konfirmasi kata sandi tidak cocok.";
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setBusy(true);
    try {
      await authApi.acceptInvitation({ token, ...(password ? { password } : {}) });
      router.push("/login?invited=1");
    } catch (caught) {
      setError(
        isApiRequestError(caught) && caught.code === "INVITATION_INVALID_OR_EXPIRED"
          ? "Undangan sudah kedaluwarsa atau sudah dipakai. Minta owner mengirim undangan baru."
          : describeApiError(caught),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard
      title="Terima undangan staf"
      subtitle="Isi kata sandi bila email Anda belum memiliki akun Rentalio. Bila sudah punya akun, cukup terima undangan tanpa mengubah kata sandi."
      footer={<Link href="/login">Kembali ke halaman masuk</Link>}
    >
      <form className="stack" onSubmit={submit} noValidate>
        {error ? (
          <InlineAlert tone="danger">
            <span role="alert">{error}</span>
          </InlineAlert>
        ) : null}
        <TextInput
          label="Kata sandi (opsional untuk akun baru)"
          type="password"
          autoComplete="new-password"
          value={password}
          error={errors.password}
          onChange={(event) => setPassword(event.target.value)}
          hint="Minimal 12 karakter. Tidak pernah mengubah password akun yang sudah ada."
        />
        <TextInput
          label="Konfirmasi kata sandi"
          type="password"
          autoComplete="new-password"
          value={confirm}
          error={errors.confirm}
          onChange={(event) => setConfirm(event.target.value)}
          disabled={!password}
        />
        <Button type="submit" variant="primary" size="lg" block loading={busy}>
          Terima undangan
        </Button>
      </form>
    </AuthCard>
  );
}
