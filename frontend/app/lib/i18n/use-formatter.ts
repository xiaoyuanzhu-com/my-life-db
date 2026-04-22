import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  formatDate,
  formatDateTime,
  formatFileSize,
  formatNumber,
  formatRelativeTime,
  formatSmartTimestamp,
  formatTime,
} from "./format";

/**
 * React hook that returns locale-bound formatters.
 *
 * Components using this will re-render when the UI language changes
 * (because useTranslation subscribes to the language change event).
 */
export function useFormatter() {
  const { i18n } = useTranslation();
  const locale = i18n.language;

  return useMemo(
    () => ({
      dateTime: (v: number | string | Date, o?: Intl.DateTimeFormatOptions) =>
        formatDateTime(v, locale, o),
      date: (v: number | string | Date, o?: Intl.DateTimeFormatOptions) =>
        formatDate(v, locale, o),
      time: (v: number | string | Date, o?: Intl.DateTimeFormatOptions) =>
        formatTime(v, locale, o),
      smartTimestamp: (v: number | string | Date) => formatSmartTimestamp(v, locale),
      relative: (v: number | string | Date) => formatRelativeTime(v, locale),
      number: (v: number, o?: Intl.NumberFormatOptions) => formatNumber(v, locale, o),
      fileSize: (v: number | null | undefined) => formatFileSize(v, locale),
    }),
    [locale],
  );
}
