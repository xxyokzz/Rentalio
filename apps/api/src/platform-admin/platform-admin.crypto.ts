import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Primitif kriptografi khusus Admin Platform.
 *
 * Dipisahkan dari `platform-admin.service.ts` supaya dapat diuji tanpa
 * database. Kontrak:
 * - TOTP RFC 6238, SHA-1, 6 digit, periode 30 detik (kompatibel Google
 *   Authenticator/Authy/1Password).
 * - Secret TOTP tidak pernah disimpan plaintext: AES-256-GCM dengan key
 *   khusus `PLATFORM_ADMIN_ENCRYPTION_KEY` (terpisah dari HMAC pepper).
 * - Perbandingan kode memakai `timingSafeEqual`.
 */

export const TOTP_STEP_MS = 30_000;
export const TOTP_DIGITS = 6;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Secret acak 160 bit dalam base32 (20 byte, ukuran yang disarankan RFC 4226). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** Kode TOTP untuk satu langkah waktu (step) tertentu. */
export function totpCodeForStep(secret: string, step: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', base32Decode(secret)).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 1_000_000).padStart(TOTP_DIGITS, '0');
}

/**
 * Verifikasi kode terhadap jendela `±window` langkah.
 *
 * Mengembalikan langkah waktu yang cocok, atau `null`. Langkah yang lebih
 * kecil/sama dengan `lastAcceptedStep` selalu ditolak sehingga satu kode tidak
 * dapat dipakai dua kali (replay) meski masih berada di jendela toleransi.
 */
export function verifyTotpStep(
  secret: string,
  code: string,
  nowMs: number,
  lastAcceptedStep: bigint | null,
  window = 1,
): number | null {
  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(code)) return null;
  const current = Math.floor(nowMs / TOTP_STEP_MS);
  const presented = Buffer.from(code);
  for (let offset = -window; offset <= window; offset += 1) {
    const step = current + offset;
    if (step < 0) continue;
    if (lastAcceptedStep !== null && BigInt(step) <= lastAcceptedStep) continue;
    const expected = Buffer.from(totpCodeForStep(secret, step));
    if (expected.length === presented.length && timingSafeEqual(expected, presented)) {
      return step;
    }
  }
  return null;
}

/** Enkripsi secret TOTP: `v1.<iv>.<tag>.<ciphertext>`, seluruhnya base64url. */
export function encryptSecret(key: Buffer, plaintext: string): string {
  assertKey(key);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export function decryptSecret(key: Buffer, encoded: string): string {
  assertKey(key);
  const [version, ivText, tagText, ciphertextText] = encoded.split('.');
  if (version !== 'v1' || !ivText || !tagText || !ciphertextText) {
    throw new Error('Format secret TOTP terenkripsi tidak valid.');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/** URI `otpauth://` untuk ditampilkan sebagai QR code saat enrollment. */
export function totpProvisioningUri(email: string, secret: string): string {
  const issuer = encodeURIComponent('Rentalio Admin Platform');
  const label = encodeURIComponent(`Rentalio Admin Platform:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=30`;
}

function assertKey(key: Buffer): void {
  if (key.length !== 32) {
    throw new Error('Kunci enkripsi Admin Platform harus 32 byte (AES-256).');
  }
}

function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(value: string): Buffer {
  let bits = 0;
  let acc = 0;
  const output: number[] = [];
  for (const char of value.toUpperCase().replace(/=+$/, '')) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error('Secret TOTP bukan base32 yang valid.');
    acc = (acc << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((acc >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}
