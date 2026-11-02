import { randomBytes, createHash, createHmac, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Utilitas kriptografi untuk auth.
 * - Password: scrypt (node:crypto) — password hashing modern yang dipilih
 *   dan dikonfigurasi saat Sprint 0 (dokumen 03/10).
 * - OTP/token: HMAC-SHA256 dengan pepper server. Plaintext tidak pernah
 *   disimpan maupun dicatat ke log.
 */

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 } as const;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
  });
  return [
    'scrypt',
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString('base64'),
    hash.toString('base64'),
  ].join('$');
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, salt, expected.length, {
    N: Number(nStr),
    r: Number(rStr),
    p: Number(pStr),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** SHA-256 base64 — hash token berentropi tinggi (sesi, undangan, reset). */
export function hashToken(value: string): string {
  return createHash('sha256').update(value).digest('base64');
}

/** HMAC-SHA256 ber-key (pepper server). Dipakai untuk hash OTP/token sesi. */
export function hmac(value: string, pepper: string): string {
  return createHmac('sha256', pepper).update(value).digest('base64');
}

/** Token acak berentropi tinggi (256 bit) dalam base64url. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Kode OTP 6 digit sebagai string (kontrak: 6 digit string). */
export function generateOtp(): string {
  // randomBytes → modulo 1e6; bias negligible untuk OTP 6 digit & rate-limited.
  const n = randomBytes(4).readUInt32BE(0) % 1_000_000;
  return n.toString().padStart(6, '0');
}

export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
