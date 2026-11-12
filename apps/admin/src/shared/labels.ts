import type { CronJobName, CronJobState, CronRunStatus, TenantStatus } from "./api/types";

export const TENANT_STATUSES: readonly TenantStatus[] = [
  "PENDING_ACTIVATION",
  "ACTIVE",
  "SUSPENDED",
  "CLOSED",
];

export const TENANT_STATUS_LABELS: Record<TenantStatus, string> = {
  PENDING_ACTIVATION: "Menunggu aktivasi",
  ACTIVE: "Aktif",
  SUSPENDED: "Ditangguhkan",
  CLOSED: "Ditutup",
};

export const TENANT_STATUS_TONES: Record<TenantStatus, string> = {
  PENDING_ACTIVATION: "pending",
  ACTIVE: "active",
  SUSPENDED: "suspended",
  CLOSED: "closed",
};

export const CRON_RUN_STATUSES: readonly CronRunStatus[] = [
  "SUCCEEDED",
  "PARTIAL",
  "FAILED",
];

export const CRON_RUN_STATUS_LABELS: Record<CronRunStatus, string> = {
  SUCCEEDED: "Sukses",
  PARTIAL: "Sebagian",
  FAILED: "Gagal",
};

export const CRON_RUN_STATUS_TONES: Record<CronRunStatus, string> = {
  SUCCEEDED: "active",
  PARTIAL: "pending",
  FAILED: "suspended",
};

export const CRON_JOB_NAMES: readonly CronJobName[] = [
  "outbox",
  "subscriptions",
  "billingReminders",
];

export const CRON_JOB_LABELS: Record<CronJobName, string> = {
  outbox: "Outbox",
  subscriptions: "Subscription",
  billingReminders: "Billing reminder",
};

export const CRON_JOB_STATE_LABELS: Record<CronJobState, string> = {
  SUCCEEDED: "Sukses",
  FAILED: "Gagal",
  UNKNOWN: "Tidak diketahui",
};

export const CRON_JOB_STATE_TONES: Record<CronJobState, string> = {
  SUCCEEDED: "active",
  FAILED: "suspended",
  UNKNOWN: "closed",
};

/** Harus sama dengan `PLATFORM_AUDIT_ACTIONS` di API agar filter tidak ditolak 400. */
export const AUDIT_ACTIONS = [
  "PLATFORM_ADMIN_BOOTSTRAPPED",
  "PLATFORM_ADMIN_LOGIN_FAILED",
  "PLATFORM_ADMIN_MFA_ENROLLMENT_STARTED",
  "PLATFORM_ADMIN_MFA_ENROLLED",
  "PLATFORM_ADMIN_MFA_CHALLENGE_ISSUED",
  "PLATFORM_ADMIN_LOGIN_SUCCEEDED",
  "PLATFORM_ADMIN_RECOVERY_CODE_USED",
  "PLATFORM_ADMIN_LOGOUT",
  "PLATFORM_TENANT_DIRECTORY_VIEWED",
  "PLATFORM_TENANT_SUMMARY_VIEWED",
  "PLATFORM_TENANT_SUSPENDED",
  "PLATFORM_TENANT_REACTIVATED",
  "PLATFORM_ADMIN_ROLE_ASSIGNED",
  "PLATFORM_ADMIN_ROLE_REVOKED",
  "PLATFORM_ADMIN_DIRECTORY_VIEWED",
  "PLATFORM_ADMIN_DETAIL_VIEWED",
  "PLATFORM_SUBSCRIPTION_INVOICE_SETTLED",
  "PLATFORM_SUBSCRIPTION_INVOICES_VIEWED",
] as const;

/** Role yang di-seed migrasi `platform_admin_identity`. */
export const PLATFORM_ROLES = [
  { code: "PLATFORM_SUPER_ADMIN", name: "Super Admin" },
  { code: "PLATFORM_SUPPORT", name: "Support" },
  { code: "PLATFORM_BILLING", name: "Billing" },
  { code: "PLATFORM_COMMUNICATIONS", name: "Communications" },
] as const;

export const ADMIN_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "Aktif",
  DISABLED: "Nonaktif",
};
