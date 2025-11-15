/**
 * Unified file model for UI components
 * Pure data from database - no computed fields
 */

/**
 * Digest summary (minimal info from digests table)
 */
export interface DigestSummary {
  type: string; // 'summary', 'tags', 'slug', 'screenshot', 'content-md'
  status: 'pending' | 'enriching' | 'enriched' | 'failed';
  content: string | null; // Text content (summary, JSON for tags/slug)
  sqlarName: string | null; // Filename in SQLAR (for binary digests)
  error: string | null;
  updatedAt: string;
}

/**
 * File with digests - ground truth from database
 * Used by both inbox and search UIs
 */
export interface FileWithDigests {
  // From files table (core metadata)
  path: string; // e.g., 'inbox/uuid-folder' or 'notes/meeting.md'
  name: string; // Filename or folder name
  isFolder: boolean;
  size: number | null; // null for folders
  mimeType: string | null; // null for folders
  hash: string | null; // SHA256 for small files
  modifiedAt: string; // ISO date
  createdAt: string; // ISO date

  // Digests array (from digests table)
  digests: DigestSummary[];

  // Optional text preview (truncated, for inbox/search list views)
  textPreview?: string;
}
