// Slug generation utilities for entry directories

/**
 * Convert a title to a URL-safe slug
 * @param title - The title to slugify
 * @param maxLength - Maximum length of the slug (default: 60)
 * @returns URL-safe slug
 *
 * @example
 * generateSlug("Deep Work Session Notes") // "deep-work-session-notes"
 * generateSlug("Meeting w/ John @ 3pm") // "meeting-w-john-3pm"
 * generateSlug("Quick thought 💭") // "quick-thought"
 */
export function generateSlug(title: string, maxLength: number = 60): string {
  return title
    .toLowerCase()
    .trim()
    // Replace spaces and special chars with hyphens
    .replace(/[^a-z0-9]+/g, '-')
    // Remove leading/trailing hyphens
    .replace(/^-+|-+$/g, '')
    // Limit length
    .substring(0, maxLength)
    // Remove trailing hyphen if substring cut in middle
    .replace(/-$/g, '');
}

/**
 * Format a Date object as YYYY-MM-DD
 * @param date - Date to format
 * @returns Date string in YYYY-MM-DD format
 */
export function formatDateForDirectory(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Parse YYYY-MM-DD string to Date
 * @param dateStr - Date string in YYYY-MM-DD format
 * @returns Date object
 */
export function parseDateFromDirectory(dateStr: string): Date {
  return new Date(dateStr);
}

/**
 * Extract date from a directory path
 * @param dirPath - Path like "inbox/2025-10-15/uuid"
 * @returns Date string in YYYY-MM-DD format or null
 */
export function extractDateFromPath(dirPath: string): string | null {
  const match = dirPath.match(/(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}
