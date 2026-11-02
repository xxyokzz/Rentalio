import { can, canManageMembers, type Permission, type Role } from "@/shared/auth/permissions";
import type { IconName } from "@/shared/ui/icons";

export interface NavItem {
  href: string;
  label: string;
  glyph: IconName;
  /** Permission UX minimum untuk melihat halaman. */
  permission: Permission;
  /** Halaman pengaturan membership hanya untuk OWNER (ditegakkan backend). */
  ownerOnly?: boolean;
}

export interface NavGroup {
  id: string;
  label: string;
  items: NavItem[];
}

/**
 * Navigasi disusun berdasarkan tugas operasional, bukan urutan tabel database
 * (Notion 09 §2). Matriks role-per-halaman di bawah adalah artefak yang
 * diminta dokumen; backend tetap menegakkan otorisasi.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    id: "operasional",
    label: "Operasional",
    items: [
      { href: "/app", label: "Ringkasan", glyph: "grid", permission: "order.create" },
      { href: "/app/bookings", label: "Kalender booking", glyph: "calendar", permission: "order.create" },
      { href: "/app/orders", label: "Pesanan", glyph: "receipt", permission: "order.create" },
      { href: "/app/pos", label: "Kasir (POS)", glyph: "register", permission: "order.create" },
      { href: "/app/returns", label: "Pengembalian", glyph: "rotate", permission: "order.return" },
      { href: "/app/conflicts", label: "Konflik perpanjangan", glyph: "alert", permission: "rental.extension.resolve_conflict" },
    ],
  },
  {
    id: "katalog",
    label: "Katalog",
    items: [
      { href: "/app/inventory", label: "Inventaris", glyph: "box", permission: "catalog.write" },
      { href: "/app/categories", label: "Kategori", glyph: "tag", permission: "catalog.write" },
      {
        href: "/app/catalog-editor",
        label: "Kustom katalog",
        glyph: "layout",
        permission: "catalog.write",
        ownerOnly: true,
      },
    ],
  },
  {
    id: "laporan",
    label: "Laporan",
    items: [{ href: "/app/reports", label: "Rekap operasional", glyph: "chart", permission: "report.read" }],
  },
  {
    id: "pengaturan",
    label: "Pengaturan",
    items: [
      { href: "/app/settings", label: "Pengaturan toko", glyph: "sliders", permission: "settings.payment_methods.manage" },
      { href: "/app/settings/payment-methods", label: "Metode pembayaran", glyph: "card", permission: "settings.payment_methods.manage" },
      { href: "/app/settings/whatsapp-templates", label: "Template WhatsApp", glyph: "message", permission: "settings.whatsapp_templates.manage" },
      { href: "/app/settings/staff", label: "Tim & hak akses", glyph: "users", permission: "settings.payment_methods.manage", ownerOnly: true },
    ],
  },
];

export interface RouteRule {
  pattern: RegExp;
  label: string;
  /** Permission yang dibutuhkan untuk MELIHAT halaman. */
  permission: Permission;
  /** Aksi berisiko di halaman ini dan permission backend-nya. */
  actions: Array<{ action: string; permission: Permission }>;
  ownerOnly?: boolean;
}

/**
 * Matriks route → role/permission. Dipakai untuk guard UX dan dokumentasi
 * (artefak "daftar route dan matriks role-per-halaman/aksi").
 */
