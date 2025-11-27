/**
 * Helper utilities for working with digest text sources
 */

import { promises as fs } from 'fs';
import path from 'path';
import type { Digest, FileRecordRow } from '@/types';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'DigestTextSource' });

const DATA_ROOT = process.env.MY_DATA_DIR || './data';

const EXTRA_TEXT_MIME_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-javascript',
  'application/x-sh',
  'application/sql',
]);

const TEXT_EXTENSIONS = new Set([
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

export type TextSourceType = 'url-digest' | 'doc-to-markdown' | 'file';

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

function isTextMimeType(mime: string | null): boolean {
  if (!mime) return false;
  const normalized = mime.toLowerCase();
  if (normalized.startsWith('text/')) return true;
  return EXTRA_TEXT_MIME_TYPES.has(normalized);
}

function hasTextExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

export function hasLocalTextContent(file: FileRecordRow, _minBytes = 0): boolean {
  if (file.is_folder) return false;
  const textLike =
    (file.mime_type ? isTextMimeType(file.mime_type) : false) ||
    hasTextExtension(file.path);
  if (!textLike) return false;
  // Allow any size - even empty files should be processed
  return true;
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
  const urlCrawl = hasUrlCrawlContent(existingDigests, options?.minUrlLength ?? 0);
  if (urlCrawl) {
    log.info({ filePath: file.path }, 'hasAnyTextSource: TRUE from url-crawl-content');
    return true;
  }

  const docToMd = hasDocToMarkdownContent(existingDigests, options?.minUrlLength ?? 0);
  if (docToMd) {
    log.info({ filePath: file.path }, 'hasAnyTextSource: TRUE from doc-to-markdown');
    return true;
  }

  const localText = hasLocalTextContent(file, options?.minFileBytes ?? 0);
  log.info({ filePath: file.path, hasUrlCrawl: urlCrawl, hasDocToMd: docToMd, hasLocalText: localText },
    `hasAnyTextSource: ${localText ? 'TRUE from local text' : 'FALSE - no text source found'}`);
  return localText;
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
  const fromUrlDigest = getUrlCrawlMarkdown(existingDigests);
  if (fromUrlDigest) {
    return { text: fromUrlDigest, source: 'url-digest' };
  }

  const fromDocDigest = getDocToMarkdown(existingDigests);
  if (fromDocDigest) {
    return { text: fromDocDigest, source: 'doc-to-markdown' };
  }

  if (!file.is_folder && hasLocalTextContent(file)) {
    const text = await readLocalFile(filePath);
    if (text) {
      return { text, source: 'file' };
    }
  }

  return null;
}
