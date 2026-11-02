/**
 * Email pendaftaran yang menunggu verifikasi OTP disimpan di memori modul,
 * bukan localStorage/sessionStorage/URL (Notion 09 — tidak ada data pribadi di
 * storage persisten). Reload halaman akan meminta pengguna kembali ke form
 * pendaftaran, yang aman karena backend tetap memegang state OTP sebenarnya.
 */
let pendingEmail: string | null = null;

export function setPendingEmail(email: string): void {
  pendingEmail = email;
}

export function getPendingEmail(): string | null {
  return pendingEmail;
}

export function clearPendingEmail(): void {
  pendingEmail = null;
}

/** Samarkan email untuk ditampilkan, mis. "bu***@contoh.com". */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "email terdaftar";
  const visible = local.slice(0, 2);
  return `${visible}${"*".repeat(Math.max(2, local.length - 2))}@${domain}`;
}
