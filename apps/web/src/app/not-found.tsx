import Link from "next/link";

export default function NotFound() {
  return (
    <div className="auth-shell">
      <div className="auth-card">
        <h1>Halaman tidak ditemukan</h1>
        <p className="auth-sub">
          Tautan mungkin salah, sudah kedaluwarsa, atau Anda tidak memiliki akses. Tidak ada data tenant
          lain yang ditampilkan di sini.
        </p>
        <div className="cluster">
          <Link className="btn btn-primary" href="/app">
            Buka aplikasi
          </Link>
          <Link className="btn" href="/">
            Halaman utama
          </Link>
        </div>
      </div>
    </div>
  );
}
