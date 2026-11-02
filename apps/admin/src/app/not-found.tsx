import Link from "next/link";

export default function NotFound() {
  return (
    <main className="auth-shell" id="main-content">
      <div className="auth-card">
        <p className="auth-card__eyebrow">404</p>
        <h1 className="auth-card__title">Halaman tidak ditemukan</h1>
        <p className="auth-card__sub">
          Alamat ini bukan bagian dari konsol Admin Platform. Periksa tautan atau kembali ke
          direktori tenant.
        </p>
        <Link className="btn btn--primary" href="/tenants">
          Kembali ke direktori tenant
        </Link>
      </div>
    </main>
  );
}
