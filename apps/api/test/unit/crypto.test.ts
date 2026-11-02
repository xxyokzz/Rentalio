import { describe, expect, it } from 'vitest';
import {
  constantTimeEqual,
  generateOtp,
  hashPassword,
  hmac,
  randomToken,
  verifyPassword,
} from '../../src/common/crypto.js';

describe('crypto', () => {
  it('hashPassword/verifyPassword roundtrip', () => {
    const hash = hashPassword('correct horse battery staple');
    expect(verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(verifyPassword('wrong password', hash)).toBe(false);
  });

  it('password hash tidak menyimpan plaintext', () => {
    const hash = hashPassword('rahasia-sekali');
    expect(hash).not.toContain('rahasia-sekali');
    expect(hash.startsWith('scrypt$')).toBe(true);
  });

  it('hash dua kali untuk password sama berbeda (salt acak)', () => {
    const a = hashPassword('password-identik');
    const b = hashPassword('password-identik');
    expect(a).not.toBe(b);
  });

  it('hmac deterministik dan berbeda untuk pepper berbeda', () => {
    expect(hmac('abc', 'pepper-1')).toBe(hmac('abc', 'pepper-1'));
    expect(hmac('abc', 'pepper-1')).not.toBe(hmac('abc', 'pepper-2'));
  });

  it('generateOtp selalu 6 digit', () => {
    for (let i = 0; i < 200; i++) {
      const otp = generateOtp();
      expect(otp).toMatch(/^\d{6}$/);
    }
  });

  it('randomToken berentropi (tidak duplikat, cukup panjang)', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => randomToken()));
    expect(tokens.size).toBe(100);
    for (const t of tokens) {
      expect(t.length).toBeGreaterThanOrEqual(43);
    }
  });

  it('constantTimeEqual', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });
});
