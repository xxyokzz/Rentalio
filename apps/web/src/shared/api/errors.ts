import type { components } from "./types.generated";

export type ErrorCode = components["schemas"]["ErrorBody"]["error"]["code"];

/** Error ter-normalisasi untuk seluruh UI. Tidak pernah memuat stack trace. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: ErrorCode | "NETWORK_ERROR" | "TIMEOUT" | "UNEXPECTED_RESPONSE";
  readonly requestId: string | null;
  readonly details: unknown;
  readonly retryAfterSeconds: number | null;

  constructor(input: {
    status: number;
    code: ApiRequestError["code"];
    message: string;
    requestId?: string | null;
    details?: unknown;
    retryAfterSeconds?: number | null;
  }) {
    super(input.message);
    this.name = "ApiRequestError";
    this.status = input.status;
    this.code = input.code;
    this.requestId = input.requestId ?? null;
    this.details = input.details ?? null;
    this.retryAfterSeconds = input.retryAfterSeconds ?? null;
  }
}

export function isApiRequestError(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError;
}

export function isUnauthenticated(error: unknown): boolean {
  return (
    isApiRequestError(error) &&
    (error.status === 401 || error.code === "UNAUTHENTICATED")
  );
}

export function isForbidden(error: unknown): boolean {
  return (
    isApiRequestError(error) &&
    (error.status === 403 || error.code === "PERMISSION_DENIED")
  );
}

export function isNotFound(error: unknown): boolean {
  return isApiRequestError(error) && (error.status === 404 || error.code === "NOT_FOUND");
}

export function isConflict(error: unknown): boolean {
  return (
    isApiRequestError(error) &&
    (error.status === 409 ||
      error.code === "AVAILABILITY_CONFLICT" ||
      error.code === "INVALID_STATE_TRANSITION" ||
      error.code === "IDEMPOTENCY_KEY_REUSED")
  );
}

export function isValidationError(error: unknown): boolean {
  return (
    isApiRequestError(error) &&
    (error.status === 400 || error.status === 422 || error.code === "VALIDATION_ERROR" || error.code === "BUSINESS_RULE_VIOLATION")
  );
}

export function isRateLimited(error: unknown): boolean {
  return isApiRequestError(error) && (error.status === 429 || error.code === "RATE_LIMITED");
}

export function isRestrictedTenant(error: unknown): boolean {
  return isApiRequestError(error) && error.code === "TENANT_RESTRICTED";
}

/**
 * Pesan yang ditampilkan ke pengguna. Server sudah mengirim pesan bahasa
 * Indonesia yang aman; untuk kasus jaringan/timeout kita menambahkan langkah
 * berikutnya yang konkret. Jangan menampilkan payload mentah.
 */
export function describeApiError(error: unknown): string {
  if (!isApiRequestError(error)) {
    return "Terjadi kesalahan tak terduga. Coba lagi atau muat ulang halaman.";
  }

  if (error.code === "NETWORK_ERROR") {
    return "Tidak dapat terhubung ke server. Periksa koneksi, lalu muat ulang status sebelum mencoba lagi.";
  }

  if (error.code === "TIMEOUT") {
    return "Server tidak merespons tepat waktu. Periksa status transaksi di server sebelum mengirim ulang.";
  }

  if (error.code === "UNEXPECTED_RESPONSE") {
    return "Respons server tidak sesuai kontrak. Coba muat ulang; bila berulang, laporkan ke admin dengan ID permintaan.";
  }

  if (error.code === "TENANT_RESTRICTED") {
    return "Langganan tenant sedang dibatasi. Selesaikan langganan untuk membuat transaksi baru; pembacaan data dan penyelesaian order aktif tetap tersedia.";
  }

  if (error.code === "CSRF_VALIDATION_FAILED") {
    return "Token keamanan sesi tidak valid atau kedaluwarsa. Muat ulang halaman lalu coba lagi.";
  }

  if (isRateLimited(error)) {
    const wait = error.retryAfterSeconds;
    return wait
      ? `Terlalu banyak percobaan. Coba lagi dalam ${wait} detik.`
      : "Terlalu banyak percobaan. Tunggu sebentar lalu coba lagi.";
  }

  if (error.status === 403 && error.code !== "PERMISSION_DENIED") {
    return "Akses ditolak untuk tindakan ini.";
  }

  return error.message || "Permintaan gagal. Coba lagi.";
}

/** Detail konflik perpanjangan (409 AVAILABILITY_CONFLICT) dari server. */
export interface ConflictDetail {
  allocationId?: string;
  reservationId?: string | null;
  orderId?: string | null;
  orderNumber?: string | null;
  customerName?: string | null;
  productId?: string;
  productName?: string;
  assetId?: string | null;
  startAt?: string;
  endAt?: string;
  quantity?: number;
  reason?: "ASSET_OVERLAP" | "CAPACITY_EXCEEDED";
}

export function extractConflicts(error: unknown): ConflictDetail[] {
  if (!isApiRequestError(error) || !error.details) return [];
  const details = error.details as { conflicts?: unknown };
  const list = Array.isArray(details.conflicts)
    ? details.conflicts
    : Array.isArray(error.details)
      ? (error.details as unknown[])
      : [];
  return list.filter((item): item is ConflictDetail => typeof item === "object" && item !== null);
}
