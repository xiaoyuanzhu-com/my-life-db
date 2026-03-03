/**
 * Text source types for indexed content
 * Shared between server digesters and client renderers
 */

/**
 * Text source types - tracks where indexed text content came from
 */
export type TextSourceType =
  | 'speech-recognition'   // From speech recognition digest
  | 'file'                 // From local text file (no digest)
  | 'filename-only';       // No text content, only filename indexed

/**
 * Human-readable labels for text source types
 * These labels should match the digester labels for consistency
 */
export const TEXT_SOURCE_LABELS: Record<TextSourceType, string> = {
  'speech-recognition': 'Speech Recognition',
  'file': 'File Content',
  'filename-only': 'Filename',
};

/**
 * Summary source types - tracks which digester produced the summary
 */
export type SummarySourceType = 'speech-recognition-summary';

/**
 * Human-readable labels for summary source types
 */
export const SUMMARY_SOURCE_LABELS: Record<SummarySourceType, string> = {
  'speech-recognition-summary': 'Speech Recognition Summary',
};
