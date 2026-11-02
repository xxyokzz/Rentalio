import type { Metadata } from "next";
import Link from "next/link";
import { PublicShell } from "@/shared/layout/public-shell";

export const metadata: Metadata = { title: "Offline" };

export default function OfflinePage() {
  return (
    <PublicShell>
      <div className="public-main">
        <div className="panel">
          <div className="panel-body stack">
            <h1 className="page-title">Anda sedang offline</h1>
            <p className="text-sm text-muted">
              Koneksi ke server terputus. Halaman ini tersedia dari cache aset statis; data tenant,
              pembayaran, dan transaksi tidak disimpan offline.
            </p>
            <ul className="text-sm" style={{ margin: 0, paddingLeft: "1.2rem" }}>
              <li>Booking, perubahan stok, pembayaran, dan pengembalian tidak dianggap berhasil tanpa konfirmasi server.</li>
              <li>Jika sebuah tindakan terputus di tengah proses, periksa status di server sebelum mencoba lagi.</li>
              <li>Jangan mengirim ulang transaksi tanpa perlindungan idempotensi dari server.</li>
            </ul>
            <div className="cluster">
              <Link className="btn btn-primary" href="/app">
                Coba muat ulang aplikasi
              </Link>
              <Link className="btn" href="/">
                Halaman utama
              </Link>
            </div>
          </div>
        </div>
      </div>
    </PublicShell>
  );
}
