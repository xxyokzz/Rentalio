import { extensionApi, type Schema } from "@/shared/api/endpoints";
import { subscribeExtensionActivity } from "@/shared/events/extension-activity";

type Overview = Schema<"ExtensionConflictOverview">;
export type ConflictOverviewFilter = "OPEN" | "RESOLVED" | "ALL";

/**
 * Cache singkat untuk `GET /tenants/{tenantId}/extension-conflicts`.
 *
 * Badge menu dan halaman konflik membaca endpoint yang sama; tanpa cache,
 * keduanya memicu satu request identik saat pengguna membuka `/app/conflicts`.
 * Cache ini:
 * - menyatukan request yang sedang berjalan (single-flight), jadi dua pemanggil
 *   bersamaan berbagi satu promise;
 * - menyimpan hasil selama TTL singkat (5 detik) agar remount/navigasi cepat
 *   tidak memicu request baru;
 * - membuang seluruh entri saat sinyal aktivitas perpanjangan dikirim, supaya
 *   reload setelah keputusan/penyelesaian tidak membaca data lama;
 * - tidak menyimpan kegagalan — percobaan berikutnya kembali ke server.
 *
 * Ini bukan cache data domain: tidak ada state bisnis di sisi klien, hanya
 * penghindaran request ganda dalam jendela waktu singkat.
 */
const TTL_MS = 5_000;

interface Entry {
  promise: Promise<Overview>;
  expiresAt: number;
}

const entries = new Map<string, Entry>();

function key(tenantId: string, status: ConflictOverviewFilter): string {
  return `${tenantId}:${status}`;
}

/** Buang cache; dipanggil otomatis setiap ada aktivitas perpanjangan. */
export function invalidateConflictOverview(): void {
  entries.clear();
}

// Registrasi saat modul dimuat (sebelum komponen mount) sehingga invalidasi
// berjalan lebih dulu daripada reload hook yang berlangganan sinyal yang sama.
subscribeExtensionActivity(invalidateConflictOverview);

export function loadConflictOverview(
  tenantId: string,
  status: ConflictOverviewFilter,
): Promise<Overview> {
  const cacheKey = key(tenantId, status);
  const now = Date.now();
  const existing = entries.get(cacheKey);
  if (existing && existing.expiresAt > now) return existing.promise;

  const promise = extensionApi.conflictOverview(tenantId, status).catch((error: unknown) => {
    // Kegagalan tidak boleh di-cache: pemanggil berikutnya harus mencoba lagi.
    entries.delete(cacheKey);
    throw error;
  });
  entries.set(cacheKey, { promise, expiresAt: now + TTL_MS });
  return promise;
}
