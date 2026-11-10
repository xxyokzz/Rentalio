import { describe, expect, it } from 'vitest';
import { isAllowedOrigin, isOriginPattern } from '../../src/config/origins.js';

describe('isAllowedOrigin', () => {
  const patterns = [
    'https://rentalio.my.id',
    'https://admin.rentalio.my.id',
    'https://*.rentalio.my.id',
  ];

  it('menerima origin yang terdaftar persis', () => {
    expect(isAllowedOrigin(patterns, 'https://rentalio.my.id')).toBe(true);
    expect(isAllowedOrigin(patterns, 'https://admin.rentalio.my.id')).toBe(true);
  });

  it('menerima subdomain tenant satu label dan menolak dua label', () => {
    expect(isAllowedOrigin(patterns, 'https://demo-sewa.rentalio.my.id')).toBe(true);
    expect(isAllowedOrigin(patterns, 'https://a.b.rentalio.my.id')).toBe(false);
  });

  it('menolak domain lain yang hanya mirip', () => {
    expect(isAllowedOrigin(patterns, 'https://rentalio.my.id.evil.test')).toBe(false);
    expect(isAllowedOrigin(patterns, 'https://evilrentalio.my.id')).toBe(false);
    expect(isAllowedOrigin(patterns, 'http://demo-sewa.rentalio.my.id')).toBe(false);
  });

  it('menolak origin dengan path, query, atau bentuk tidak valid', () => {
    expect(isAllowedOrigin(patterns, 'https://rentalio.my.id/')).toBe(false);
    expect(isAllowedOrigin(patterns, 'https://demo-sewa.rentalio.my.id/app')).toBe(false);
    expect(isAllowedOrigin(patterns, 'bukan-origin')).toBe(false);
  });

  it('menerima wildcard hanya pada label subdomain', () => {
    expect(isOriginPattern('https://*.rentalio.my.id')).toBe(true);
    expect(isOriginPattern('https://rentalio.my.id')).toBe(true);
    expect(isOriginPattern('https://*rentalio.my.id')).toBe(false);
    expect(isOriginPattern('rentalio.my.id')).toBe(false);
    expect(isOriginPattern('https://rentalio.my.id/path')).toBe(false);
  });
});
