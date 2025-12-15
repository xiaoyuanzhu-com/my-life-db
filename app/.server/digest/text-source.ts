/**
 * Helper utilities for working with digest text sources
 */

import { promises as fs } from 'fs';
import path from 'path';
import type { Digest, FileRecordRow } from '~/types';
import { isTextFile } from '~/lib/file-types';
import { getLogger } from '~/.server/log/logger';

const log = getLogger({ module: 'DigestTextSource' });

const DATA_ROOT = process.env.MY_DATA_DIR || './data';

export type TextSourceType = 'url-digest' | 'doc-to-markdown' | 'image-ocr' | 'image-captioning' | 'speech-recognition' | 'file';

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    log.warn({ error }, 'failed to parse digest JSON payload');
    return null;
  }
}

function extractUrlCrawlMarkdown(digest: Digest | undefined): string | null {
  if (!digest?.content) return null;
  const parsed = parseJson<{ markdown?: string }>(digest.content);
  if (parsed?.markdown) {
    return parsed.markdown;
  }
  return digest.content;
}

export function getSummaryText(existingDigests: Digest[]): string | null {
  const summaryDigest =
    existingDigests.find((d) => d.digester === 'url-crawl-summary') ||
    existingDigests.find((d) => d.digester === 'summarize');

  if (!summaryDigest?.content) return null;
  const parsed = parseJson<{ summary?: string }>(summaryDigest.content);
  return parsed?.summary ?? summaryDigest.content;
}

export function getDocToMarkdown(existingDigests: Digest[]): string | null {
  const digest = existingDigests.find(
    (d) => d.digester === 'doc-to-markdown' && d.status === 'completed'
  );
  return digest?.content ?? null;
}

export function getImageOcrText(existingDigests: Digest[]): string | null {
  const digest = existingDigests.find(
    (d) => d.digester === 'image-ocr' && d.status === 'completed'
  );
  return digest?.content ?? null;
}

export function hasImageOcrContent(existingDigests: Digest[], minLength = 0): boolean {
  const text = getImageOcrText(existingDigests);
  return text ? text.trim().length >= minLength : false;
}

export function getImageCaptioningText(existingDigests: Digest[]): string | null {
  const digest = existingDigests.find(
    (d) => d.digester === 'image-captioning' && d.status === 'completed'
  );
  return digest?.content ?? null;
}

export function hasImageCaptioningContent(existingDigests: Digest[], minLength = 0): boolean {
  const text = getImageCaptioningText(existingDigests);
  return text ? text.trim().length >= minLength : false;
}

export function getSpeechRecognitionText(existingDigests: Digest[]): string | null {
  const digest = existingDigests.find(
    (d) => d.digester === 'speech-recognition' && d.status === 'completed'
  );
  if (!digest?.content) return null;

  // Parse transcript JSON to extract plain text
  const parsed = parseJson<{ segments?: Array<{ text: string }> }>(digest.content);
  if (parsed?.segments) {
    return parsed.segments.map((s) => s.text).join(' ');
  }
  return digest.content;
}

export function hasSpeechRecognitionContent(existingDigests: Digest[], minLength = 0): boolean {
  const text = getSpeechRecognitionText(existingDigests);
  return text ? text.trim().length >= minLength : false;
}

export function getUrlCrawlMarkdown(existingDigests: Digest[]): string | null {
  const digest = existingDigests.find(
    (d) => d.digester === 'url-crawl-content' && d.status === 'completed'
  );
  return extractUrlCrawlMarkdown(digest);
}

export function hasUrlCrawlContent(existingDigests: Digest[], minLength = 0): boolean {
  const markdown = getUrlCrawlMarkdown(existingDigests);
  return markdown ? markdown.trim().length >= minLength : false;
}

export function hasLocalTextContent(file: FileRecordRow, _minBytes = 0): boolean {
  if (file.is_folder) return false;
  // Use shared utility for consistent text file detection
  return isTextFile(file.mime_type, path.basename(file.path));
}

export function hasDocToMarkdownContent(existingDigests: Digest[], minLength = 0): boolean {
  const markdown = getDocToMarkdown(existingDigests);
  return markdown ? markdown.trim().length >= minLength : false;
}

export function hasAnyTextSource(
  file: FileRecordRow,
  existingDigests: Digest[],
  options?: { minUrlLength?: number; minFileBytes?: number }
): boolean {
  if (hasUrlCrawlContent(existingDigests, options?.minUrlLength ?? 0)) {
    return true;
  }
  if (hasDocToMarkdownContent(existingDigests, options?.minUrlLength ?? 0)) {
    return true;
  }
  if (hasImageOcrContent(existingDigests, options?.minUrlLength ?? 0)) {
    return true;
  }
  if (hasImageCaptioningContent(existingDigests, options?.minUrlLength ?? 0)) {
    return true;
  }
  if (hasSpeechRecognitionContent(existingDigests, options?.minUrlLength ?? 0)) {
    return true;
  }
  return hasLocalTextContent(file, options?.minFileBytes ?? 0);
}

async function readLocalFile(filePath: string): Promise<string | null> {
  try {
    const value = await fs.readFile(path.join(DATA_ROOT, filePath), 'utf-8');
    return value;
  } catch (error) {
    log.warn({ filePath, error }, 'failed to read text file');
    return null;
  }
}

export async function getPrimaryTextContent(
  filePath: string,
  file: FileRecordRow,
  existingDigests: Digest[]
): Promise<{ text: string; source: TextSourceType } | null> {
  // 1. URL crawl content (highest priority for URLs)
  const fromUrlDigest = getUrlCrawlMarkdown(existingDigests);
  if (fromUrlDigest) {
    return { text: fromUrlDigest, source: 'url-digest' };
  }

  // 2. Document to markdown (for PDFs, DOCX, etc.)
  const fromDocDigest = getDocToMarkdown(existingDigests);
  if (fromDocDigest) {
    return { text: fromDocDigest, source: 'doc-to-markdown' };
  }

  // 3. Image OCR (primary for images)
  const fromOcr = getImageOcrText(existingDigests);
  if (fromOcr) {
    return { text: fromOcr, source: 'image-ocr' };
  }

  // 4. Image captioning (fallback for images without OCR text)
  const fromCaptioning = getImageCaptioningText(existingDigests);
  if (fromCaptioning) {
    return { text: fromCaptioning, source: 'image-captioning' };
  }

  // 5. Speech recognition (for audio/video)
  const fromSpeech = getSpeechRecognitionText(existingDigests);
  if (fromSpeech) {
    return { text: fromSpeech, source: 'speech-recognition' };
  }

  // 6. Local file content (for text files)
  if (!file.is_folder && hasLocalTextContent(file)) {
    const text = await readLocalFile(filePath);
    if (text) {
      return { text, source: 'file' };
    }
  }

  return null;
}
