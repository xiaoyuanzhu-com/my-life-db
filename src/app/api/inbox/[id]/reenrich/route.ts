import { NextRequest, NextResponse } from 'next/server';
export const runtime = 'nodejs';

import { getFileByPath } from '@/lib/db/files';
import { enqueueUrlEnrichment } from '@/lib/inbox/enrich-url-inbox-item';
import { enqueueUrlSummary } from '@/lib/inbox/summarize-url-inbox-item';
import { enqueueUrlTagging } from '@/lib/inbox/tag-url-inbox-item';
import { enqueueUrlSlug } from '@/lib/inbox/slug-url-inbox-item';
import { getStorageConfig } from '@/lib/config/storage';
import path from 'path';
import { promises as fs } from 'fs';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'ApiInboxReenrich' });

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/inbox/[id]/reenrich?stage=crawl|summary|all
 * Re-enrich an inbox item with AI digests
 */
export async function POST(
  request: NextRequest,
  context: RouteContext
) {
  try {
    const { id } = await context.params;
    const filePath = `inbox/${id}`;
    const searchParams = request.nextUrl.searchParams;
    const stage = (searchParams.get('stage') || 'all').toLowerCase();

    const file = getFileByPath(filePath);
    if (!file) {
      return NextResponse.json({ error: 'Inbox item not found' }, { status: 404 });
    }

    const actions: Array<{ stage: string; taskId: string | null; note?: string }> = [];

    // Helper to read files from inbox item directory
    const storageConfig = await getStorageConfig();
    const baseDir = path.join(storageConfig.dataPath, filePath);

    async function readFileIfExists(name: string): Promise<string | null> {
      const variants = new Set<string>();
      variants.add(name);
      if (!name.includes('/') && !name.startsWith('digest/')) {
        variants.add(`digest/${name}`);
      }

      for (const variant of variants) {
        try {
          const p = path.join(baseDir, variant);
          const s = await fs.readFile(p, 'utf-8');
          return s;
        } catch {
          // Continue to next variant
        }
      }
      return null;
    }

    function firstUrlFromText(text: string | null): string | null {
      if (!text) return null;
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const urlLike = lines.find((l) => /^https?:\/\//i.test(l));
      return urlLike || null;
    }

    // Try to find URL for crawl stage
    if (stage === 'crawl' || stage === 'all') {
      // Try url.txt, then fall back to first URL-like line in text files
      const urlTxt = await readFileIfExists('url.txt');
      let url = (urlTxt || '').trim();
      if (!url) {
        const textMd = await readFileIfExists('text.md');
        url = firstUrlFromText(textMd) || '';
      }
      if (!url) {
        const contentMd = await readFileIfExists('content.md');
        url = firstUrlFromText(contentMd) || '';
      }
      if (!url) {
        const mainContent = await readFileIfExists('main-content.md');
        url = firstUrlFromText(mainContent) || '';
      }

      if (url) {
        const taskId = enqueueUrlEnrichment(filePath, url);
        actions.push({ stage: 'crawl', taskId });
      } else if (stage === 'crawl') {
        log.warn({ filePath }, 'url not found for crawl stage');
        return NextResponse.json({ error: 'URL not found for crawl stage' }, { status: 400 });
      }
    }

    // Summary stage (requires URL content to exist)
    if (stage === 'summary' || stage === 'all') {
      const taskId = enqueueUrlSummary(filePath);
      actions.push({ stage: 'summary', taskId });
    }

    // Tagging stage
    if (stage === 'tagging' || stage === 'all') {
      const taskId = enqueueUrlTagging(filePath);
      actions.push({ stage: 'tagging', taskId });
    }

    // Slug stage
    if (stage === 'slug' || stage === 'all') {
      const taskId = enqueueUrlSlug(filePath);
      actions.push({ stage: 'slug', taskId });
    }

    if (actions.length === 0) {
      return NextResponse.json({ error: 'No supported reenrich actions for this item/stage' }, { status: 400 });
    }

    return NextResponse.json({ success: true, actions });
  } catch (error) {
    log.error({ err: error }, 'reenrich inbox item failed');
    return NextResponse.json({ error: 'Failed to reenrich inbox item' }, { status: 500 });
  }
}
