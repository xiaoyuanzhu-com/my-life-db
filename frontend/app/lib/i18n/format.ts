/**
 * Locale-aware formatters.
 *
 * Every function accepts an optional `locale` argument. If omitted, the
 * current i18n.language is used (which mirrors document.documentElement.lang).
 *
 * Prefer `useFormatter()` inside React components — it pre-binds locale so
 * the component re-renders when the user changes UI language.
 */

import i18n from "~/lib/i18n/config";

function currentLocale(): string {
  return i18n.language || "en";
}

function toDate(value: number | string | Date): Date {
  if (value instanceof Date) return value;
  return new Date(value);
}

/**
 * Format a date + time in the active locale.
 * Default style: medium date + short time (e.g. "Apr 22, 2026, 3:04 PM" / "2026年4月22日 15:04").
 */
export function formatDateTime(
  value: number | string | Date,
  locale?: string,
  options?: Intl.DateTimeFormatOptions,
): string {
  const opts: Intl.DateTimeFormatOptions = options ?? {
    dateStyle: "medium",
    timeStyle: "short",
  };
  return new Intl.DateTimeFormat(locale ?? currentLocale(), opts).format(toDate(value));
}

/**
 * Format a date only in the active locale (medium style by default).
 */
export function formatDate(
  value: number | string | Date,
  locale?: string,
  options?: Intl.DateTimeFormatOptions,
): string {
  const opts: Intl.DateTimeFormatOptions = options ?? { dateStyle: "medium" };
  return new Intl.DateTimeFormat(locale ?? currentLocale(), opts).format(toDate(value));
}

/**
 * Format a time-of-day only (short style by default — e.g. "3:04 PM" / "15:04").
 */
export function formatTime(
  value: number | string | Date,
  locale?: string,
  options?: Intl.DateTimeFormatOptions,
): string {
  const opts: Intl.DateTimeFormatOptions = options ?? { timeStyle: "short" };
  return new Intl.DateTimeFormat(locale ?? currentLocale(), opts).format(toDate(value));
}

/**
 * Smart timestamp — "HH:mm" today / "Yesterday HH:mm" / "MMM d, HH:mm"
 * Uses Intl.RelativeTimeFormat for the "yesterday" bucket and falls back
 * to an absolute medium date for older.
 * Uses local midnight comparison (dayDiff) — not a 1440-minute rolling window.
 */
export function formatSmartTimestamp(
  value: number | string | Date,
  locale?: string,
): string {
  const lang = locale ?? currentLocale();
  const d = toDate(value);
  const now = new Date();

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfTarget = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayDiff = Math.round(
    (startOfTarget.getTime() - startOfToday.getTime()) / (24 * 60 * 60 * 1000),
  );

  const timeFmt = new Intl.DateTimeFormat(lang, { timeStyle: "short" });

  if (dayDiff === 0) {
    return timeFmt.format(d);
  }
  if (dayDiff === -1) {
    const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
    // "yesterday" / "昨天" — then append time
    return `${rtf.format(-1, "day")} ${timeFmt.format(d)}`;
  }
  return new Intl.DateTimeFormat(lang, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

/**
 * Relative time — "3 minutes ago", "in 2 days", "3分钟前", etc.
 */
export function formatRelativeTime(
  value: number | string | Date,
  locale?: string,
): string {
  const lang = locale ?? currentLocale();
  const d = toDate(value);
  const diffSeconds = Math.round((d.getTime() - Date.now()) / 1000);
  const abs = Math.abs(diffSeconds);

  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });

  if (abs < 60) return rtf.format(diffSeconds, "second");
  if (abs < 3600) return rtf.format(Math.round(diffSeconds / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diffSeconds / 3600), "hour");
  if (abs < 2592000) return rtf.format(Math.round(diffSeconds / 86400), "day");
  if (abs < 31536000) return rtf.format(Math.round(diffSeconds / 2592000), "month");
  return rtf.format(Math.round(diffSeconds / 31536000), "year");
}

/**
 * Locale-aware number formatting (thousands separators, etc.).
 */
export function formatNumber(
  value: number,
  locale?: string,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(locale ?? currentLocale(), options).format(value);
}

/**
 * File size with base-1024 units. Locale-aware number portion (decimals, separators).
 * Returns e.g. "1.23 MB" or "1,23 MB" in de-DE.
 * Passing null/undefined returns "—".
 */
export function formatFileSize(bytes: number | null | undefined, locale?: string): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes === 0) return `0 B`;
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  const decimals = i === 0 ? 0 : 2;
  const num = formatNumber(value, locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `${num} ${units[i]}`;
}
