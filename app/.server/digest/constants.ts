export const MAX_DIGEST_ATTEMPTS = 3;

/**
 * Digester processing order
 * This defines the order in which digesters are registered and executed.
 * The order matters because some digesters depend on outputs from others.
 *
 * IMPORTANT: Keep this in sync with initialization.ts
 */
export const DIGESTER_ORDER: string[] = [
  // 1. URL Crawler (produces url-crawl-content, url-crawl-screenshot)
  'url-crawl-content',
  'url-crawl-screenshot',
  // 2. Document processors
  'doc-to-markdown',
  'doc-to-screenshot',
  // 3. Audio/Speech
  'speech-recognition',
  'speaker-embedding',
  // 4. Image processors
  'image-ocr',
  'image-captioning',
  // 5. Content summarization (depends on content from above)
  'url-crawl-summary',
  // 6. Tags (depends on content)
  'tags',
  // 7. Search indexing (final stage, depends on all content)
  'search-keyword',
  'search-semantic',
];
