import { formatSmartTimestamp } from "~/lib/i18n/format";

/**
 * Format a timestamp as a short display string:
 *   - Today → time only ("3:04 PM")
 *   - Yesterday → "yesterday 3:04 PM"
 *   - Older → "Apr 21, 15:04"
 * Locale-aware. For imperative (non-React) contexts.
 */
export function formatTimestamp(timestamp: number | string | Date): string {
  return formatSmartTimestamp(timestamp);
}
