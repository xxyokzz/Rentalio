import type { Metadata } from "next";
import { TenantSettings } from "@/features/settings/tenant-settings";

export const metadata: Metadata = { title: "Pengaturan usaha" };

/**
 * Nomor dukungan adalah konfigurasi operasional, bukan aset build: halaman ini
 * dirender per request supaya `SUPPORT_WHATSAPP` dibaca dari environment saat
 * itu juga. Tanpa ini, halaman ikut diprerender saat build dan nomor baru
 * menuntut build ulang — persis masalah yang dihindari dengan menghapus
 * `NEXT_PUBLIC_SUPPORT_WHATSAPP`.
 */
export const dynamic = "force-dynamic";

export default function Page() {
  return <TenantSettings supportWhatsApp={process.env.SUPPORT_WHATSAPP ?? ""} />;
}
