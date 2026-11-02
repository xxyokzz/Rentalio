/**
 * Label status terpusat. Status booking, alokasi/lifecycle, pembayaran,
 * refund, deposit, dan langganan adalah hal berbeda dan harus ditampilkan
 * terpisah dengan label konsisten (Notion 09/14). Jangan mengandalkan warna
 * saja: setiap badge membawa teks.
 */
export type Tone = "neutral" | "success" | "warning" | "danger" | "info";

export interface StatusDescriptor {
  label: string;
  tone: Tone;
}

const RESERVATION: Record<string, StatusDescriptor> = {
  PENDING_APPROVAL: { label: "Menunggu persetujuan", tone: "warning" },
  CONFIRMED: { label: "Terkonfirmasi", tone: "success" },
  REJECTED: { label: "Ditolak", tone: "danger" },
  CANCELLED: { label: "Dibatalkan", tone: "danger" },
  EXPIRED: { label: "Kedaluwarsa", tone: "neutral" },
  CONVERTED_TO_ORDER: { label: "Menjadi pesanan", tone: "info" },
};

const ORDER: Record<string, StatusDescriptor> = {
  CONFIRMED: { label: "Terkonfirmasi", tone: "info" },
  READY_FOR_HANDOVER: { label: "Siap serah-terima", tone: "warning" },
  ACTIVE: { label: "Sedang disewa", tone: "success" },
  RETURN_IN_PROGRESS: { label: "Proses pengembalian", tone: "warning" },
  COMPLETED: { label: "Selesai", tone: "success" },
  CANCELLED: { label: "Dibatalkan", tone: "danger" },
};

const PAYMENT: Record<string, StatusDescriptor> = {
  RECORDED: { label: "Tercatat", tone: "success" },
  VOIDED: { label: "Dibatalkan (void)", tone: "danger" },
  NONE: { label: "Belum ada pembayaran", tone: "neutral" },
};

const REFUND: Record<string, StatusDescriptor> = {
  REQUESTED: { label: "Diajukan", tone: "warning" },
  APPROVED: { label: "Disetujui", tone: "info" },
  PROCESSING: { label: "Diproses", tone: "info" },
  SUCCEEDED: { label: "Berhasil", tone: "success" },
  FAILED: { label: "Gagal", tone: "danger" },
  CANCELLED: { label: "Dibatalkan", tone: "neutral" },
};

const RETURN: Record<string, StatusDescriptor> = {
  PENDING: { label: "Menunggu penyelesaian", tone: "warning" },
  COMPLETED: { label: "Selesai", tone: "success" },
  CANCELLED: { label: "Dibatalkan", tone: "neutral" },
};

const INSPECTION: Record<string, StatusDescriptor> = {
  DRAFT: { label: "Draf", tone: "neutral" },
  SUBMITTED: { label: "Diajukan", tone: "warning" },
  APPROVED: { label: "Disetujui", tone: "success" },
  REJECTED: { label: "Ditolak", tone: "danger" },
};

const EXTENSION: Record<string, StatusDescriptor> = {
  PENDING_APPROVAL: { label: "Menunggu persetujuan", tone: "warning" },
  APPROVED: { label: "Disetujui", tone: "success" },
  REJECTED: { label: "Ditolak", tone: "danger" },
};

const DEPOSIT_MOVEMENT: Record<string, StatusDescriptor> = {
  RECEIPT: { label: "Penerimaan", tone: "success" },
  DEDUCTION: { label: "Potongan", tone: "warning" },
  REFUND: { label: "Pengembalian", tone: "info" },
  REVERSAL: { label: "Pembalikan", tone: "neutral" },
};

const DEPOSIT_REQUEST: Record<string, StatusDescriptor> = {
  PENDING: { label: "Menunggu persetujuan", tone: "warning" },
  APPROVED: { label: "Disetujui", tone: "success" },
  REJECTED: { label: "Ditolak", tone: "danger" },
};

