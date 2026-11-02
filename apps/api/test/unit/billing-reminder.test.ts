import { describe, expect, it } from 'vitest';
import { composeOperatorReminder } from '../../src/billing/billing-reminder.message.js';

const base = {
  tenantName: 'Rental Kamera Bandung',
  tenantSlug: 'rental-kamera-bandung',
  invoiceId: '6f1c2a9e-0000-4000-8000-1234567890ab',
  amount: 149_000,
  expiresAt: new Date('2026-11-02T10:00:00.000Z'),
};

describe('composeOperatorReminder', () => {
  it('pengingat pertama memuat identitas tenant, nominal, batas waktu, dan id tagihan', () => {
    const message = composeOperatorReminder({ ...base, kind: 'FIRST' });

    expect(message.subject).toContain('Menunggu verifikasi');
    expect(message.subject).toContain('Rental Kamera Bandung');
    expect(message.subject).toContain('Rp');
    expect(message.body).toContain('Rental Kamera Bandung (rental-kamera-bandung)');
    expect(message.body).toContain('Rp 149.000');
    expect(message.body).toContain(base.invoiceId);
    // Batas waktu disajikan dalam WIB (bukan UTC mentah).
    expect(message.body).toContain('WIB');
    expect(message.body).toMatch(/17[.:]00/);
  });

  it('pengingat kedaluwarsa memakai subjek berbeda tetapi langkah verifikasi sama', () => {
    const first = composeOperatorReminder({ ...base, kind: 'FIRST' });
    const expiring = composeOperatorReminder({ ...base, kind: 'EXPIRING' });

    expect(expiring.subject).toContain('segera kedaluwarsa');
    expect(expiring.subject).not.toBe(first.subject);
    expect(expiring.body).toContain('mendekati batas waktu');
    expect(expiring.body).toContain('Tandai tagihan lunas');
  });

  it('tidak pernah menyarankan menandai lunas sebelum dana terverifikasi', () => {
    const message = composeOperatorReminder({ ...base, kind: 'FIRST' });
    expect(message.body).toContain('jangan menandai lunas sebelum dana benar-benar masuk');
  });

  it('tidak memuat payload QRIS atau data rahasia lain', () => {
    const message = composeOperatorReminder({ ...base, kind: 'FIRST' });
    const serialized = `${message.subject}\n${message.body}`;
    expect(serialized).not.toContain('000201');
    expect(serialized.toLowerCase()).not.toContain('qrpayload');
  });
});
