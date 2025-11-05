import { NextRequest, NextResponse } from 'next/server';
export const runtime = 'nodejs';

import path from 'path';
import { promises as fs } from 'fs';
import { createHash } from 'crypto';
import { INBOX_DIR } from '@/lib/fs/storage';
import { getInboxItemById, updateInboxItem } from '@/lib/db/inbox';
import type { InboxFile, MessageType, FileType } from '@/types';
import { normalizeWithAI } from '@/lib/inbox/normalizer/ai';
import { isAIAvailable } from '@/lib/ai/provider';
import { enqueuePostIndex } from '@/lib/inbox/postIndexEnricher';
import { readInboxDigestSummary, readInboxDigestTags, readInboxDigestScreenshot, readInboxDigestSlug } from '@/lib/inbox/digestArtifacts';
import { getInboxStatusView } from '@/lib/inbox/statusView';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'ApiInboxDigest' });

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(
  request: NextRequest,
  context: RouteContext
) {
  try {
    const { id } = await context.params;
    const item = getInboxItemById(id);
    if (!item) {
      return NextResponse.json({ error: 'Inbox item not found' }, { status: 404 });
    }

    const [summary, tags, screenshot, slug, status] = await Promise.all([
      readInboxDigestSummary(item.folderName),
      readInboxDigestTags(item.folderName),
      readInboxDigestScreenshot(item.folderName),
      readInboxDigestSlug(item.folderName),
      getInboxStatusView(item.id),
    ]);

    return NextResponse.json({
      success: true,
      summary,
      tags,
      screenshot,
      slug,
      status,
    });
  } catch (error) {
    log.error({ err: error }, 'get inbox digest failed');
    return NextResponse.json({ error: 'Failed to fetch inbox digest' }, { status: 500 });
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const item = getInboxItemById(id);
    if (!item) {
      return NextResponse.json({ error: 'Inbox item not found' }, { status: 404 });
    }

    const folderPath = path.join(INBOX_DIR, item.folderName);
    // Ensure folder exists
    try {
      await fs.access(folderPath);
    } catch {
      return NextResponse.json({ error: 'Inbox folder missing on disk' }, { status: 404 });
    }

    // Read folder contents (allow digest subdirectory)
    const inboxFiles: InboxFile[] = [];
    const textSamples: Record<string, string> = {};
    let metadataObj: unknown = undefined;

    const diskFiles: Array<{ relativePath: string; absolutePath: string }> = [];
    let unsupportedSubdir = false;

    async function collectFiles(currentAbs: string, currentRel: string): Promise<void> {
      const entries = await fs.readdir(currentAbs, { withFileTypes: true });
      for (const entry of entries) {
        const nextAbs = path.join(currentAbs, entry.name);
        const nextRel = currentRel ? `${currentRel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (currentRel === '' && entry.name === 'digest') {
            await collectFiles(nextAbs, nextRel);
          } else {
            unsupportedSubdir = true;
            return;
          }
        } else {
          diskFiles.push({ relativePath: nextRel, absolutePath: nextAbs });
        }
      }
    }

    await collectFiles(folderPath, '');

    if (unsupportedSubdir) {
      return NextResponse.json({ error: 'Unsupported folder structure' }, { status: 400 });
    }

    for (const file of diskFiles) {
      const stat = await fs.stat(file.absolutePath);
      const buf = await fs.readFile(file.absolutePath);
      const hash = createHash('sha256').update(buf).digest('hex');
      const mimeType = getMimeType(file.relativePath);
      const fileType = getFileType(mimeType);

      inboxFiles.push({
        filename: file.relativePath,
        size: stat.size,
        mimeType,
        type: fileType,
        hash,
      });

      const lower = file.relativePath.toLowerCase();
      if (lower.endsWith('.md') || lower.endsWith('.txt') || lower.endsWith('.html') || lower.endsWith('.json')) {
        const text = buf.toString('utf-8');
        textSamples[file.relativePath] = text.length > 1000 ? text.slice(0, 1000) : text;
      }
      if (lower === 'metadata.json' || lower === 'digest/metadata.json') {
        try {
          metadataObj = JSON.parse(buf.toString('utf-8'));
        } catch {}
      }
    }

    if (inboxFiles.length === 0) {
      return NextResponse.json({ error: 'No files found in inbox folder' }, { status: 400 });
    }

    // Determine message type (AI preferred)
    let messageType: MessageType = determineMessageType(inboxFiles);
    try {
      if (await isAIAvailable()) {
        const proposal = await normalizeWithAI({
          folderName: item.folderName,
          files: inboxFiles.map(f => ({ filename: f.filename, size: f.size, mimeType: f.mimeType, type: f.type })),
          samples: textSamples,
          metadataJson: metadataObj,
        });
        if (proposal?.normalized?.type) {
          messageType = proposal.normalized.type;
        }
      }
    } catch {}

    // Update DB projection
    updateInboxItem(item.id, {
      files: inboxFiles,
      type: messageType,
      // Do not change id, folderName, or aiSlug here
    });

    // Enqueue post-index enrichment as independent task
    const postIndexTaskId = enqueuePostIndex(item.id);

    return NextResponse.json({ success: true, postIndexTaskId, type: messageType });
  } catch (error) {
    log.error({ err: error }, 'digest inbox item failed');
    return NextResponse.json({ error: 'Failed to digest inbox item' }, { status: 500 });
  }
}

// Helpers (local copy to avoid refactor)
function getFileType(mimeType: string): FileType {
  if (mimeType.startsWith('text/')) return 'text';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType === 'application/pdf') return 'pdf';
  return 'other';
}

function getMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.html': 'text/html',
    '.json': 'application/json',
    '.csv': 'text/csv',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.pdf': 'application/pdf',
  };
  return map[ext] || 'application/octet-stream';
}

function determineMessageType(files: InboxFile[]): MessageType {
  if (files.some((f) => f.filename === 'url.txt')) return 'url';
  if (files.length === 1) {
    const f = files[0];
    if (f.type === 'image') return 'image';
    if (f.type === 'audio') return 'audio';
    if (f.type === 'video') return 'video';
    if (f.type === 'pdf') return 'pdf';
    if (f.type === 'text') return 'text';
  }
  return 'mixed';
}
