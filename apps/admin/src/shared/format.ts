const DATE_FORMAT = new Intl.DateTimeFormat("id-ID", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

const DATE_TIME_FORMAT = new Intl.DateTimeFormat("id-ID", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZoneName: "short",
});

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : DATE_FORMAT.format(date);
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : DATE_TIME_FORMAT.format(date);
}

/** ID pendek untuk tabel; ID lengkap tetap terlihat di halaman detail. */
export function shortId(value: string | null | undefined): string {
  if (!value) return "—";
  return value.length <= 12 ? value : `${value.slice(0, 8)}…`;
}

/** `datetime-local` (waktu lokal) → ISO 8601 yang diterima API. */
export function localInputToIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

const DURATION_NUMBER = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 1 });

/** Durasi ringkas untuk tabel operasional: ms, detik, atau menit+detik. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${DURATION_NUMBER.format(ms / 1_000)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return seconds > 0 ? `${minutes} m ${seconds} s` : `${minutes} m`;
}
