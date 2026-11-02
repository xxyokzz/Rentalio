import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LoginForm } from "@/features/auth/login-form";
import { getAdminSession } from "@/shared/api/server";

export const metadata: Metadata = { title: "Masuk" };
export const dynamic = "force-dynamic";

interface Search {
  expired?: string;
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<Search> }) {
  const session = await getAdminSession().catch(() => null);
  if (session) redirect("/tenants");

  const { expired } = await searchParams;

  return (
    <main className="auth-shell" id="main-content">
      <div className="auth-card">
        <div className="auth-card__brand">
          <span className="auth-card__mark" aria-hidden="true">
            R
          </span>
          <div>
            <p className="auth-card__eyebrow">Rentalio</p>
            <h1 className="auth-card__title">Admin Platform</h1>
          </div>
        </div>
        <p className="auth-card__sub">
          Masuk dengan akun operator. Verifikasi dua langkah dengan aplikasi authenticator wajib.
        </p>
        <LoginForm expired={Boolean(expired)} />
        <p className="auth-foot">
          Akses ke data tenant dicatat pada audit platform yang tidak dapat diubah.
        </p>
      </div>
    </main>
  );
}
