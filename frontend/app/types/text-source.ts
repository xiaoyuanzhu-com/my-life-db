/**
 * Text source types for indexed content
 * Shared between server digesters and client renderers
 */

/**
 * Text source types - tracks where indexed text content came from
 */
export type TextSourceType =
  | 'file'                 // From local text file (no digest)
  | 'filename-only';       // No text content, only filename indexed

/**
 * Human-readable labels for text source types
 * These labels should match the digester labels for consistency
 */
export const TEXT_SOURCE_LABELS: Record<TextSourceType, string> = {
  'file': 'File Content',
  'filename-only': 'Filename',
};
