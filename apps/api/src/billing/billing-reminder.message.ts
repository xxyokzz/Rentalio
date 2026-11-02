/**
 * Penyusun email pengingat tagihan langganan untuk operator platform.
 *
 * Fungsi murni (tanpa I/O) supaya isi pesan dapat diuji tanpa database maupun
 * provider email. Pesan sengaja memuat data operasional minimum:
 * identitas tenant, nominal, batas waktu, dan id tagihan. Payload QRIS tidak
 * pernah disertakan — operator tidak perlu memindainya, dan payload adalah data
 * pembayaran milik tenant.
 */

export type ReminderKind = 'FIRST' | 'EXPIRING';

export interface ReminderInput {
  kind: ReminderKind;
  tenantName: string;
  tenantSlug: string;
  invoiceId: string;
  /** Nilai tagihan dalam rupiah utuh. */
  amount: number;
  expiresAt: Date;
}

export interface ReminderMessage {
  subject: string;
  body: string;
}

const idr = new Intl.NumberFormat('id-ID', {
  style: 'currency',
  currency: 'IDR',
  maximumFractionDigits: 0,
  minimumFractionDigits: 0,
});

const wib = new Intl.DateTimeFormat('id-ID', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Jakarta',
});

function formatAmount(amount: number): string {
  return idr.format(amount).replace(/\u00a0/g, ' ');
}

export function composeOperatorReminder(input: ReminderInput): ReminderMessage {
  const amount = formatAmount(input.amount);
  const expires = `${wib.format(input.expiresAt)} WIB`;
  const subject =
    input.kind === 'FIRST'
      ? `[Rentalio] Menunggu verifikasi: ${input.tenantName} — ${amount}`
      : `[Rentalio] Tagihan segera kedaluwarsa: ${input.tenantName} — ${amount}`;

  const opening =
    input.kind === 'FIRST'
      ? `Ada pembayaran langganan yang belum diverifikasi.`
      : `Tagihan langganan di bawah ini mendekati batas waktu pembayaran.`;

  const body = [
    opening,
    '',
    `Tenant        : ${input.tenantName} (${input.tenantSlug})`,
    `Nominal       : ${amount}`,
    `Batas bayar   : ${expires}`,
    `ID tagihan    : ${input.invoiceId}`,
    '',
    'Langkah verifikasi:',
    '1. Periksa mutasi rekening/e-wallet merchant Rentalio untuk nominal di atas',
    '   pada rentang waktu setelah tagihan dibuat.',
    '2. Buka Admin Platform → tenant tersebut → Tandai tagihan lunas.',
    '3. Isi referensi pembayaran (id mutasi/berita transfer) sebagai alasan.',
    '',
    'Penting: jangan menandai lunas sebelum dana benar-benar masuk. Tindakan itu',
    'langsung memperpanjang langganan tenant dan tercatat di audit.',
    '',
    'Pesan otomatis dari proses worker Rentalio.',
  ].join('\n');

  return { subject, body };
}
