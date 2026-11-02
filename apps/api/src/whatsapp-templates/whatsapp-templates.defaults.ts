import { randomUUID } from 'node:crypto';
import type {
  PaymentContext,
  PaymentMethod,
  Prisma,
  WhatsAppTemplatePurpose,
} from '@rentalio/database';

export const TEMPLATE_CONTEXTS = ['NEW_BOOKING', 'ADD_UNIT', 'EXTENSION'] as const;
export const TEMPLATE_METHODS = ['CASH', 'BANK_TRANSFER', 'QRIS'] as const;
export const TEMPLATE_PURPOSES = ['PAYMENT_INSTRUCTION', 'PAYMENT_CONFIRMATION'] as const;

const CONTEXT_LABELS: Record<PaymentContext, string> = {
  NEW_BOOKING: 'Booking baru',
  ADD_UNIT: 'Tambah unit',
  EXTENSION: 'Perpanjangan sewa',
};

const METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: 'Cash',
  BANK_TRANSFER: 'Transfer Bank',
  QRIS: 'QRIS',
};

export const DEFAULT_PURPOSE: Record<PaymentMethod, WhatsAppTemplatePurpose> = {
  CASH: 'PAYMENT_INSTRUCTION',
  BANK_TRANSFER: 'PAYMENT_INSTRUCTION',
  QRIS: 'PAYMENT_CONFIRMATION',
};

export const DEFAULT_BODIES: Record<PaymentMethod, string> = {
  CASH: `Halo {{nama_penyewa}}, pembayaran {{jenis_transaksi}} sewa di {{nama_bisnis}} dilakukan secara tunai.

Nomor pesanan: {{nomor_pesanan}}
Barang sewa: {{daftar_barang}}
Periode: {{periode}}
Total tagihan: {{nominal_tagihan}}

Silakan serahkan pembayaran kepada petugas. Status pembayaran diperbarui setelah petugas menerima dan mencatat dana.`,
  BANK_TRANSFER: `Halo Admin {{nama_bisnis}}, saya ingin melakukan pembayaran {{jenis_transaksi}} sewa dengan transfer bank.

Nomor pesanan: {{nomor_pesanan}}
Nama penyewa: {{nama_penyewa}}
Barang sewa: {{daftar_barang}}
Periode: {{periode}}
Total tagihan: {{nominal_tagihan}}

Mohon informasikan nomor rekening dan petunjuk pembayaran yang harus saya gunakan.

Terima kasih.`,
  QRIS: `Halo Admin {{nama_bisnis}}, saya ingin mengonfirmasi pembayaran {{jenis_transaksi}} sewa melalui QRIS.

Nomor pesanan: {{nomor_pesanan}}
Nama penyewa: {{nama_penyewa}}
Barang sewa: {{daftar_barang}}
Periode: {{periode}}
Total pembayaran: {{nominal_tagihan}}
Waktu pembayaran: {{waktu_pembayaran}}

Mohon periksa dan catat setelah pembayaran terverifikasi.

Terima kasih.`,
};

/** Placeholder resmi; placeholder lain ditolak backend. */
export const ALLOWED_PLACEHOLDERS = [
  'nama_bisnis',
  'nama_penyewa',
  'nomor_pesanan',
  'daftar_barang',
  'periode',
  'nominal_tagihan',
  'jenis_transaksi',
  'waktu_pembayaran',
] as const;

export type TemplatePlaceholder = (typeof ALLOWED_PLACEHOLDERS)[number];

/** Nilai contoh untuk preview — tidak boleh menghasilkan `undefined`. */
export const SAMPLE_VALUES: Record<TemplatePlaceholder, string> = {
  nama_bisnis: 'Toko Sewa Contoh',
  nama_penyewa: 'Budi',
  nomor_pesanan: 'ORD-20261020-ABCD',
  daftar_barang: 'Kamera Sony A7 (1 unit)',
  periode: '1–3 November 2026',
  nominal_tagihan: 'Rp300.000',
  jenis_transaksi: 'booking baru',
  waktu_pembayaran: '20 Oktober 2026 10:00',
};

export function defaultTemplateKey(
  context: PaymentContext,
  method: PaymentMethod,
  purpose: WhatsAppTemplatePurpose,
): string {
  return `${context}_${method}_${purpose}`;
}

export function defaultTemplateName(context: PaymentContext, method: PaymentMethod): string {
  return `${CONTEXT_LABELS[context]} — ${METHOD_LABELS[method]}`;
}

export function getDefaultTemplate(
  context: PaymentContext,
  method: PaymentMethod,
  purpose: WhatsAppTemplatePurpose,
): { key: string; name: string; body: string } | null {
  if (DEFAULT_PURPOSE[method] !== purpose) return null;
  return {
    key: defaultTemplateKey(context, method, purpose),
    name: defaultTemplateName(context, method),
    body: DEFAULT_BODIES[method],
  };
}

/**
 * Seed 9 template bawaan untuk tenant baru. Dipanggil di transaksi pembuatan
 * tenant agar GET tidak perlu memutasi state. Tenant lama di-backfill oleh
 * migration 013.
 */
export async function createDefaultWhatsAppTemplates(
  tx: Prisma.TransactionClient,
  tenantId: string,
  actorUserId: string,
): Promise<void> {
  const templates = TEMPLATE_CONTEXTS.flatMap((context) =>
    TEMPLATE_METHODS.map((method) => {
      const purpose = DEFAULT_PURPOSE[method];
      return {
        id: randomUUID(),
        tenantId,
        context,
        paymentMethod: method,
        purpose,
        name: defaultTemplateName(context, method),
        body: DEFAULT_BODIES[method],
        isActive: true,
        isSystemDefault: true,
        defaultTemplateKey: defaultTemplateKey(context, method, purpose),
        currentVersion: 1,
        createdByUserId: actorUserId,
        updatedByUserId: actorUserId,
      };
    }),
  );

  await tx.whatsAppTemplate.createMany({ data: templates });
  await tx.whatsAppTemplateVersion.createMany({
    data: templates.map((template) => ({
      tenantId,
      templateId: template.id,
      version: 1,
      bodySnapshot: template.body,
      metadataSnapshot: { seeded: true },
      actorId: actorUserId,
      changeReason: 'SEED_DEFAULT',
    })),
  });
}
