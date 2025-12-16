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
 */
export const TEXT_SOURCE_LABELS: Record<TextSourceType, string> = {
  'url-crawl-content': 'Crawled Content',
  'doc-to-markdown': 'Document Text',
  'image-ocr': 'OCR Text',
  'image-captioning': 'Image Caption',
  'speech-recognition': 'Transcript',
  'file': 'File Content',
  'filename-only': 'Filename',
};
