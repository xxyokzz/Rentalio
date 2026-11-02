/**
 * WhatsApp click-to-chat: sistem hanya menyiapkan teks, pengguna tetap harus
 * menekan Kirim. Tidak ada pengiriman otomatis dan tidak ada verifikasi
 * pembayaran otomatis (Notion 09/14).
 *
 * Nomor WhatsApp bisnis tenant belum tersedia pada kontrak OpenAPI saat ini,
 * sehingga helper ini membuka pemilih kontak WhatsApp tanpa nomor tujuan.
 * Jangan mengarang nomor.
 */
export function whatsappShareUrl(body: string | null | undefined, phone?: string | null): string {
  const text = encodeURIComponent(body ?? "");
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits ? `https://wa.me/${digits}?text=${text}` : `https://wa.me/?text=${text}`;
}

export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
