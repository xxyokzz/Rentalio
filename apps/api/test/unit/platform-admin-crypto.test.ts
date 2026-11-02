import { describe, expect, it } from 'vitest';
import {
  TOTP_STEP_MS,
  decryptSecret,
  encryptSecret,
  generateTotpSecret,
  totpCodeForStep,
  totpProvisioningUri,
  verifyTotpStep,
} from '../../src/platform-admin/platform-admin.crypto.js';

/**
 * Secret uji dari RFC 6238 Lampiran B (ASCII "12345678901234567890") dalam
 * base32. Vektor resmi memakai 8 digit; implementasi kami 6 digit sehingga
 * nilai yang diharapkan adalah 6 digit terakhir dari vektor tersebut.
 */
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const KEY = Buffer.alloc(32, 9);

describe('TOTP Admin Platform', () => {
  it('cocok dengan vektor RFC 6238 (SHA-1, 30 detik)', () => {
    expect(totpCodeForStep(RFC_SECRET, 1)).toBe('287082'); // T=59
    expect(totpCodeForStep(RFC_SECRET, 37037036)).toBe('081804'); // T=1111111109
    expect(totpCodeForStep(RFC_SECRET, 37037037)).toBe('050471'); // T=1111111111
    expect(totpCodeForStep(RFC_SECRET, 41152263)).toBe('005924'); // T=1234567890
  });

  it('menerima kode pada jendela ±1 langkah', () => {
    const nowMs = 59_000;
    expect(verifyTotpStep(RFC_SECRET, '287082', nowMs, null)).toBe(1);
    // Satu langkah ke belakang masih diterima (toleransi clock skew 30 detik).
    expect(verifyTotpStep(RFC_SECRET, '287082', nowMs + TOTP_STEP_MS, null)).toBe(1);
  });

  it('menolak kode di luar jendela dan format salah', () => {
    const nowMs = 59_000;
    expect(verifyTotpStep(RFC_SECRET, '287082', nowMs + TOTP_STEP_MS * 5, null)).toBeNull();
    expect(verifyTotpStep(RFC_SECRET, 'abcdef', nowMs, null)).toBeNull();
    expect(verifyTotpStep(RFC_SECRET, '12345', nowMs, null)).toBeNull();
  });

  it('menolak pemakaian ulang langkah yang sudah dipakai (replay)', () => {
    const nowMs = 59_000;
    const step = verifyTotpStep(RFC_SECRET, '287082', nowMs, null);
    expect(step).toBe(1);
    expect(verifyTotpStep(RFC_SECRET, '287082', nowMs, BigInt(step!))).toBeNull();
  });

  it('secret yang dihasilkan base32 valid dan dapat dipakai', () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(secret.length).toBe(32); // 20 byte → 160 bit → 32 karakter
    const step = Math.floor(Date.now() / TOTP_STEP_MS);
    expect(verifyTotpStep(secret, totpCodeForStep(secret, step), Date.now(), null)).toBe(step);
  });

  it('provisioning URI memuat issuer, algoritma, dan secret', () => {
    const uri = totpProvisioningUri('admin@rentalio.my.id', RFC_SECRET);
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain('issuer=Rentalio%20Admin%20Platform');
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain('digits=6');
    expect(uri).toContain(`secret=${RFC_SECRET}`);
  });
});

describe('enkripsi secret TOTP', () => {
  it('roundtrip dan tidak menyimpan plaintext', () => {
    const encrypted = encryptSecret(KEY, RFC_SECRET);
    expect(encrypted.startsWith('v1.')).toBe(true);
    expect(encrypted).not.toContain(RFC_SECRET);
    expect(decryptSecret(KEY, encrypted)).toBe(RFC_SECRET);
  });

  it('menghasilkan ciphertext berbeda untuk plaintext sama (IV acak)', () => {
    expect(encryptSecret(KEY, RFC_SECRET)).not.toBe(encryptSecret(KEY, RFC_SECRET));
  });

  it('menolak ciphertext yang diubah (auth tag GCM)', () => {
    const encrypted = encryptSecret(KEY, RFC_SECRET);
    const parts = encrypted.split('.');
    const tampered = [...parts.slice(0, 3), Buffer.from('lain').toString('base64url')].join('.');
    expect(() => decryptSecret(KEY, tampered)).toThrow();
  });

  it('menolak kunci dengan panjang salah', () => {
    expect(() => encryptSecret(Buffer.alloc(16), 'x')).toThrow(/32 byte/);
  });
});
