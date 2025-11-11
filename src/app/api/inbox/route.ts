// API route for inbox operations
import { NextRequest, NextResponse } from 'next/server';
import { createInboxItem } from '@/lib/inbox/createItem';
import { listItems } from '@/lib/db/items';
import { listDigestsForItem, getDigestByItemAndType } from '@/lib/db/digests';
import { getInboxTaskStatesByItemId } from '@/lib/db/inboxTaskState';
import { getLogger } from '@/lib/log/logger';
import { getStorageConfig } from '@/lib/config/storage';
import path from 'path';
import fs from 'fs/promises';
import type { Item, InboxEnrichmentSummary, InboxStageStatusSummary, InboxDigestScreenshot } from '@/types';

// Force Node.js runtime (not Edge)
export const runtime = 'nodejs';

// Note: App initialization now happens in instrumentation.ts at server startup

/**
 * Build enrichment summary from item and task states
 */
function buildEnrichmentSummary(itemId: string, itemStatus: string): InboxEnrichmentSummary {
  const taskStates = getInboxTaskStatesByItemId(itemId);

  const stages: InboxStageStatusSummary[] = taskStates.map(ts => ({
    taskType: ts.taskType,
    status: ts.status === 'success' ? 'success' :
            ts.status === 'in-progress' ? 'in-progress' :
            ts.status === 'failed' ? 'failed' : 'to-do',
    attempts: ts.attempts,
    error: ts.error,
    updatedAt: ts.updatedAt ? ts.updatedAt * 1000 : null, // Convert from Unix seconds to milliseconds
  }));

  const completedCount = stages.filter(s => s.status === 'success').length;
  const hasFailures = stages.some(s => s.status === 'failed');

  return {
    inboxId: itemId,
    overall: itemStatus as any,
    stages,
    hasFailures,
    completedCount,
    totalCount: stages.length,
    crawlDone: stages.find(s => s.taskType === 'url-crawl')?.status === 'success' || false,
    summaryDone: stages.find(s => s.taskType === 'summary')?.status === 'success' || false,
    screenshotReady: stages.find(s => s.taskType === 'screenshot')?.status === 'success' || false,
    tagsReady: stages.find(s => s.taskType === 'tags')?.status === 'success' || false,
    slugReady: stages.find(s => s.taskType === 'slug')?.status === 'success' || false,
    canRetry: hasFailures,
  };
}

/**
 * Get primary text from item files
 */
async function getPrimaryText(item: Item): Promise<string | null> {
  const config = await getStorageConfig();
  const dataDir = config.dataPath;

  // For single-file items, read the file directly if it's a text file
  if (!item.isFolder && item.files && item.files.length === 1) {
    const file = item.files[0];
    if (file.type.startsWith('text/') || file.type === 'application/json') {
      try {
        const filePath = path.join(dataDir, item.path);
        const content = await fs.readFile(filePath, 'utf-8');
        return content;
      } catch {
        return null;
      }
    }
  }

  // For multi-file items, check for text.md file
  if (item.isFolder) {
    const textFile = item.files?.find(f => f.name === 'text.md');
    if (textFile) {
      try {
        const filePath = path.join(dataDir, item.path, 'text.md');
        const content = await fs.readFile(filePath, 'utf-8');
        return content;
      } catch {
        return null;
      }
    }
  }

  // Check for summary digest
  const summaryDigest = getDigestByItemAndType(item.id, 'summary');
  if (summaryDigest?.content) {
    return summaryDigest.content;
  }

  return null;
}

/**
 * Get screenshot from digests
 */
function getDigestScreenshot(item: Item): InboxDigestScreenshot | null {
  const screenshotDigest = getDigestByItemAndType(item.id, 'screenshot');
  if (screenshotDigest?.sqlarName) {
    return {
      src: `/api/inbox/files/${encodeURIComponent(item.path)}/${encodeURIComponent('screenshot.png')}`,
      mimeType: 'image/png',
      filename: 'screenshot.png',
    };
  }
  return null;
}

/**
 * GET /api/inbox
 * List inbox items
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const status = searchParams.get('status') || undefined;
    const limit = searchParams.get('limit')
      ? parseInt(searchParams.get('limit')!)
      : 50;
    const offset = searchParams.get('offset')
      ? parseInt(searchParams.get('offset')!)
      : 0;

    // List items in inbox location
    const items = listItems({ location: 'inbox', status, limit, offset });

    // Build enriched items for UI
    const enrichedItems = await Promise.all(items.map(async (item) => {
      const enrichment = buildEnrichmentSummary(item.id, item.status);
      const primaryText = await getPrimaryText(item);
      const digestScreenshot = getDigestScreenshot(item);
      const slugDigest = getDigestByItemAndType(item.id, 'slug');

      return {
        id: item.id,
        folderName: item.name,
        type: item.rawType,
        files: item.files || [],
        status: item.status,
        enrichedAt: null,
        error: null,
        aiSlug: slugDigest?.content || null,
        schemaVersion: item.schemaVersion,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        enrichment,
        primaryText,
        digestScreenshot,
      };
    }));

    return NextResponse.json({
      items: enrichedItems,
      total: items.length,
    });
  } catch (error) {
    log.error({ err: error }, 'list inbox items failed');
    return NextResponse.json(
      { error: 'Failed to list inbox items' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/inbox
 * Create a new inbox item
 */
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const text = formData.get('text') as string | null;
    const fileEntries = formData.getAll('files') as File[];

    // Validation
    if (!text && fileEntries.length === 0) {
      return NextResponse.json(
        { error: 'Either text or files must be provided' },
        { status: 400 }
      );
    }

    // Process uploaded files
    const files = [];
    for (const file of fileEntries) {
      const bytes = await file.arrayBuffer();
      const buffer = Buffer.from(bytes);

      files.push({
        buffer,
        filename: file.name,
        mimeType: file.type,
        size: file.size,
      });
    }

    // Create inbox item
    const item = await createInboxItem({
      text: text || undefined,
      files,
    });

    log.info({ itemId: item.id, path: item.path }, 'created inbox item');

    return NextResponse.json(item, { status: 201 });
  } catch (error) {
    log.error({ err: error }, 'create inbox item failed');
    return NextResponse.json(
      {
        error: 'Failed to create inbox item',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

const log = getLogger({ module: 'ApiInbox' });
