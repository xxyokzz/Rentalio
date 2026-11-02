"use client";

import type { ReactNode } from "react";
import { describeApiError, isApiRequestError, isForbidden, isNotFound } from "@/shared/api/errors";
import { Button } from "./buttons";

export function Skeleton({ height = "1rem", width = "100%" }: { height?: string; width?: string }) {
  return <span className="skeleton" style={{ display: "block", height, width }} />;
}

export function LoadingBlock({ rows = 3, label = "Memuat data…" }: { rows?: number; label?: string }) {
  return (
    <div className="stack-sm" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }).map((_, index) => (
        <Skeleton key={index} height="2.25rem" />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <p className="empty-title">{title}</p>
      {description ? <p className="text-sm">{description}</p> : null}
      {action}
    </div>
  );
}

/**
 * Error state tidak pernah menampilkan stack trace/payload. HTTP 403 tidak
 * disamarkan sebagai data kosong (Notion 09 — kontrak interaksi API).
 */
export function ErrorState({
  error,
  onRetry,
  compact,
}: {
  error: unknown;
  onRetry?: () => void;
  compact?: boolean;
}) {
  const forbidden = isForbidden(error);
  const notFound = isNotFound(error);
  const requestId = isApiRequestError(error) ? error.requestId : null;

  return (
    <div className={compact ? "inline-alert inline-alert-danger" : "error-state"} role="alert">
      <p className="error-title">
        {forbidden
          ? "Akses ditolak"
          : notFound
            ? "Data tidak ditemukan"
            : "Permintaan gagal"}
      </p>
      <p className="text-sm">{describeApiError(error)}</p>
      {forbidden ? (
        <p className="text-sm">
          Peran akun Anda tidak memiliki izin untuk tindakan ini. Hubungi owner tenant bila akses
          diperlukan.
        </p>
      ) : null}
      {requestId ? <p className="error-meta">ID permintaan: {requestId}</p> : null}
      {onRetry ? (
        <Button size="sm" onClick={onRetry}>
          Coba lagi
        </Button>
      ) : null}
    </div>
  );
}

export function InlineAlert({
  tone = "info",
  children,
}: {
  tone?: "info" | "warning" | "danger";
  children: ReactNode;
}) {
  return <div className={`inline-alert inline-alert-${tone}`}>{children}</div>;
}

/**
 * Pembungkus standar: skeleton saat awal, error+retry saat gagal, empty state
 * bila data kosong, lalu konten. Semua halaman data wajib lewat sini.
 */
export function QueryState<T>({
  state,
  children,
  empty,
  isEmpty,
  loadingRows = 3,
}: {
  state: {
    data: T | null;
    error: unknown;
    initialLoading: boolean;
    loading: boolean;
    reload: () => void;
  };
  children: (data: T) => ReactNode;
  empty?: ReactNode;
  isEmpty?: (data: T) => boolean;
  loadingRows?: number;
}) {
  if (state.initialLoading) return <LoadingBlock rows={loadingRows} />;
  if (state.error) return <ErrorState error={state.error} onRetry={state.reload} />;
  if (state.data === null) return <>{empty ?? <EmptyState title="Belum ada data" />}</>;
  if (empty && isEmpty?.(state.data)) return <>{empty}</>;
  return <>{children(state.data)}</>;
}
