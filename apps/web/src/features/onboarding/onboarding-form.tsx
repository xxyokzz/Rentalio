"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { tenantApi } from "@/shared/api/endpoints";
import { describeApiError, isConflict, isValidationError } from "@/shared/api/errors";
import { useSession } from "@/shared/auth/session";
import { Button } from "@/shared/ui/buttons";
import { SelectInput, TextInput } from "@/shared/ui/form";
import { InlineAlert } from "@/shared/ui/states";
import { firstError, slugSchema, suggestSlug, tenantNameSchema } from "@/shared/validation/schemas";

const TIMEZONES = [
  { value: "Asia/Jakarta", label: "WIB — Asia/Jakarta" },
  { value: "Asia/Makassar", label: "WITA — Asia/Makassar" },
  { value: "Asia/Jayapura", label: "WIT — Asia/Jayapura" },
];

export function OnboardingForm() {
  const router = useRouter();
  const { refresh, email, profile } = useSession();
  // Prefill dari data pendaftaran (dokumen 04): nama toko + usulan slug yang
  // dikirim saat registrasi. Slug hasil registrasi dianggap pilihan pengguna
  // (slugTouched), sehingga tidak ditimpa saat nama diubah; tanpa slug
  // registrasi, slug mengikuti nama seperti perilaku lama.
  const prefilledName = profile?.tenantName?.trim() ?? "";
  const prefilledSlug = profile?.tenantSlug?.trim() ?? "";
  const [name, setName] = useState(prefilledName);
  const [slug, setSlug] = useState(prefilledSlug || suggestSlug(prefilledName));
  const [slugTouched, setSlugTouched] = useState(prefilledSlug.length > 0);
  const [timezone, setTimezone] = useState("Asia/Jakarta");
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onNameChange = (value: string) => {
    setName(value);
    if (!slugTouched) setSlug(suggestSlug(value));
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    const nextErrors: Record<string, string | undefined> = {};
    const nameCheck = tenantNameSchema.safeParse(name);
    if (!nameCheck.success) nextErrors.name = firstError(nameCheck) ?? undefined;
    const slugCheck = slugSchema.safeParse(slug);
    if (!slugCheck.success) nextErrors.slug = firstError(slugCheck) ?? undefined;
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0 || !nameCheck.success || !slugCheck.success) return;

    setBusy(true);
    try {
      await tenantApi.create({ name: nameCheck.data, slug: slugCheck.data, timezone });
      await refresh();
      router.replace("/app");
    } catch (caught) {
      setError(
        isConflict(caught)
          ? "Subdomain tersebut sudah dipakai tenant lain. Pilih slug berbeda."
          : isValidationError(caught)
            ? describeApiError(caught)
            : describeApiError(caught),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div>
        <h1 className="page-title">Yuk, lengkapi data tokomu</h1>
        <p className="page-subtitle">
          {email ? `Akun ${email} sudah siap! ` : ""}Sekarang tentukan nama toko dan link katalog tokomu. Nomor telepon, alamat, dan data lainnya bisa dilengkapi kapan saja nanti.
        </p>
      </div>
      <form className="stack" onSubmit={submit} noValidate>
        {error ? (
          <InlineAlert tone="danger">
            <span role="alert">{error}</span>
          </InlineAlert>
        ) : null}
        <TextInput
          label="Nama toko / rental"
          required
          value={name}
          error={errors.name}
          onChange={(event) => onNameChange(event.target.value)}
          hint="Nama toko kamu yang akan tampil di katalog dan pesan WhatsApp."
        />
        <TextInput
          label="Link katalog (subdomain)"
          required
          value={slug}
          error={errors.slug}
          onChange={(event) => {
            setSlugTouched(true);
            setSlug(event.target.value.toLowerCase());
          }}
          hint={`Katalog tokomu nantinya bisa dibuka di: ${slug || "namatoko"}.rentalio.my.id/katalog`}
        />
        <SelectInput
          label="Zona waktu"
          required
          value={timezone}
          onChange={(event) => setTimezone(event.target.value)}
          hint="Semua jadwal booking dan jam operasional akan mengikuti zona waktu ini."
        >
          {TIMEZONES.map((zone) => (
            <option key={zone.value} value={zone.value}>
              {zone.label}
            </option>
          ))}
        </SelectInput>
        <Button type="submit" variant="primary" size="lg" block loading={busy}>
          Buka toko sekarang
        </Button>
      </form>
    </div>
  );
}
