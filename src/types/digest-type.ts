/**
 * Digest Type - identifies what kind of AI-generated content
 *
 * Values:
 * - summary: AI-generated text summary
 * - tags: AI-generated tags (stored as JSON array)
 * - slug: URL-friendly slug + title (stored as JSON object)
 * - content-md: Extracted/crawled content in Markdown format
 * - content-html: Extracted/crawled content in HTML format (stored in SQLAR)
 * - screenshot: Screenshot image (stored in SQLAR)
 */
export type DigestType = 'summary' | 'tags' | 'slug' | 'content-md' | 'content-html' | 'screenshot';
