import type { Metadata } from "next";
import { PublicShell } from "@/shared/layout/public-shell";
import { TERMS_VERSION } from "@/shared/config/legal";

export const metadata: Metadata = { title: "Syarat Layanan" };

export default function TermsPage() {
  return (
    <PublicShell>
      <div className="public-main">
        <div className="panel">
          <div className="panel-body stack">
            <h1 className="page-title">Syarat Layanan</h1>
            <div className="inline-alert inline-alert-warning">
              Draf ini belum ditinjau tim hukum; jangan gunakan halaman ini sebagai dasar kontrak
              final. Persetujuan Anda tetap direkam backend: versi dokumen ini ({TERMS_VERSION}) dan
              waktu penerimaan disimpan pada akun Anda saat mendaftar.
            </div>
            <p className="text-sm text-muted">Versi dokumen: {TERMS_VERSION}</p>
            <p className="text-sm text-muted">
              Poin yang perlu ditetapkan sebelum produksi: cakupan layanan, kewajiban tenant atas data
              penyewa, kebijakan pembatalan dan no-show, batas tanggung jawab, serta penanganan sengketa.
            </p>
          </div>
        </div>
      </div>
    </PublicShell>
  );
}
