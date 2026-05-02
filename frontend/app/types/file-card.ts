/**
 * Unified file model for UI components
 * Pure data from database - no computed fields
 *
 * Note: the type name is preserved for compatibility with the many existing
 * imports across the FileCard subsystem; the digest-system fields it used
 * to expose have been removed.
 */

/**
 * File metadata - ground truth from database
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
  modifiedAt: number;
  createdAt: number;

  // Optional text preview (truncated, for inbox/search list views)
  textPreview?: string;

  // Preview SQLAR path (cached for fast inbox rendering)
  previewSqlar?: string;

  // Pin status (from pins table)
  isPinned?: boolean;

  // Local-only: blob URL for pending uploads (not yet on server)
  // When present, use this instead of /raw/{path} for content
  blobUrl?: string;
}
