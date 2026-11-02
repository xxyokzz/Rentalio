/**
 * Helper tanggal/waktu terpusat. Timestamp dari API adalah ISO 8601 (UTC);
 * tampilan mengikuti zona waktu tenant (Notion 09 §6). Jangan memakai
 * `toLocaleDateString()` tanpa timezone di komponen.
 */

export const DEFAULT_TIMEZONE = "Asia/Jakarta";

const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();
const dateTimeFormatterCache = new Map<string, Intl.DateTimeFormat>();
const timeFormatterCache = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = dateFormatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("id-ID", {
    timeZone,
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  dateFormatterCache.set(timeZone, formatter);
  return formatter;
}

function dateTimeFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = dateTimeFormatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("id-ID", {
    timeZone,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  dateTimeFormatterCache.set(timeZone, formatter);
  return formatter;
}

function timeFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = timeFormatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("id-ID", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  timeFormatterCache.set(timeZone, formatter);
  return formatter;
}

function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(
  value: string | Date | null | undefined,
  timeZone: string = DEFAULT_TIMEZONE,
): string {
  const date = toDate(value);
  if (!date) return "—";
  return dateFormatter(safeZone(timeZone)).format(date);
}

export function formatDateTime(
  value: string | Date | null | undefined,
  timeZone: string = DEFAULT_TIMEZONE,
): string {
  const date = toDate(value);
  if (!date) return "—";
  return dateTimeFormatter(safeZone(timeZone)).format(date);
}

export function formatTime(
  value: string | Date | null | undefined,
  timeZone: string = DEFAULT_TIMEZONE,
): string {
  const date = toDate(value);
  if (!date) return "—";
  return timeFormatter(safeZone(timeZone)).format(date);
}

/** "12 Okt 2026 08.00 – 14 Okt 2026 17.00" (zona waktu tenant). */
export function formatDateRange(
  startAt: string | null | undefined,
  endAt: string | null | undefined,
  timeZone: string = DEFAULT_TIMEZONE,
): string {
  const start = toDate(startAt);
  const end = toDate(endAt);
  if (!start || !end) return "—";
  if (dateFormatter(safeZone(timeZone)).format(start) === dateFormatter(safeZone(timeZone)).format(end)) {
    return `${formatDateTime(start, timeZone)} – ${formatTime(end, timeZone)}`;
  }
  return `${formatDateTime(start, timeZone)} – ${formatDateTime(end, timeZone)}`;
}

function safeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("id-ID", { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

function zoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: safeZone(timeZone),
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number.parseInt(parts.find((part) => part.type === type)?.value ?? "0", 10);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return asUtc - date.getTime();
}

/**
 * Ubah nilai `<input type="datetime-local">` ("2026-10-20T08:00") yang
 * ditafsirkan dalam zona waktu tenant menjadi ISO UTC.
 */
export function zonedLocalToIso(local: string, timeZone: string = DEFAULT_TIMEZONE): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second = "00"] = match;
  const naiveUtc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  if (!Number.isFinite(naiveUtc)) return null;
  let offset = zoneOffsetMs(new Date(naiveUtc), timeZone);
  let timestamp = naiveUtc - offset;
  offset = zoneOffsetMs(new Date(timestamp), timeZone);
  timestamp = naiveUtc - offset;
  const result = new Date(timestamp);
  return Number.isNaN(result.getTime()) ? null : result.toISOString();
}

/** Kebalikan dari `zonedLocalToIso`, untuk mengisi nilai input. */
export function isoToZonedLocal(
  iso: string | null | undefined,
  timeZone: string = DEFAULT_TIMEZONE,
): string {
  const date = toDate(iso);
  if (!date) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: safeZone(timeZone),
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "00";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}`;
}

/** Tanggal (YYYY-MM-DD) di zona waktu tenant. */
export function isoToZonedDate(
  iso: string | null | undefined,
  timeZone: string = DEFAULT_TIMEZONE,
): string {
  return isoToZonedLocal(iso, timeZone).slice(0, 10);
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export function startOfDayIso(iso: string, timeZone: string = DEFAULT_TIMEZONE): string {
  const localDate = isoToZonedDate(iso, timeZone);
  return zonedLocalToIso(`${localDate}T00:00`, timeZone) ?? iso;
}
