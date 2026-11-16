import { describe, expect, it } from 'vitest';

import {
  amountsForCategory,
  computeDamageFee,
  computeDamageFeeForLines,
  parseDamagePolicy,
  serializeDamagePolicy,
  type DamageFeePolicy,
} from '../../src/returns/damage-fee.js';

const POLICY: DamageFeePolicy = {
  enabled: true,
  amounts: { MINOR: 25_000n, MODERATE: 100_000n, SEVERE: 400_000n },
};

describe('computeDamageFee', () => {
  it('menghasilkan usulan sesuai tingkat kondisi', () => {
    expect(computeDamageFee(POLICY, 'MINOR')).toMatchObject({
      enabled: true,
      severity: 'MINOR',
      label: 'Ringan',
      amount: '25000',
    });
    expect(computeDamageFee(POLICY, 'MODERATE').amount).toBe('100000');
    expect(computeDamageFee(POLICY, 'SEVERE').amount).toBe('400000');
  });

  it('tidak mengusulkan apa pun saat denda dinonaktifkan', () => {
    const view = computeDamageFee({ ...POLICY, enabled: false }, 'SEVERE');
    expect(view.enabled).toBe(false);
    expect(view.amount).toBeNull();
    // Nominal tersimpan tetap dikembalikan agar owner bisa menyalakan lagi.
    expect(view.amounts.SEVERE).toBe('400000');
  });

  it('tidak mengusulkan saat tingkat kondisi belum diisi', () => {
    expect(computeDamageFee(POLICY, null).amount).toBeNull();
    expect(computeDamageFee(POLICY, undefined).amount).toBeNull();
    expect(computeDamageFee(POLICY, null).label).toBeNull();
  });

  it('tingkat dengan nominal nol tidak menghasilkan usulan', () => {
    const view = computeDamageFee(
      { enabled: true, amounts: { MINOR: 0n, MODERATE: 50_000n, SEVERE: 0n } },
      'MINOR',
    );
    expect(view.amount).toBeNull();
    expect(view.severity).toBe('MINOR');
    expect(view.label).toBe('Ringan');
  });

  it('nominal besar dikembalikan sebagai string utuh', () => {
    const view = computeDamageFee(
      { enabled: true, amounts: { MINOR: 0n, MODERATE: 0n, SEVERE: 9_007_199_254_740_993n } },
      'SEVERE',
    );
    expect(view.amount).toBe('9007199254740993');
  });
});

describe('snapshot kebijakan denda kondisi', () => {
  it('bolak-balik serialize → parse mempertahankan nilai uang', () => {
    const snapshot = serializeDamagePolicy(POLICY);
    expect(snapshot).toEqual({
      enabled: true,
      amounts: { MINOR: '25000', MODERATE: '100000', SEVERE: '400000' },
    });
    const parsed = parseDamagePolicy(snapshot);
    expect(parsed.enabled).toBe(true);
    expect(parsed.amounts.SEVERE).toBe(400_000n);
  });

  it('snapshot lama tanpa field baru diperlakukan sebagai nonaktif', () => {
    for (const value of [null, undefined, {}, 'bukan-objek', 42]) {
      const parsed = parseDamagePolicy(value);
      expect(parsed.enabled).toBe(false);
      expect(parsed.amounts).toEqual({ MINOR: 0n, MODERATE: 0n, SEVERE: 0n });
    }
  });

  it('menyertakan plafon dan nominal kategori dalam snapshot', () => {
    const snapshot = serializeDamagePolicy({
      enabled: true,
      amounts: { MINOR: 1n, MODERATE: 2n, SEVERE: 3n },
      maxAmount: 500_000n,
      categories: { 'cat-1': { MINOR: 10n, MODERATE: 20n, SEVERE: 30n } },
    });
    expect(snapshot.maxAmount).toBe('500000');
    expect(snapshot.categories?.['cat-1'].SEVERE).toBe('30');

    const parsed = parseDamagePolicy(snapshot);
    expect(parsed.maxAmount).toBe(500_000n);
    expect(parsed.categories?.['cat-1'].MODERATE).toBe(20n);
    expect(amountsForCategory(parsed, 'cat-1').SEVERE).toBe(30n);
    expect(amountsForCategory(parsed, 'cat-lain').SEVERE).toBe(3n);
  });

  it('menormalkan nominal negatif dan tipe angka menjadi nol', () => {
    const parsed = parseDamagePolicy({
      enabled: 'true',
      amounts: { MINOR: -5000, MODERATE: 1500.9, SEVERE: '250000' },
    });
    // `enabled` non-boolean tidak dianggap aktif.
    expect(parsed.enabled).toBe(false);
    expect(parsed.amounts.MINOR).toBe(0n);
    expect(parsed.amounts.MODERATE).toBe(1500n);
    expect(parsed.amounts.SEVERE).toBe(250_000n);
  });
});

describe('plafon dan agregasi per item', () => {
  const BASE: DamageFeePolicy = {
    enabled: true,
    amounts: { MINOR: 25_000n, MODERATE: 100_000n, SEVERE: 400_000n },
    maxAmount: null,
  };

  it('memotong usulan di atas plafon dan menandainya capped', () => {
    const view = computeDamageFee({ ...BASE, maxAmount: 150_000n }, 'SEVERE');
    expect(view.amount).toBe('150000');
    expect(view.rawAmount).toBe('400000');
    expect(view.capped).toBe(true);
    expect(view.maxAmount).toBe('150000');
  });

  it('tidak menandai capped bila usulan di bawah plafon', () => {
    const view = computeDamageFee({ ...BASE, maxAmount: 500_000n }, 'SEVERE');
    expect(view.amount).toBe('400000');
    expect(view.rawAmount).toBe('400000');
    expect(view.capped).toBe(false);
  });

  it('menjumlahkan usulan per baris termasuk kuantitas', () => {
    const result = computeDamageFeeForLines(BASE, [
      { severity: 'SEVERE', quantity: 2 },
      { severity: 'MINOR', quantity: 1 },
    ]);
    expect(result.rawAmount).toBe('825000');
    expect(result.amount).toBe('825000');
    expect(result.capped).toBe(false);

    const capped = computeDamageFeeForLines({ ...BASE, maxAmount: 500_000n }, [
      { severity: 'SEVERE', quantity: 2 },
    ]);
    expect(capped.amount).toBe('500000');
    expect(capped.rawAmount).toBe('800000');
    expect(capped.capped).toBe(true);
  });

  it('memakai nominal efektif per baris (override kategori)', () => {
    const result = computeDamageFeeForLines(BASE, [
      { severity: 'SEVERE', quantity: 1, amounts: { MINOR: 0n, MODERATE: 0n, SEVERE: 50_000n } },
    ]);
    expect(result.amount).toBe('50000');
  });

  it('tanpa baris atau saklar mati tidak menghasilkan usulan', () => {
    expect(computeDamageFeeForLines(BASE, []).amount).toBeNull();
    expect(computeDamageFeeForLines({ ...BASE, enabled: false }, [
      { severity: 'SEVERE', quantity: 1 },
    ]).amount).toBeNull();
  });
});
