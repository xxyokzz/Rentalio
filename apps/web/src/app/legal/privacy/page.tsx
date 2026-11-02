import type { Metadata } from "next";
import { PublicShell } from "@/shared/layout/public-shell";
import { PRIVACY_VERSION } from "@/shared/config/legal";

export const metadata: Metadata = { title: "Kebijakan Privasi" };

export default function PrivacyPage() {
  return (
    <PublicShell>
      <div className="public-main">
        <div className="panel">
          <div className="panel-body stack">
            <h1 className="page-title">Kebijakan Privasi</h1>
            <div className="inline-alert inline-alert-warning">
              Draf ini belum ditinjau tim hukum. Retensi audit (baseline 180 hari) dan data penyewa masih
              perlu ditinjau terhadap kewajiban hukum sebelum produksi. Persetujuan Anda tetap direkam
              backend: versi dokumen ini ({PRIVACY_VERSION}) dan waktu penerimaan disimpan pada akun
              Anda saat mendaftar.
            </div>
            <p className="text-sm text-muted">Versi dokumen: {PRIVACY_VERSION}</p>
            <p className="text-sm text-muted">
              Frontend tidak menyimpan OTP, password, token reset, atau session secret di localStorage,
              sessionStorage, analytics, maupun log. Data tenant dan pembayaran tidak disimpan pada cache
              offline umum; service worker hanya menyimpan aset statis yang ditinjau.
            </p>
          </div>
        </div>
      </div>
    </PublicShell>
  );
}
