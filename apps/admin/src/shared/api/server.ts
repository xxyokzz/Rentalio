import { cookies } from "next/headers";
import type {
  AuditEvent,
  CronRun,
  CronRunStatus,
  Paged,
  PlatformAdminDetail,
  PlatformAdminPrincipal,
  PlatformAdminSummary,
  SubscriptionInvoiceSummary,
  TenantDetail,
  TenantStatus,
  TenantSummary,
} from "./types";

/**
 * Server component memanggil API langsung (bukan lewat rewrite browser), jadi
 * cookie admin harus diteruskan eksplisit dalam header. Cookie tidak pernah
 * dibaca klien: nilainya HttpOnly, dan file ini hanya berjalan di server.
 */
export const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? "http://localhost:3000";
export const ADMIN_COOKIE = "rentalio_platform_admin";

export class AdminApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string): Promise<T> {
  const store = await cookies();
  const token = store.get(ADMIN_COOKIE)?.value;

  let response: Response;
  try {
    response = await fetch(`${API_INTERNAL_URL}/api/v1${path}`, {
      headers: {
        Accept: "application/json",
        ...(token ? { Cookie: `${ADMIN_COOKIE}=${token}` } : {}),
      },
      cache: "no-store",
    });
  } catch {
    throw new AdminApiError(0, "NETWORK_ERROR", "API Rentalio tidak dapat dihubungi.");
  }

  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? ((await response.json().catch(() => null)) as unknown)
    : null;

  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string } } | null)?.error;
    throw new AdminApiError(
      response.status,
      error?.code ?? "INTERNAL_ERROR",
      error?.message ?? "Permintaan ke API gagal.",
    );
  }

  return payload as T;
}

/** Null berarti belum/tidak ada sesi sah — bukan error. */
export async function getAdminSession(): Promise<PlatformAdminPrincipal | null> {
  try {
    const payload = await request<{ data: PlatformAdminPrincipal }>("/platform-admin/session");
    return payload.data ?? null;
  } catch (error) {
    if (error instanceof AdminApiError && error.status === 401) return null;
    throw error;
  }
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const serialized = search.toString();
  return serialized ? `?${serialized}` : "";
}

export function listTenants(input: {
  q?: string;
  status?: TenantStatus;
  page: number;
}): Promise<Paged<TenantSummary>> {
  return request<Paged<TenantSummary>>(
    `/platform-admin/tenants${query({ q: input.q, status: input.status, page: input.page })}`,
  );
}

export async function getTenant(tenantId: string): Promise<TenantDetail> {
  const payload = await request<{ data: TenantDetail }>(
    `/platform-admin/tenants/${encodeURIComponent(tenantId)}`,
  );
  return payload.data;
}

export async function listPendingInvoices(tenantId: string): Promise<SubscriptionInvoiceSummary[]> {
  const payload = await request<{ data: SubscriptionInvoiceSummary[] }>(
    `/platform-admin/tenants/${encodeURIComponent(tenantId)}/subscription-invoices`,
  );
  return payload.data;
}

export function listAdmins(input: { q?: string; page: number }): Promise<Paged<PlatformAdminSummary>> {
  return request<Paged<PlatformAdminSummary>>(
    `/platform-admin/admins${query({ q: input.q, page: input.page })}`,
  );
}

export async function getAdmin(adminId: string): Promise<PlatformAdminDetail> {
  const payload = await request<{ data: PlatformAdminDetail }>(
    `/platform-admin/admins/${encodeURIComponent(adminId)}`,
  );
  return payload.data;
}

export function listAuditEvents(input: {
  actorAdminId?: string;
  action?: string;
  from?: string;
  to?: string;
  page: number;
}): Promise<Paged<AuditEvent>> {
  return request<Paged<AuditEvent>>(
    `/platform-admin/audit-events${query({
      actorAdminId: input.actorAdminId,
      action: input.action,
      from: input.from,
      to: input.to,
      page: input.page,
    })}`,
  );
}

export function listCronRuns(input: {
  status?: CronRunStatus;
  page: number;
}): Promise<Paged<CronRun>> {
  return request<Paged<CronRun>>(
    `/platform-admin/cron-runs${query({ status: input.status, page: input.page })}`,
  );
}