const COLLATERAL_STATUS: Record<string, StatusDescriptor> = {
  HELD: { label: "Masih dipegang", tone: "warning" },
  RETURNED: { label: "Sudah dikembalikan", tone: "success" },
};

const COLLATERAL_TYPE: Record<string, StatusDescriptor> = {
  ID_CARD: { label: "ID card penyewa", tone: "info" },
  OTHER: { label: "Jaminan lain", tone: "neutral" },
};

const ASSET: Record<string, StatusDescriptor> = {
  AVAILABLE: { label: "Tersedia", tone: "success" },
  RESERVED: { label: "Dipesan", tone: "warning" },
  MAINTENANCE: { label: "Maintenance", tone: "info" },
  DAMAGED: { label: "Rusak", tone: "danger" },
  RETIRED: { label: "Pensiun", tone: "neutral" },
};

const TENANT: Record<string, StatusDescriptor> = {
  PENDING_ACTIVATION: { label: "Belum aktif", tone: "warning" },
  ACTIVE: { label: "Aktif", tone: "success" },
  SUSPENDED: { label: "Ditangguhkan", tone: "danger" },
  CLOSED: { label: "Ditutup", tone: "neutral" },
};

const CONTEXT: Record<string, StatusDescriptor> = {
  NEW_BOOKING: { label: "Booking baru", tone: "info" },
  ADD_UNIT: { label: "Tambah unit", tone: "neutral" },
  EXTENSION: { label: "Perpanjangan", tone: "warning" },
};

const METHOD: Record<string, StatusDescriptor> = {
  CASH: { label: "Tunai", tone: "neutral" },
  BANK_TRANSFER: { label: "Transfer bank", tone: "info" },
  QRIS: { label: "QRIS", tone: "info" },
};

const PURPOSE: Record<string, StatusDescriptor> = {
  PAYMENT_INSTRUCTION: { label: "Instruksi pembayaran", tone: "info" },
  PAYMENT_CONFIRMATION: { label: "Konfirmasi pembayaran", tone: "success" },
};

const UNKNOWN: StatusDescriptor = { label: "Tidak diketahui", tone: "neutral" };

function pick(map: Record<string, StatusDescriptor>, key: string | null | undefined): StatusDescriptor {
  if (!key) return UNKNOWN;
  return map[key] ?? { label: key, tone: "neutral" };
}

export const reservationStatus = (key?: string | null) => pick(RESERVATION, key);
export const orderStatus = (key?: string | null) => pick(ORDER, key);
export const paymentStatus = (key?: string | null) => pick(PAYMENT, key);
export const refundStatus = (key?: string | null) => pick(REFUND, key);
export const returnStatus = (key?: string | null) => pick(RETURN, key);
export const inspectionStatus = (key?: string | null) => pick(INSPECTION, key);
export const extensionStatus = (key?: string | null) => pick(EXTENSION, key);
export const depositMovementStatus = (key?: string | null) => pick(DEPOSIT_MOVEMENT, key);
export const depositRequestStatus = (key?: string | null) => pick(DEPOSIT_REQUEST, key);
export const collateralStatus = (key?: string | null) => pick(COLLATERAL_STATUS, key);
export const collateralType = (key?: string | null) => pick(COLLATERAL_TYPE, key);
export const assetStatus = (key?: string | null) => pick(ASSET, key);
export const tenantStatus = (key?: string | null) => pick(TENANT, key);
export const contextLabel = (key?: string | null) => pick(CONTEXT, key);
export const methodLabel = (key?: string | null) => pick(METHOD, key);
export const purposeLabel = (key?: string | null) => pick(PURPOSE, key);

/** Sisa hari trial (dibulatkan ke atas), null bila tidak ada tanggal. */
export function trialDaysLeft(trialEndsAt: string | null | undefined, now = new Date()): number | null {
  if (!trialEndsAt) return null;
  const end = new Date(trialEndsAt).getTime();
  if (!Number.isFinite(end)) return null;
  return Math.ceil((end - now.getTime()) / (24 * 60 * 60 * 1000));
}
