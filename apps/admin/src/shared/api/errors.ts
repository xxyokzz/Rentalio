/**
 * Pesan error yang aman ditampilkan ke operator.
 *
 * Server sudah mengirim pesan bahasa Indonesia; di sini hanya kasus yang butuh
 * langkah lanjutan (CSRF kedaluwarsa, rate limit, konflik status) yang
 * diterjemahkan, plus fallback untuk kegagalan jaringan.
 */
export interface ApiFailure {
  status: number;
  code: string;
  message: string;
  retryAfterSeconds?: number | null;
}

export function describeApiError(failure: ApiFailure): string {
  if (failure.status === 0 || failure.code === "NETWORK_ERROR") {
    return "Tidak dapat terhubung ke API. Pastikan backend berjalan, lalu coba lagi.";
  }
  if (failure.code === "CSRF_VALIDATION_FAILED") {
    return "Token keamanan sesi tidak valid atau kedaluwarsa. Muat ulang halaman lalu coba lagi.";
  }
  if (failure.code === "RATE_LIMITED") {
    return failure.retryAfterSeconds
      ? `Terlalu banyak percobaan. Coba lagi dalam ${failure.retryAfterSeconds} detik.`
      : "Terlalu banyak percobaan. Tunggu sebentar lalu coba lagi.";
  }
  if (failure.code === "MFA_INVALID_OR_EXPIRED") {
    return "Kode MFA atau kode pemulihan tidak valid, sudah dipakai, atau sudah kedaluwarsa.";
  }
  if (failure.code === "INVALID_CREDENTIALS") {
    return "Email atau password salah.";
  }
  if (failure.code === "REAUTHENTICATION_REQUIRED") {
    return "Sesi perlu diverifikasi ulang sebelum tindakan ini. Masukkan password dan kode MFA.";
  }
  if (failure.code === "PERMISSION_DENIED") {
    return "Role Anda tidak memiliki izin untuk tindakan ini.";
  }
  if (failure.code === "INVALID_STATE_TRANSITION") {
    return failure.message || "Status saat ini tidak mengizinkan tindakan tersebut.";
  }
  if (failure.code === "BUSINESS_RULE_VIOLATION") {
    return failure.message || "Tindakan ini melanggar aturan platform.";
  }
  if (failure.code === "NOT_FOUND") {
    return failure.message || "Data tidak ditemukan.";
  }
  if (failure.code === "UNAUTHENTICATED") {
    return "Sesi admin tidak aktif. Masuk kembali.";
  }
  return failure.message || "Permintaan gagal. Coba lagi.";
}
