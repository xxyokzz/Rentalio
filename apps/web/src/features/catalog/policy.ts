/**
 * Kebijakan katalog A/B (Notion 14 §A.6, Notion 16 §1).
 *
 * Satu policy tenant mengatur dua hal: perpanjangan sewa dan perilaku katalog
 * saat stok kosong. Untuk katalog:
 *
 * - Opsi A `CHECK_AVAILABILITY`: permintaan tetap boleh dikirim sebagai
 *   `PENDING_APPROVAL` tanpa alokasi, termasuk bila mode booking otomatis.
 * - Opsi B `SKIP_AVAILABILITY`: booking baru ditolak; katalog hanya menawarkan
 *   click-to-chat WhatsApp. Opsi B tidak pernah mengizinkan booking tanpa stok.
 *
 * Tenant tanpa policy tersimpan memakai baseline Opsi A.
 */

export type CatalogPolicy = "CHECK_AVAILABILITY" | "SKIP_AVAILABILITY";

export const DEFAULT_CATALOG_POLICY: CatalogPolicy = "CHECK_AVAILABILITY";

/** True bila permintaan stok kosong masih boleh diajukan (Opsi A). */
export function canRequestUnavailableStock(policy?: string | null): boolean {
  return policy !== "SKIP_AVAILABILITY";
}

/** True bila booking baru harus diblokir saat stok kosong (Opsi B). */
export function blocksUnavailableBooking(policy?: string | null): boolean {
  return policy === "SKIP_AVAILABILITY";
}
