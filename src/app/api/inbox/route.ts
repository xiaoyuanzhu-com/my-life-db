// API route for inbox operations
import { NextRequest, NextResponse } from 'next/server';
import { saveToInbox } from '@/lib/inbox/saveToInbox';
import { listFiles, getFileByPath } from '@/lib/db/files';
import { readPrimaryText, readDigestSlug, readDigestScreenshot } from '@/lib/inbox/digestArtifacts';
import { getDigestStatusView } from '@/lib/inbox/statusView';
import { getLogger } from '@/lib/log/logger';
import type { InboxDigestScreenshot } from '@/types';

// Force Node.js runtime (not Edge)
export const runtime = 'nodejs';

// Note: App initialization now happens in instrumentation.ts at server startup

/**
 * GET /api/inbox
 * List inbox items
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const limit = searchParams.get('limit')
      ? parseInt(searchParams.get('limit')!)
      : 50;
    const offset = searchParams.get('offset')
      ? parseInt(searchParams.get('offset')!)
      : 0;

    // List files in inbox directory
    const allFiles = listFiles('inbox/', { orderBy: 'created_at', ascending: false });

    // Filter to only top-level entries (inbox/foo.jpg or inbox/folder, NOT inbox/folder/file.jpg)
    const topLevelFiles = allFiles.filter(file => {
      const relativePath = file.path.replace(/^inbox\//, '');
      // Top-level if: no slashes (file) OR is a folder with no additional path segments
      return !relativePath.includes('/') || (file.isFolder && relativePath.split('/').length === 1);
    });

    // Apply pagination after filtering
    const files = topLevelFiles.slice(offset, offset + limit);

    // Build enriched items for UI
    const enrichedItems = await Promise.all(files.map(async (file) => {
      const enrichment = getDigestStatusView(file.path);
      const primaryText = await readPrimaryText(file.path);
      const digestScreenshot = await readDigestScreenshot(file.path);
      const slugData = await readDigestSlug(file.path);

      return {
        path: file.path,
        folderName: file.name,
        type: file.mimeType || 'unknown',
        files: [], // Files are on disk, not in database
        status: enrichment?.overall || 'pending',
        enrichedAt: null,
        error: null,
        slug: slugData?.slug || null,
        createdAt: file.createdAt,
        updatedAt: file.modifiedAt,
        enrichment,
        primaryText,
        digestScreenshot,
      };
    }));

    return NextResponse.json({
      items: enrichedItems,
      total: topLevelFiles.length,
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

    // Save to inbox
    const result = await saveToInbox({
      text: text || undefined,
      files,
    });

    log.info({ path: result.path }, 'created inbox item');

    return NextResponse.json({ path: result.path }, { status: 201 });
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
