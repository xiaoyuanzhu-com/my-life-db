/**
 * Text source types for indexed content
 * Shared between server digesters and client renderers
 */

/**
 * Text source types - tracks where indexed text content came from
 */
export type TextSourceType =
  | 'url-crawl-content'    // From URL crawler digest
  | 'doc-to-markdown'      // From document conversion digest
  | 'image-ocr'            // From image OCR digest
  | 'image-captioning'     // From image captioning digest
  | 'speech-recognition'   // From speech recognition digest
  | 'file'                 // From local text file (no digest)
  | 'filename-only';       // No text content, only filename indexed

/**
 * Human-readable labels for text source types
 * These labels should match the digester labels for consistency
 */
export const TEXT_SOURCE_LABELS: Record<TextSourceType, string> = {
  'url-crawl-content': 'URL Crawler',
  'doc-to-markdown': 'Doc to Markdown',
  'image-ocr': 'Image OCR',
  'image-captioning': 'Image Captioning',
  'speech-recognition': 'Speech Recognition',
  'file': 'File Content',
  'filename-only': 'Filename',
};