export const ROUTE_MATRIX: RouteRule[] = [
  { pattern: /^\/app$/, label: "Ringkasan", permission: "order.create", actions: [] },
  {
    pattern: /^\/app\/bookings/,
    label: "Kalender booking",
    permission: "order.create",
    actions: [
      { action: "Buat reservasi", permission: "reservation.create" },
      { action: "Setujui reservasi", permission: "reservation.approve" },
      { action: "Tolak/batalkan reservasi", permission: "reservation.cancel" },
      { action: "Konversi ke pesanan", permission: "order.create" },
    ],
  },
  {
    pattern: /^\/app\/orders\//,
    label: "Detail pesanan",
    permission: "order.create",
    actions: [
      { action: "Siap serah-terima", permission: "order.handover" },
      { action: "Serah-terima", permission: "order.handover" },
      { action: "Selesaikan pesanan", permission: "order.return" },
      { action: "Catat pembayaran", permission: "payment.record" },
      { action: "Void pembayaran", permission: "payment.void" },
      { action: "Ajukan refund", permission: "refund.request" },
      { action: "Setujui refund", permission: "refund.approve" },
      { action: "Catat hasil refund", permission: "refund.process" },
      { action: "Terima deposit", permission: "deposit.receive" },
      { action: "Ajukan potongan deposit", permission: "deposit.deduct" },
      { action: "Setujui potongan deposit", permission: "deposit.deduct.approve" },
      { action: "Refund deposit", permission: "deposit.refund" },
      { action: "Catat pengembalian", permission: "order.return" },
      { action: "Buat inspeksi", permission: "order.inspect" },
      { action: "Putuskan inspeksi", permission: "order.inspect" },
      { action: "Ajukan perpanjangan", permission: "rental.extension.request" },
      { action: "Setujui perpanjangan", permission: "rental.extension.approve" },
      { action: "Override konflik", permission: "rental.extension.override_conflict" },
    ],
  },
  {
    pattern: /^\/app\/orders/,
    label: "Pesanan",
    permission: "order.create",
    actions: [{ action: "Buka detail", permission: "order.create" }],
  },
  { pattern: /^\/app\/pos/, label: "Kasir (POS)", permission: "order.create", actions: [{ action: "Buat transaksi", permission: "reservation.create" }] },
  {
    pattern: /^\/app\/returns/,
    label: "Pengembalian & inspeksi",
    permission: "order.return",
    actions: [
      { action: "Catat pengembalian", permission: "order.return" },
      { action: "Selesaikan pengembalian", permission: "order.return" },
      { action: "Putuskan inspeksi", permission: "order.inspect" },
    ],
  },
  {
    pattern: /^\/app\/conflicts/,
    label: "Konflik perpanjangan",
    permission: "rental.extension.resolve_conflict",
    actions: [{ action: "Tandai konflik selesai", permission: "rental.extension.resolve_conflict" }],
  },
  {
    pattern: /^\/app\/inventory/,
    label: "Inventaris",
    permission: "catalog.write",
    actions: [
      { action: "Buat/ubah produk", permission: "catalog.write" },
      { action: "Atur tarif", permission: "catalog.write" },
      { action: "Tambah unit fisik", permission: "catalog.write" },
      { action: "Catat maintenance", permission: "catalog.write" },
    ],
  },
  { pattern: /^\/app\/categories/, label: "Kategori", permission: "catalog.write", actions: [{ action: "Ubah kategori", permission: "catalog.write" }] },
  {
    pattern: /^\/app\/catalog-editor/,
    label: "Kustom katalog",
    permission: "catalog.write",
    ownerOnly: true,
    actions: [{ action: "Kustomisasi tampilan katalog", permission: "catalog.write" }],
  },
  { pattern: /^\/app\/reports/, label: "Rekap operasional", permission: "report.read", actions: [] },
  {
    pattern: /^\/app\/settings\/payment-methods/,
    label: "Metode pembayaran",
    permission: "settings.payment_methods.manage",
    actions: [{ action: "Ubah matriks metode", permission: "settings.payment_methods.manage" }],
  },
  {
    pattern: /^\/app\/settings\/whatsapp-templates/,
    label: "Template WhatsApp",
    permission: "settings.whatsapp_templates.manage",
    actions: [
      { action: "Buat/ubah template", permission: "settings.whatsapp_templates.manage" },
      { action: "Pulihkan bawaan", permission: "settings.whatsapp_templates.manage" },
    ],
  },
  {
    pattern: /^\/app\/settings\/staff/,
    label: "Tim & hak akses",
    permission: "settings.payment_methods.manage",
    ownerOnly: true,
    actions: [{ action: "Undang/ubah staf", permission: "settings.payment_methods.manage" }],
  },
  {
    pattern: /^\/app\/settings/,
    label: "Pengaturan toko",
    permission: "settings.payment_methods.manage",
    actions: [
      { action: "Ubah mode booking", permission: "settings.payment_methods.manage" },
      { action: "Ubah policy katalog/perpanjangan", permission: "settings.payment_methods.manage" },
    ],
  },
];

/** Visibilitas halaman berdasarkan role (UX saja). */
export function canViewRoute(role: Role | undefined, href: string): boolean {
  const path = href.split("?")[0] ?? href;
  const rule = ROUTE_MATRIX.find((item) => item.pattern.test(path));
  if (!rule) return true;
  if (rule.ownerOnly) return canManageMembers(role);
  return can(role, rule.permission);
}

export function visibleNavGroups(role: Role | undefined): NavGroup[] {
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) => canViewRoute(role, item.href) && (!item.ownerOnly || canManageMembers(role)),
    ),
  })).filter((group) => group.items.length > 0);
}
