import { ApiRequestError, type ErrorCode } from "./errors";

export const API_BASE_PATH = "/api/v1";
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Token CSRF hanya disimpan di memori modul, tidak pernah di localStorage,
 * sessionStorage, cookie yang bisa dibaca JS, log, atau analytics
 * (Notion 09 — kontrak frontend auth).
 */
let csrfToken: string | null = null;
let csrfInFlight: Promise<string> | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

/** Sesi dicabut/kedaluwarsa: beri tahu lapisan auth sekali lewat event. */
function broadcastUnauthenticated(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("rentalio:unauthenticated"));
}

export function apiUrl(path: string): string {
  return path.startsWith(API_BASE_PATH) ? path : `${API_BASE_PATH}${path}`;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Untuk mutasi: sertakan X-CSRF-Token (default true untuk POST/PATCH/PUT/DELETE). */
  csrf?: boolean;
  /** Idempotency-Key untuk command yang mendukung replay aman. */
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** Jangan broadcast 401 (mis. saat memeriksa sesi awal). */
  silentAuth?: boolean;
}

interface RawResponse<T> {
  data: T;
  requestId: string | null;
  status: number;
  headers: Headers;
}

function parseRetryAfter(headers: Headers): number | null {
  const value = headers.get("retry-after");
  if (!value) return null;
  const seconds = Number.parseInt(value, 10);
  return Number.isFinite(seconds) ? seconds : null;
}

async function fetchCsrfToken(): Promise<string> {
  if (csrfToken) return csrfToken;
  if (csrfInFlight) return csrfInFlight;

  csrfInFlight = (async () => {
    const response = await fetch(apiUrl("/auth/csrf"), {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) {
      throw new ApiRequestError({
        status: response.status,
        code: response.status === 401 ? "UNAUTHENTICATED" : "UNEXPECTED_RESPONSE",
        message: "Tidak dapat menerbitkan token keamanan sesi.",
        requestId: response.headers.get("x-correlation-id"),
      });
    }
    const payload = (await response.json()) as { csrfToken?: string };
    if (!payload.csrfToken) {
      throw new ApiRequestError({
        status: response.status,
        code: "UNEXPECTED_RESPONSE",
        message: "Respons token keamanan tidak sesuai kontrak.",
      });
    }
    csrfToken = payload.csrfToken;
    return csrfToken;
  })().finally(() => {
    csrfInFlight = null;
  });

  return csrfInFlight;
}

async function execute<T>(
  path: string,
  options: RequestOptions,
  isRetry = false,
): Promise<RawResponse<T>> {
  const method = options.method ?? "GET";
  const isMutation = method !== "GET";
  const needsCsrf = isMutation && options.csrf !== false;

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException("timeout", "TimeoutError")),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  const abortFromParent = () => controller.abort();
  options.signal?.addEventListener("abort", abortFromParent, { once: true });

  const headers: Record<string, string> = {
    Accept: "application/json",
    ...options.headers,
  };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

  try {
    if (needsCsrf) {
      headers["X-CSRF-Token"] = await fetchCsrfToken();
    }

    const response = await fetch(apiUrl(path), {
      method,
      credentials: "include",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: "no-store",
      signal: controller.signal,
    });

    const requestId = response.headers.get("x-correlation-id");
    const rotated = response.headers.get("x-csrf-token");
    if (rotated) csrfToken = rotated;

    if (response.status === 204) {
      return { data: undefined as T, requestId, status: 204, headers: response.headers };
    }

    const contentType = response.headers.get("content-type") ?? "";
    const payload = contentType.includes("application/json")
      ? await response.json()
      : null;

    if (!response.ok) {
      const body = payload as
        | { error?: { code?: ErrorCode; message?: string; request_id?: string; details?: unknown } }
        | null;
      const code: ErrorCode =
        body?.error?.code ??
        (response.status === 401
          ? "UNAUTHENTICATED"
          : response.status === 403
            ? "PERMISSION_DENIED"
            : response.status === 404
              ? "NOT_FOUND"
              : response.status === 409
                ? "AVAILABILITY_CONFLICT"
                : response.status === 429
                  ? "RATE_LIMITED"
                  : "INTERNAL_ERROR");

      // Token CSRF bisa kedaluwarsa setelah re-auth/rotasi sesi: segarkan sekali.
      if (!isRetry && response.status === 403 && code === "CSRF_VALIDATION_FAILED") {
        setCsrfToken(null);
        return execute<T>(path, options, true);
      }

      if (response.status === 401 && !options.silentAuth) broadcastUnauthenticated();

      throw new ApiRequestError({
        status: response.status,
        code,
        message: body?.error?.message ?? "Permintaan gagal.",
        requestId: body?.error?.request_id ?? requestId,
        details: body?.error?.details,
        retryAfterSeconds: parseRetryAfter(response.headers),
      });
    }

    return { data: payload as T, requestId, status: response.status, headers: response.headers };
  } catch (error) {
    if (error instanceof ApiRequestError) throw error;

    const aborted =
      error instanceof DOMException &&
      (error.name === "AbortError" || error.name === "TimeoutError");
    if (aborted) {
      throw new ApiRequestError({
        status: 0,
        code: options.signal?.aborted ? "NETWORK_ERROR" : "TIMEOUT",
        message: "Permintaan dibatalkan atau melewati batas waktu.",
      });
    }

    throw new ApiRequestError({
      status: 0,
      code: "NETWORK_ERROR",
      message: "Koneksi ke server gagal.",
    });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromParent);
  }
}

type Envelope = { data?: unknown } & Record<string, unknown>;

function unwrap<T>(payload: unknown): T {
  if (payload && typeof payload === "object" && "data" in payload) {
    return (payload as { data: T }).data;
  }
  return payload as T;
}

/**
 * Panggil API dan kembalikan isi `data`. Semua error sudah dinormalisasi.
 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await execute<Envelope>(path, options);
  return unwrap<T>(response.data);
}

/** Untuk endpoint yang mengembalikan envelope datar (login, CSRF). */
export async function apiRequestRaw<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await execute<T>(path, options);
  return response.data;
}

/** Versi metadata: dibutuhkan untuk pagination dan header seperti X-CSRF-Token. */
export async function apiRequestWithMeta<T>(
  path: string,
  options: RequestOptions = {},
): Promise<{
  data: T;
  payload: Envelope | undefined;
  requestId: string | null;
  status: number;
  headers: Headers;
}> {
  const response = await execute<Envelope>(path, options);
  return {
    data: unwrap<T>(response.data),
    payload: response.data,
    requestId: response.requestId,
    status: response.status,
    headers: response.headers,
  };
}
