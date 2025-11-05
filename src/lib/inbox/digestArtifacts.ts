import 'server-only';

import fs from 'fs/promises';
import path from 'path';

import { INBOX_DIR } from '@/lib/fs/storage';

async function readFileIfExists(folderName: string, relativePath: string): Promise<Buffer | null> {
  try {
    const filePath = path.join(INBOX_DIR, folderName, relativePath);
    return await fs.readFile(filePath);
  } catch {
    return null;
  }
}

export async function readInboxPrimaryText(folderName: string): Promise<string | null> {
  const candidates = [
    'text.md',
    'note.md',
    'notes.md',
    'content.md',
    'main-content.md',
    'url.txt',
  ];

  for (const name of candidates) {
    const file = await readFileIfExists(folderName, name);
    if (!file) continue;
    const content = file.toString('utf-8').trim();
    if (content.length > 0) return content;
  }

  return null;
}

export async function readInboxDigestSummary(folderName: string): Promise<string | null> {
  const file = await readFileIfExists(folderName, 'digest/summary.md');
  if (!file) return null;

  const content = file.toString('utf-8').trim();
  return content.length > 0 ? content : null;
}

export async function readInboxDigestTags(folderName: string): Promise<string[] | null> {
  const file = await readFileIfExists(folderName, 'digest/tags.json');
  if (!file) return null;

  try {
    const parsed = JSON.parse(file.toString('utf-8')) as { tags?: unknown };
    if (!Array.isArray(parsed.tags)) return null;

    const cleaned = parsed.tags
      .map(tag => (typeof tag === 'string' ? tag.trim() : ''))
      .filter(tag => tag.length > 0);

    return cleaned.length > 0 ? cleaned : null;
  } catch {
    return null;
  }
}

export interface InboxDigestScreenshot {
  src: string;
  mimeType: string;
  filename: string;
}

export async function readInboxDigestScreenshot(folderName: string): Promise<InboxDigestScreenshot | null> {
  const candidates: Array<{ name: string; mimeType: string }> = [
    { name: 'digest/screenshot.png', mimeType: 'image/png' },
    { name: 'digest/screenshot.jpg', mimeType: 'image/jpeg' },
    { name: 'digest/screenshot.jpeg', mimeType: 'image/jpeg' },
    { name: 'digest/screenshot.webp', mimeType: 'image/webp' },
  ];

  for (const candidate of candidates) {
    const file = await readFileIfExists(folderName, candidate.name);
    if (!file) continue;

    const base64 = file.toString('base64');
    return {
      filename: candidate.name,
      mimeType: candidate.mimeType,
      src: `data:${candidate.mimeType};base64,${base64}`,
    };
  }

  return null;
}
