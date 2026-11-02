import { whatsappShareUrl } from "@/shared/whatsapp";

export interface SubscriptionRequestInput {
  tenantName?: string | null;
  tenantSlug?: string | null;
  /** Label status terakhir yang dilihat pengguna, mis. "Masa coba habis". */
  statusLabel?: string | null;
  /** Status efektif dari server (`tenant.subscription.status`). */
  subscriptionStatus?: string | null;
  restricted: boolean;
}

export interface SubscriptionRequestLink {
  href: string;
  label: string;
  message: string;
}

export function subscriptionRequestMessage(input: SubscriptionRequestInput): string {
  const identity = [input.tenantName, input.tenantSlug ? `(${input.tenantSlug})` : null]
    .filter(Boolean)
    .join(" ");
  const lines = [
    "Halo tim Rentalio, saya ingin memperpanjang langganan Rentalio.",
    identity ? `Toko: ${identity}` : null,
    input.statusLabel ? `Status langganan saat ini: ${input.statusLabel}` : null,
    "Mohon dibantu proses aktivasi paketnya ya. Terima kasih!",
  ];
  return lines.filter(Boolean).join("\n");
}

/**
 * Nomor WhatsApp tim Rentalio dikirim pemanggil dari konfigurasi server: halaman
 * `/app/settings` membaca `SUPPORT_WHATSAPP` saat request dirender.
 *
 * Dulu nomor dibaca dari `NEXT_PUBLIC_SUPPORT_WHATSAPP` sehingga nilainya
 * tertanam di bundle klien dan setiap penggantian nomor menuntut build ulang.
 * Nomor tidak di-hard-code: bila `whatsapp` kosong, tautan memakai pemilih
 * kontak WhatsApp — jangan mengarang nomor.
 */
export function subscriptionRequest(
  input: SubscriptionRequestInput,
  whatsapp: string,
): SubscriptionRequestLink {
  const message = subscriptionRequestMessage(input);
  const label = input.restricted
    ? "Ajukan aktivasi langganan"
    : input.subscriptionStatus === "TRIALING"
      ? "Upgrade ke paket langganan"
      : "Ajukan perpanjangan";
  return { href: whatsappShareUrl(message, whatsapp), label, message };
}
