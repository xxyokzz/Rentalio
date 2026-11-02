import { describe, expect, it } from 'vitest';
import { ConfigError, validateConfig } from '../../src/config/env.validation.js';

const base = {
  DATABASE_URL: 'postgresql://user@localhost:5432/db',
  HMAC_PEPPER: 'x'.repeat(40),
};

/** Kunci 32 byte (base64) — nilai test, bukan secret nyata. */
const ADMIN_KEY = Buffer.alloc(32, 3).toString('base64');

describe('validateConfig', () => {
  it('valid dengan default wajar', () => {
    const cfg = validateConfig({ ...base });
    expect(cfg.NODE_ENV).toBe('development');
    expect(cfg.PORT).toBe(3000);
    expect(cfg.COOKIE_SECURE).toBe(false);
    expect(cfg.CORS_ORIGINS).toEqual(['http://localhost:3001']);
  });

  it('gagal bila DATABASE_URL hilang — tanpa membocorkan nilai', () => {
    expect(() => validateConfig({ HMAC_PEPPER: base.HMAC_PEPPER })).toThrow(ConfigError);
    try {
      validateConfig({ HMAC_PEPPER: base.HMAC_PEPPER });
    } catch (e) {
      expect((e as Error).message).toContain('DATABASE_URL');
      expect((e as Error).message).not.toContain(base.HMAC_PEPPER);
    }
  });

  it('gagal bila HMAC_PEPPER terlalu pendek', () => {
    expect(() => validateConfig({ ...base, HMAC_PEPPER: 'abc' })).toThrow(
      /HMAC_PEPPER/,
    );
  });

  it('gagal bila PORT bukan integer valid', () => {
    expect(() => validateConfig({ ...base, PORT: '99999' })).toThrow(/PORT/);
  });

  it('dev-file dilarang di production', () => {
    expect(() =>
      validateConfig({
        ...base,
        NODE_ENV: 'production',
        EMAIL_PROVIDER: 'dev-file',
        PLATFORM_ADMIN_ENCRYPTION_KEY: ADMIN_KEY,
      }),
    ).toThrow(/dev-file/);
  });

  it('COOKIE_SECURE default true di production', () => {
    const cfg = validateConfig({
      ...base,
      NODE_ENV: 'production',
      EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 're_dummy_key',
      PLATFORM_ADMIN_ENCRYPTION_KEY: ADMIN_KEY,
      PLATFORM_ADMIN_BASE_URL: 'https://admin.rentalio.my.id',
    });
    expect(cfg.COOKIE_SECURE).toBe(true);
  });

  it('production mewajibkan kunci enkripsi Admin Platform', () => {
    expect(() =>
      validateConfig({
        ...base,
        NODE_ENV: 'production',
        EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 're_dummy_key',
        PLATFORM_ADMIN_BASE_URL: 'https://admin.rentalio.my.id',
      }),
    ).toThrow(/PLATFORM_ADMIN_ENCRYPTION_KEY/);
  });

  it('kunci enkripsi Admin Platform harus 32 byte', () => {
    expect(() =>
      validateConfig({
        ...base,
        PLATFORM_ADMIN_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString('base64'),
      }),
    ).toThrow(/PLATFORM_ADMIN_ENCRYPTION_KEY/);
  });

  it('PLATFORM_ADMIN_BASE_URL harus origin tanpa path', () => {
    expect(() =>
      validateConfig({ ...base, PLATFORM_ADMIN_BASE_URL: 'https://admin.example.com/app' }),
    ).toThrow(/PLATFORM_ADMIN_BASE_URL/);
    expect(() =>
      validateConfig({ ...base, PLATFORM_ADMIN_BASE_URL: 'bukan-url' }),
    ).toThrow(/PLATFORM_ADMIN_BASE_URL/);
  });

  it('PLATFORM_ADMIN_BASE_URL wajib HTTPS di production', () => {
    expect(() =>
      validateConfig({
        ...base,
        NODE_ENV: 'production',
        EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 're_dummy_key',
        PLATFORM_ADMIN_ENCRYPTION_KEY: ADMIN_KEY,
        PLATFORM_ADMIN_BASE_URL: 'http://admin.example.com',
      }),
    ).toThrow(/HTTPS/);
  });

  it('in-memory dilarang di production', () => {
    expect(() =>
      validateConfig({
        ...base,
        NODE_ENV: 'production',
        EMAIL_PROVIDER: 'in-memory',
        PLATFORM_ADMIN_ENCRYPTION_KEY: ADMIN_KEY,
      }),
    ).toThrow(/production/);
  });

  it('resend tanpa RESEND_API_KEY gagal', () => {
    expect(() => validateConfig({ ...base, EMAIL_PROVIDER: 'resend' })).toThrow(
      /RESEND_API_KEY/,
    );
  });

  it('resend dengan API key valid dan EMAIL_FROM default', () => {
    const cfg = validateConfig({
      ...base,
      EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 're_dummy_key',
    });
    expect(cfg.EMAIL_PROVIDER).toBe('resend');
    expect(cfg.EMAIL_FROM).toBe('Rentalio <onboarding@resend.dev>');
  });

  it('EMAIL_FROM tidak valid ditolak', () => {
    expect(() =>
      validateConfig({ ...base, EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 'k', EMAIL_FROM: 'bukan-email' }),
    ).toThrow(/EMAIL_FROM/);
  });

  it('production tanpa EMAIL_PROVIDER gagal (dev-file tidak boleh tersirat)', () => {
    expect(() =>
      validateConfig({
        ...base,
        NODE_ENV: 'production',
        PLATFORM_ADMIN_ENCRYPTION_KEY: ADMIN_KEY,
      }),
    ).toThrow(/EMAIL_PROVIDER/);
  });
});
