/**
 * Shared file type detection utilities
 * Used by both frontend and backend for consistent behavior
 */

/**
 * MIME types that are text-like but don't start with 'text/'
 */
export const TEXT_MIME_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-javascript',
  'application/x-sh',
  'application/sql',
]);

/**
 * File extensions that indicate text files
 * (for cases where MIME type detection fails or is inaccurate)
 */
export const TEXT_EXTENSIONS = new Set([
  '.md',
  '.mdx',
  '.markdown',
  '.txt',
  '.log',
  '.json',
  '.yaml',
  '.yml',
  '.csv',
  '.tsv',
]);

/**
 * Check if a file is a text file based on MIME type or extension
 *
 * @param mimeType - The MIME type of the file (can be null)
 * @param filename - The filename (used for extension-based detection)
 * @returns true if the file is considered a text file
 */
export function isTextFile(mimeType: string | null, filename: string): boolean {
  // 1. Check MIME type prefix
  if (mimeType?.startsWith('text/')) return true;

  // 2. Check known text-like MIME types
  if (mimeType && TEXT_MIME_TYPES.has(mimeType.toLowerCase())) return true;

  // 3. Check file extension
  const lastDot = filename.lastIndexOf('.');
  if (lastDot !== -1) {
    const ext = filename.slice(lastDot).toLowerCase();
    if (TEXT_EXTENSIONS.has(ext)) return true;
  }

  return false;
}
