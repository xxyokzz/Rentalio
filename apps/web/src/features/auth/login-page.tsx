"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AuthSplit } from "./auth-split";
import { LoginForm } from "./login-form";

export function LoginPage({ tenantName, slug }: { tenantName?: string; slug?: string }) {
  const params = useSearchParams();
  const next = params.get("next");
  const verified = params.get("verified") === "1";
  const reset = params.get("reset") === "1";
  const invited = params.get("invited") === "1";

  const catalogHref = slug ? `/t/${slug}/katalog` : "/katalog";

  return (
    <AuthSplit
      eyebrow={tenantName ? `Toko ${tenantName}` : "Masuk"}
      title={tenantName ? `Masuk ke ${tenantName}` : "Selamat datang kembali!"}
      lede={
        tenantName
          ? `Portal masuk resmi untuk pemilik dan tim ${tenantName}. Kelola stok barang, pesanan sewa, dan operasional tokomu di sini.`
          : "Kelola stok barang, pesanan sewa, dan pembayaran toko kamu jadi jauh lebih gampang dan rapi."
      }
      points={[
        "Pantau jadwal booking dan status sewa barang secara rapi.",
        "Aman dan terkontrol untuk pemilik maupun staf toko.",
        "Data toko kamu selalu aman, privat, dan terpisah.",
      ]}
      asideFoot={
        tenantName ? (
          <span>
            Pelanggan ingin melihat katalog barang?{" "}
            <Link href={catalogHref} style={{ color: "var(--sw-brand)", textDecoration: "underline" }}>
              Buka katalog publik
            </Link>
          </span>
        ) : (
          "Data toko kamu terlindungi dengan sistem keamanan dan sesi terenkripsi."
        )
      }
    >
      <LoginForm next={next ?? undefined} verified={verified || reset || invited} />
      {reset ? (
        <p className="text-sm text-muted" style={{ textAlign: "center" }}>
          Kata sandi berhasil diubah. Yuk masuk pakai kata sandi baru kamu.
        </p>
      ) : null}
      {invited ? (
        <p className="text-sm text-muted" style={{ textAlign: "center" }}>
          Undangan berhasil diterima! Silakan masuk untuk mulai akses toko kamu.
        </p>
      ) : null}
    </AuthSplit>
  );
}
