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
