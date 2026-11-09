"use client";

import { useState } from "react";
import { tenantCatalogUrl } from "@/shared/config/hosts";
import { Button } from "@/shared/ui/buttons";
import { TextInput } from "@/shared/ui/form";
import { InlineAlert } from "@/shared/ui/states";

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/;

/**
 * `/katalog` tanpa slug tidak boleh menebak tenant. Bila host bukan subdomain
 * tenant dan slug default belum dikonfigurasi, penyewa memasukkan slug toko
 * yang diberikan admin.
 */
export function CatalogEntry() {
  const [slug, setSlug] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const normalized = slug.trim().toLowerCase();
    if (!SLUG_PATTERN.test(normalized)) {
      setError("Slug toko hanya boleh huruf kecil, angka, dan tanda hubung (3-63 karakter).");
      return;
    }
    // Katalog hanya disajikan di host tenant, jadi buka subdomainnya langsung.
    window.location.assign(tenantCatalogUrl(normalized));
  };

  return (
    <div className="stack">
      <InlineAlert tone="info">
        Link katalog toko berbentuk <span className="mono">nama-toko.rentalio.my.id/katalog</span>. Kalau kamu punya kode nama toko (slug), masukkan di bawah ya.
      </InlineAlert>
      <form
        className="stack-sm"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <TextInput
          label="Slug toko"
          placeholder="contoh: sewa-kamera-bandung"
          value={slug}
          error={error ?? undefined}
          onChange={(event) => {
            setSlug(event.target.value);
            setError(null);
          }}
        />
        <div>
          <Button type="submit" variant="primary">
            Buka katalog
          </Button>
        </div>
      </form>
    </div>
  );
}
