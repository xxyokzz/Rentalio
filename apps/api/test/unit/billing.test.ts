import { describe, expect, it } from 'vitest';
import { nextSubscriptionPeriod } from '../../src/billing/subscription-period.js';
import { calculateCRC16, convertQRIS, parseQRIS, validateQRIS } from '../../src/billing/qris/index.js';

const DAY_MS = 24 * 3600 * 1000;

/** Rangkai satu elemen TLV sesuai EMVCo (tag 2 digit + panjang 2 digit). */
function tlv(tag: string, value: string): string {
  return `${tag}${value.length.toString().padStart(2, '0')}${value}`;
}

/** QRIS statis uji: merchant account + tag wajib, CRC dihitung library. */
function staticQris(merchantName = 'RENTALIO'): string {
  const body = [
    tlv('00', '01'),
    tlv('01', '11'),
    tlv('26', tlv('00', 'ID.CO.QRIS.WWW') + tlv('01', '9360000001')),
    tlv('52', '5812'),
    tlv('53', '360'),
    tlv('58', 'ID'),
    tlv('59', merchantName),
    tlv('60', 'JAKARTA'),
  ].join('');
  const withoutCrc = `${body}6304`;
  return withoutCrc + calculateCRC16(withoutCrc);
}

describe('nextSubscriptionPeriod', () => {
  const now = new Date('2026-03-01T00:00:00.000Z');

  it('memakai sekarang sebagai awal bila belum ada periode berjalan', () => {
    const period = nextSubscriptionPeriod(now, null, 30);
    expect(period.start.toISOString()).toBe(now.toISOString());
    expect(period.end.getTime() - period.start.getTime()).toBe(30 * DAY_MS);
  });

  it('memperpanjang dari akhir periode yang masih berlaku (tidak memotong sisa)', () => {
    const currentEnd = new Date('2026-03-20T00:00:00.000Z');
    const period = nextSubscriptionPeriod(now, currentEnd, 30);
    expect(period.start.toISOString()).toBe(currentEnd.toISOString());
    expect(period.end.toISOString()).toBe('2026-04-19T00:00:00.000Z');
  });

  it('memakai sekarang bila periode berjalan sudah lewat', () => {
    const past = new Date('2026-02-01T00:00:00.000Z');
    expect(nextSubscriptionPeriod(now, past, 7).start.toISOString()).toBe(now.toISOString());
  });
});

describe('QRIS dinamis (port qris-dinamis)', () => {
  it('QRIS statis uji lolos validasi struktur dan CRC', () => {
    const result = validateQRIS(staticQris());
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('konversi menyisipkan nominal, mengubah metode jadi dinamis, dan CRC tetap sah', () => {
    const dynamic = convertQRIS(staticQris(), { amount: 149_000 });

    expect(validateQRIS(dynamic).valid).toBe(true);
    const parsed = parseQRIS(dynamic);
    expect(parsed.method).toBe('dynamic');
    expect(parsed.amount).toBe('149000');
    expect(parsed.currency).toBe('360');
    expect(parsed.merchantName).toBe('RENTALIO');
    // Nominal disisipkan sebelum Country Code, sesuai urutan EMVCo.
    expect(dynamic.indexOf('5406149000')).toBeLessThan(dynamic.indexOf('5802ID'));
  });

  it('konversi dapat menyertakan biaya tetap dan persentase', () => {
    const fixed = parseQRIS(convertQRIS(staticQris(), { amount: 50_000, fee: { type: 'fixed', value: 1_500 } }));
    expect(fixed.tipIndicator).toBe('fixed');
    expect(fixed.tipFixed).toBe('1500');

    const percentage = parseQRIS(
      convertQRIS(staticQris(), { amount: 50_000, fee: { type: 'percentage', value: 2.5 } }),
    );
    expect(percentage.tipIndicator).toBe('percentage');
    expect(percentage.tipPercentage).toBe('2.5');
  });

  it('validasi menolak CRC yang salah dan tag wajib yang hilang', () => {
    const payload = staticQris();
    const brokenCrc = `${payload.slice(0, -4)}0000`;
    expect(validateQRIS(brokenCrc).valid).toBe(false);
    expect(validateQRIS(brokenCrc).errors.join(' ')).toContain('CRC');

    const withoutMerchantName = `${tlv('00', '01')}${tlv('01', '11')}${tlv('52', '5812')}${tlv(
      '53',
      '360',
    )}${tlv('58', 'ID')}${tlv('60', 'JAKARTA')}63040000`;
    const missing = validateQRIS(withoutMerchantName);
    expect(missing.valid).toBe(false);
    expect(missing.errors.join(' ')).toContain('59');
  });

  it('validasi menolak string kosong dan terlalu pendek', () => {
    expect(validateQRIS('').valid).toBe(false);
    expect(validateQRIS('000201').valid).toBe(false);
  });

  it('konversi menolak payload tanpa Country Code (tag 58)', () => {
    const body = [tlv('00', '01'), tlv('01', '11'), tlv('52', '5812'), tlv('53', '360')].join('');
    const withoutCrc = `${body}6304`;
    const payload = withoutCrc + calculateCRC16(withoutCrc);
    expect(() => convertQRIS(payload, { amount: 1000 })).toThrow(/Country Code/);
  });

  it('konversi menolak payload tanpa Point of Initiation Method (tag 01)', () => {
    const body = [
      tlv('00', '01'),
      tlv('52', '5812'),
      tlv('53', '360'),
      tlv('58', 'ID'),
      tlv('59', 'RENTALIO'),
      tlv('60', 'JAKARTA'),
    ].join('');
    const withoutCrc = `${body}6304`;
    const payload = withoutCrc + calculateCRC16(withoutCrc);
    expect(() => convertQRIS(payload, { amount: 1000 })).toThrow(/tag 01/);
  });

  it('CRC16 selalu empat digit heksadesimal huruf besar', () => {
    expect(calculateCRC16('000201')).toMatch(/^[0-9A-F]{4}$/);
  });
});
