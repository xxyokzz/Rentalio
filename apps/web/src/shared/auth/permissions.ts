/**
 * Permission default per role — cermin dari backend
 * (`apps/api/src/tenant/tenant.service.ts`). Ini hanya untuk UX: menyembunyikan
 * atau menonaktifkan kontrol. Backend tetap satu-satunya otoritas dan dapat
 * memberi permission kustom per membership, jadi UI tidak boleh mengklaim
 * "pasti diizinkan" tanpa respons server (Notion 09 — role/action matrix).
 */
export type Role = "OWNER" | "MANAGER" | "STAFF" | "CASHIER";

export const ROLE_LABEL: Record<Role, string> = {
  OWNER: "Owner",
  MANAGER: "Manager",
  STAFF: "Staf",
  CASHIER: "Kasir",
};

const MANAGER_PERMISSIONS = [
  "catalog.read",
  "catalog.write",
  "inventory.read",
  "inventory.write",
  "availability.read",
  "reservation.read",
  "reservation.create",
  "reservation.approve",
  "reservation.cancel",
  "order.read",
  "order.create",
  "order.handover",
  "order.return",
  "order.inspect",
  "payment.read",
  "payment.record",
  "payment.void",
  "refund.request",
  "refund.approve",
  "refund.process",
  "deposit.read",
  "deposit.receive",
  "deposit.deduct",
  "deposit.refund",
  "deposit.deduct.approve",
  "rental.extension.request",
  "rental.extension.approve",
  "rental.extension.resolve_conflict",
  "report.read",
  "staff.manage",
] as const;

const STAFF_PERMISSIONS = [
  "catalog.read",
  "inventory.read",
  "availability.read",
  "reservation.read",
  "reservation.create",
  "order.read",
  "order.create",
  "order.handover",
  "order.return",
  "order.inspect",
  "payment.read",
  "payment.record",
  "deposit.read",
  "deposit.receive",
  "rental.extension.request",
  "report.read",
] as const;

const CASHIER_PERMISSIONS = [
  "catalog.read",
  "inventory.read",
  "availability.read",
  "reservation.read",
  "order.read",
  "payment.read",
  "payment.record",
  "deposit.read",
  "deposit.receive",
] as const;

export const ROLE_PERMISSIONS: Record<Role, readonly string[]> = {
  OWNER: ["*"],
  MANAGER: MANAGER_PERMISSIONS,
  STAFF: STAFF_PERMISSIONS,
  CASHIER: CASHIER_PERMISSIONS,
};

export type Permission =
  | "catalog.write"
  | "reservation.create"
  | "reservation.approve"
  | "reservation.cancel"
  | "order.create"
  | "order.handover"
  | "order.return"
  | "order.inspect"
  | "payment.record"
  | "payment.void"
  | "refund.request"
  | "refund.approve"
  | "refund.process"
  | "deposit.receive"
  | "deposit.deduct"
  | "deposit.deduct.approve"
  | "deposit.refund"
  | "rental.extension.request"
  | "rental.extension.approve"
  | "rental.extension.override_conflict"
  | "rental.extension.resolve_conflict"
  | "report.read"
  | "settings.payment_methods.manage"
  | "settings.whatsapp_templates.manage";

export function can(role: Role | undefined, permission: Permission): boolean {
  if (!role) return false;
  const granted = ROLE_PERMISSIONS[role];
  if (granted.includes("*")) return true;
  if (permission === "rental.extension.override_conflict") {
    // Override konflik bukan default role mana pun: wajib permission khusus
    // yang diberikan backend secara eksplisit (Notion 09/14).
    return false;
  }
  return granted.includes(permission);
}

export function isOwner(role: Role | undefined): boolean {
  return role === "OWNER";
}

export function canManageMembers(role: Role | undefined): boolean {
  // Backend membatasi pengelolaan membership ke OWNER.
  return role === "OWNER";
}

/** Warna badge untuk role; selalu disertai label teks. */
export function roleTone(role: Role | undefined): "info" | "neutral" | "warning" {
  if (role === "OWNER") return "info";
  if (role === "MANAGER") return "neutral";
  return "warning";
}
