/**
 * Redaksi data sensitif untuk log terstruktur (S0-05).
 *
 * Aturan (dokumen 10, keputusan final #15):
 * - Jangan pernah menulis token sesi, cookie, token CSRF, OTP, token reset,
 *   password, atau secret provider ke log.
 * - Redaksi dilakukan pada nama field DAN pada pola nilai, sehingga secret
 *   yang bocor di dalam string bebas (mis. header mentah) tetap tersamar.
 *
 * Modul ini murni (tanpa dependensi NestJS) agar mudah diuji.
 */

export const REDACTED = '[REDACTED]';

/** Normalisasi nama field: lowercase, tanpa pemisah. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Apakah nilai field dengan nama ini harus disamarkan?
 * `code` hanya disamarkan bila nilainya berbentuk OTP (4–8 digit), karena
 * `code` juga dipakai untuk kode error pada envelope API.
 */
function isSensitiveKey(key: string, value: unknown): boolean {
  const k = normalizeKey(key);
  if (k === 'code' || k === 'otp') {
    return k === 'otp' || /^\d{4,8}$/.test(String(value));
  }
  return (
    k.includes('token') ||
    k.includes('secret') ||
    k.includes('password') ||
    k.includes('passphrase') ||
    k.includes('cookie') ||
    k.includes('authorization') ||
    k.includes('apikey') ||
    k.includes('credential') ||
    k === 'csrf' ||
    k.endsWith('session') ||
    k.endsWith('sessionid')
  );
}

/** Pola nilai sensitif yang disamarkan di dalam string bebas. */
const VALUE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, `Bearer ${REDACTED}`],
  [/\b(rentalio_session=)[^;\s"']+/gi, `$1${REDACTED}`],
  [
    /([?&](?:token|csrf|csrfToken|otp|code|reset_token|resetToken)=)[^&\s"']+/gi,
    `$1${REDACTED}`,
  ],
  [
    /("(?:otp|code|token|csrfToken|resetToken|password|sessionToken)"\s*:\s*")(?:[^"\\]|\\.)*(")/gi,
    `$1${REDACTED}$2`,
  ],
];

/** Samarkan pola sensitif di dalam string. */
export function redactString(value: string): string {
  return VALUE_PATTERNS.reduce(
    (acc, [pattern, replacement]) => acc.replace(pattern, replacement),
    value,
  );
}

/**
 * Redaksi rekursif untuk nilai log.
 * Mengembalikan struktur baru; tidak memutasi input. Kedalaman dibatasi agar
 * objek request yang besar tidak membebani logger.
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
    };
  }
  if (depth >= 6) return '[MaxDepth]';
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry, depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key, entry)
      ? REDACTED
      : redact(entry, depth + 1, seen);
  }
  return out;
}
