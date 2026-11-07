/**
 * Kontrak JSON endpoint Admin Platform (`/api/v1/platform-admin/*`).
 *
 * Hanya field yang benar-benar dikirim server yang dideklarasikan. Bentuk ini
 * mengikuti `platform-admin.controller.ts` dan service direktori; menambah
 * properti di sini tanpa mengubah server akan menyesatkan UI.
 */

export interface PlatformAdminPrincipal {
  id: string;
  email: string;
  sessionId: string;
  permissions: string[];
  roles: string[];
  reauthenticatedAt: string | null;
}

export type TenantStatus = "PENDING_ACTIVATION" | "ACTIVE" | "SUSPENDED" | "CLOSED";

export interface TenantSummary {
  id: string;
  slug: string;
  name: string;
  status: TenantStatus;
  createdAt: string;
  trialEndsAt: string | null;
  updatedAt?: string;
}

export interface TenantDetail extends TenantSummary {
  timezone: string;
  currency: string;
  updatedAt: string;
  activatedAt: string | null;
}

export interface Paged<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface AdminRoleView {
  roleCode: string;
  roleName: string;
  assignedAt: string;
}

export interface PlatformAdminSummary {
  id: string;
  email: string;
  status: "ACTIVE" | "DISABLED";
  mfaEnrolledAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  roles: AdminRoleView[];
}

export interface PlatformAdminDetail extends PlatformAdminSummary {
  permissions: string[];
}

export type AuditOutcome = "SUCCESS" | "DENIED" | "FAILED";

export interface AuditEvent {
  id: string;
  actorAdminId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  reason: string | null;
  outcome: AuditOutcome;
  correlationId: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export type CronRunStatus = "SUCCEEDED" | "PARTIAL" | "FAILED";
export type CronJobName = "outbox" | "subscriptions" | "billingReminders";
export type CronJobState = "SUCCEEDED" | "FAILED" | "UNKNOWN";

export interface CronRun {
  id: string;
  startedAt: string;
  finishedAt: string;
  status: CronRunStatus;
  durationMs: number;
  failedJobs: string[];
  results: Record<string, unknown> | null;
  alertedAt: string | null;
  jobs: Record<CronJobName, CronJobState>;
}

export interface LoginResult {
  status: "MFA_REQUIRED" | "MFA_ENROLLMENT_REQUIRED";
  challenge: {
    challengeToken: string;
    expiresAt: string;
    /** Hanya ada saat enrollment pertama: `otpauth://totp/...`. */
    provisioningUri?: string;
  };
}

export interface MfaResult {
  csrfToken: string;
  expiresAt: string;
  /** Hanya dikirim sekali, saat enrollment TOTP berhasil. */
  recoveryCodes?: string[];
}
