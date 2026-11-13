import { describe, expect, it } from 'vitest';

import { computeLateFee } from '../../src/returns/late-fee.js';

const DUE = new Date('2026-11-03T00:00:00.000Z');
const at = (iso: string) => new Date(iso);

describe('computeLateFee', () => {
  it('tidak menghitung apa pun saat denda dinonaktifkan', () => {
    const view = computeLateFee(
      { enabled: false, unit: 'DAY', rateAmount: 50_000n },
      DUE,
      at('2026-11-09T00:00:00.000Z'),
    );

    expect(view.enabled).toBe(false);
    expect(view.units).toBe(0);
    expect(view.amount).toBe('0');
    expect(view.overdueMs).toBe(0);
    // Konfigurasi tetap dikembalikan agar UI bisa menampilkan tarif tersimpan.
    expect(view.rateAmount).toBe('50000');
    expect(view.unit).toBe('DAY');
  });

  it('mengembalikan nol saat barang kembali tepat waktu atau lebih awal', () => {
    const exact = computeLateFee({ enabled: true, unit: 'HOUR', rateAmount: 10_000n }, DUE, DUE);
    expect(exact.units).toBe(0);
    expect(exact.amount).toBe('0');
    expect(exact.overdueMs).toBe(0);

    const early = computeLateFee(
      { enabled: true, unit: 'HOUR', rateAmount: 10_000n },
      DUE,
      at('2026-11-02T20:00:00.000Z'),
    );
    expect(early.units).toBe(0);
    expect(early.amount).toBe('0');
  });

  it('membulatkan ke atas per hari', () => {
    // Telat 1 hari 1 menit tetap dihitung 2 hari.
    const view = computeLateFee(
      { enabled: true, unit: 'DAY', rateAmount: 50_000n },
      DUE,
      at('2026-11-04T00:01:00.000Z'),
    );

    expect(view.units).toBe(2);
    expect(view.amount).toBe('100000');
    expect(view.overdueMs).toBe(24 * 60 * 60 * 1000 + 60 * 1000);
  });

  it('membulatkan ke atas per jam dan mendukung tarif besar', () => {
    const view = computeLateFee(
      { enabled: true, unit: 'HOUR', rateAmount: 1_000_000n },
      DUE,
      at('2026-11-03T03:30:00.000Z'),
    );

    expect(view.units).toBe(4);
    expect(view.amount).toBe('4000000');
  });

  it('tidak menghitung sebelum barang diterima atau tanpa batas waktu', () => {
    const notReturned = computeLateFee(
      { enabled: true, unit: 'DAY', rateAmount: 50_000n },
      DUE,
      null,
    );
    expect(notReturned.units).toBe(0);
    expect(notReturned.amount).toBe('0');
    expect(notReturned.returnedAt).toBeNull();

    const noDueDate = computeLateFee(
      { enabled: true, unit: 'DAY', rateAmount: 50_000n },
      null,
      at('2026-11-09T00:00:00.000Z'),
    );
    expect(noDueDate.units).toBe(0);
    expect(noDueDate.amount).toBe('0');
    expect(noDueDate.dueAt).toBeNull();
  });

  it('tarif nol tidak pernah menghasilkan denda', () => {
    const view = computeLateFee(
      { enabled: true, unit: 'DAY', rateAmount: 0n },
      DUE,
      at('2026-11-09T00:00:00.000Z'),
    );
    expect(view.units).toBe(0);
    expect(view.amount).toBe('0');
  });
});
