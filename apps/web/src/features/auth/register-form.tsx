"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { authApi } from "@/shared/api/endpoints";
import { describeApiError } from "@/shared/api/errors";
import { PRIVACY_VERSION, TERMS_VERSION } from "@/shared/config/legal";
import { Button } from "@/shared/ui/buttons";
import { CheckboxField, TextInput } from "@/shared/ui/form";
import { InlineAlert } from "@/shared/ui/states";
import {
  emailSchema,
  firstError,
  ownerNameSchema,
  passwordSchema,
  slugSchema,
  suggestSlug,
  tenantNameSchema,
} from "@/shared/validation/schemas";
import { AuthCard } from "./auth-card";
import { setPendingEmail } from "./pending";

export function RegisterForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [tenantName, setTenantName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    const nextErrors: Record<string, string | undefined> = {};
    const emailCheck = emailSchema.safeParse(email);
    if (!emailCheck.success) nextErrors.email = firstError(emailCheck) ?? undefined;
    const ownerCheck = ownerNameSchema.safeParse(ownerName);
    if (!ownerCheck.success) nextErrors.ownerName = firstError(ownerCheck) ?? undefined;
    const nameCheck = tenantNameSchema.safeParse(tenantName);
    if (!nameCheck.success) nextErrors.tenantName = firstError(nameCheck) ?? undefined;
    // Slug opsional: kosong = tidak dikirim, onboarding yang menentukan nanti.
    let slugValue: string | undefined;
    if (slug.trim()) {
      const slugCheck = slugSchema.safeParse(slug);
      if (!slugCheck.success) nextErrors.slug = firstError(slugCheck) ?? undefined;
      else slugValue = slugCheck.data;
    }
    const passwordCheck = passwordSchema.safeParse(password);
    if (!passwordCheck.success) nextErrors.password = firstError(passwordCheck) ?? undefined;
    if (password !== confirm) nextErrors.confirm = "Konfirmasi kata sandi tidak cocok.";
    if (!accepted) nextErrors.accepted = "Anda harus menyetujui Syarat Layanan dan Kebijakan Privasi.";
    setErrors(nextErrors);
    if (
      Object.keys(nextErrors).length > 0 ||
      !emailCheck.success ||
      !ownerCheck.success ||
      !nameCheck.success
    )
      return;

    setBusy(true);
    try {
      await authApi.register({
        email: emailCheck.data,
        password,
        // Profil pendaftaran (dokumen 04): disimpan backend, dipakai sebagai
        // prefill nama toko + link katalog di halaman onboarding.
        ownerName: ownerCheck.data,
        tenantName: nameCheck.data,
        ...(slugValue ? { tenantSlug: slugValue } : {}),
        // Bukti persetujuan (dokumen 04): backend menyimpan versi + timestamp.
        termsAccepted: true,
        termsVersion: TERMS_VERSION,
        privacyVersion: PRIVACY_VERSION,
      });
      setPendingEmail(emailCheck.data);
      router.push("/register/verify");
    } catch (caught) {
      // Respons signup bersifat generik; jangan bocorkan apakah email terdaftar.
      setError(describeApiError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard
      title="Daftar sebagai owner"
      subtitle="Buat akun, verifikasi email, lalu lengkapi data usaha. Nomor telepon dan data pajak tidak diminta pada tahap ini."
      footer={
        <>
          Sudah punya akun? <Link href="/login">Masuk</Link>
        </>
      }
    >
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
          error={errors.email}
          onChange={(event) => setEmail(event.target.value)}
          hint="Kode verifikasi 6 digit akan dikirim ke alamat ini."
        />
        <TextInput
          label="Nama lengkap"
          autoComplete="name"
          required
          value={ownerName}
          error={errors.ownerName}
          onChange={(event) => setOwnerName(event.target.value)}
        />
        <TextInput
          label="Nama toko / rental"
          autoComplete="organization"
          required
          value={tenantName}
          error={errors.tenantName}
          onChange={(event) => {
            const value = event.target.value;
            setTenantName(value);
            if (!slugTouched) setSlug(suggestSlug(value));
          }}
          hint="Bisa diubah lagi saat onboarding."
        />
        <TextInput
          label="Link katalog (opsional)"
          value={slug}
          error={errors.slug}
          onChange={(event) => {
            setSlug(event.target.value);
            setSlugTouched(true);
          }}
          hint="Usulan otomatis dari nama toko — hanya huruf kecil, angka, dan tanda hubung."
        />
        <TextInput
          label="Kata sandi"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          error={errors.password}
          onChange={(event) => setPassword(event.target.value)}
          hint="Minimal 12 karakter. Password manager dan paste diperbolehkan."
        />
        <TextInput
          label="Konfirmasi kata sandi"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          error={errors.confirm}
          onChange={(event) => setConfirm(event.target.value)}
        />
        <CheckboxField
          label={
            <>
              Saya menyetujui <Link href="/legal/terms">Syarat Layanan</Link> dan{" "}
              <Link href="/legal/privacy">Kebijakan Privasi</Link> (versi {TERMS_VERSION}).
            </>
          }
          checked={accepted}
          onChange={setAccepted}
          error={errors.accepted}
        />
        <Button type="submit" variant="primary" size="lg" block loading={busy}>
          Kirim kode verifikasi
        </Button>
      </form>
    </AuthCard>
  );
}
