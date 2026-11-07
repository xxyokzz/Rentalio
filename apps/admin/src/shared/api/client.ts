"use client";

import { describeApiError } from "./errors";
import type { LoginResult, MfaResult } from "./types";

const API_BASE = "/api/v1";

/**
 * Token CSRF hanya hidup di memori modul: tidak pernah localStorage,
 * sessionStorage, cookie yang bisa dibaca JS, atau log. Setiap muat halaman
 * baru, token diterbitkan ulang lewat `GET /platform-admin/csrf`.
 */
let csrfToken: string | null = null;
let csrfInFlight: Promise<string> | null = null;

export class AdminRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;

  constructor(status: number, code: string, message: string, requestId: string | null = null) {
    super(message);
    this.name = "AdminRequestError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export function describeRequestError(error: unknown): string {
  if (error instanceof AdminRequestError) {
    return describeApiError({
      status: error.status,
      code: error.code,
      message: error.message,
    });
  }
  return "Terjadi kesalahan tak terduga. Muat ulang halaman lalu coba lagi.";
}

/**
 * True bila API menolak aksi karena re-authentication sesi sudah kedaluwarsa.
 * UI memakai ini untuk meminta password + TOTP lalu mengulang aksi yang sama.
 */
export function isReauthenticationRequired(error: unknown): boolean {
  return error instanceof AdminRequestError && error.code === "REAUTHENTICATION_REQUIRED";
}

function redirectToLogin(): void {
  if (typeof window === "undefined") return;
  if (window.location.pathname !== "/login") {
    // Muat ulang penuh: sesi server sudah tidak sah, jadi cache React perlu dibuang.
    window.location.replace("/login?expired=1");
  }
}

async function fetchCsrfToken(): Promise<string> {
  if (csrfToken) return csrfToken;
  if (csrfInFlight) return csrfInFlight;

  const pending = (async () => {
    const response = await fetch(`${API_BASE}/platform-admin/csrf`, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (response.status === 401) {
      redirectToLogin();
      throw new AdminRequestError(401, "UNAUTHENTICATED", "Sesi admin tidak aktif.");
    }
    if (!response.ok) {
      throw new AdminRequestError(
        response.status,
        "UNEXPECTED_RESPONSE",
        "Tidak dapat menerbitkan token keamanan sesi.",
      );
    }
    const payload = (await response.json()) as { csrfToken?: string };
    if (!payload.csrfToken) {
      throw new AdminRequestError(
        response.status,
        "UNEXPECTED_RESPONSE",
        "Respons token keamanan tidak sesuai kontrak.",
      );
    }
    csrfToken = payload.csrfToken;
    return payload.csrfToken;
  })().finally(() => {
    csrfInFlight = null;
  });

  csrfInFlight = pending;
  return pending;
}

interface RequestOptions {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  csrf?: boolean;
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string; request_id?: string };
}

async function send<T>(path: string, options: RequestOptions, retried = false): Promise<T> {
  const method = options.method ?? "GET";
  const needsCsrf = method !== "GET" && options.csrf !== false;

  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  try {
    if (needsCsrf) headers["X-Platform-Admin-CSRF"] = await fetchCsrfToken();
  } catch (error) {
    if (error instanceof AdminRequestError) throw error;
    throw new AdminRequestError(0, "NETWORK_ERROR", "Tidak dapat terhubung ke API.");
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: "include",
      cache: "no-store",
    });
  } catch {
    throw new AdminRequestError(0, "NETWORK_ERROR", "Tidak dapat terhubung ke API.");
  }

  if (response.status === 204) return undefined as T;

  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? ((await response.json().catch(() => null)) as ErrorEnvelope | null)
    : null;

  if (!response.ok) {
    const code =
      payload?.error?.code ??
      (response.status === 401
        ? "UNAUTHENTICATED"
        : response.status === 403
          ? "PERMISSION_DENIED"
          : "INTERNAL_ERROR");
    const message = payload?.error?.message ?? "Permintaan gagal.";

    // Token CSRF bisa diganti tab lain (setiap GET /csrf merotasi). Segarkan sekali.
    if (response.status === 403 && code === "CSRF_VALIDATION_FAILED" && !retried) {
      csrfToken = null;
      return send<T>(path, options, true);
    }
    if (response.status === 401) {
      csrfToken = null;
      redirectToLogin();
    }
    throw new AdminRequestError(
      response.status,
      code,
      message,
      payload?.error?.request_id ?? null,
    );
  }

  return payload as T;
}

export const adminApi = {
  // Tiga endpoint pra-sesi tidak memakai PlatformAdminCsrfGuard di API: belum
  // ada sesi, jadi token CSRF memang belum bisa diterbitkan. Klausa `csrf: false`
  // mencegah klien memanggil GET /csrf yang pasti 401 sebelum login.
  login(email: string, password: string): Promise<LoginResult> {
    return send<LoginResult>("/platform-admin/auth/login", {
      method: "POST",
      body: { email, password },
      csrf: false,
    });
  },

  async completeMfa(challengeToken: string, code: string): Promise<MfaResult> {
    const result = await send<MfaResult>("/platform-admin/auth/mfa", {
      method: "POST",
      body: { challengeToken, code },
      csrf: false,
    });
    if (result.csrfToken) csrfToken = result.csrfToken;
    return result;
  },

  async loginWithRecovery(challengeToken: string, recoveryCode: string): Promise<MfaResult> {
    const result = await send<MfaResult>("/platform-admin/auth/recovery", {
      method: "POST",
      body: { challengeToken, recoveryCode },
      csrf: false,
    });
    if (result.csrfToken) csrfToken = result.csrfToken;
    return result;
  },

  logout(): Promise<void> {
    return send<void>("/platform-admin/session", { method: "DELETE" });
  },

  /** Segarkan re-authentication sesi (password + TOTP) sebelum tindakan berisiko. */
  reauthenticate(password: string, code: string): Promise<{ data: { reauthenticatedAt: string } }> {
    return send("/platform-admin/auth/reauth", { method: "POST", body: { password, code } });
  },

  suspendTenant(tenantId: string, reason: string): Promise<unknown> {
    return send(`/platform-admin/tenants/${tenantId}/suspend`, {
      method: "POST",
      body: { reason },
    });
  },

  reactivateTenant(tenantId: string, reason: string): Promise<unknown> {
    return send(`/platform-admin/tenants/${tenantId}/reactivate`, {
      method: "POST",
      body: { reason },
    });
  },

  settleInvoice(
    tenantId: string,
    invoiceId: string,
    body: { paidAmount?: number; channel?: string; reason: string },
  ): Promise<unknown> {
    return send(
      `/platform-admin/tenants/${tenantId}/subscription-invoices/${invoiceId}/settle`,
      { method: "POST", body },
    );
  },

  assignRole(adminId: string, roleCode: string, reason: string): Promise<unknown> {
    return send(`/platform-admin/admins/${adminId}/roles/assign`, {
      method: "POST",
      body: { roleCode, reason },
    });
  },

  revokeRole(adminId: string, roleCode: string, reason: string): Promise<unknown> {
    return send(`/platform-admin/admins/${adminId}/roles/revoke`, {
      method: "POST",
      body: { roleCode, reason },
    });
  },
};
