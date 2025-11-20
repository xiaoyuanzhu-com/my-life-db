// API route for inbox operations
import { NextRequest, NextResponse } from 'next/server';
import { saveToInbox } from '@/lib/inbox/save-to-inbox';
import { listFilesWithDigests } from '@/lib/db/files-with-digests';
import { readPrimaryText } from '@/lib/inbox/digest-artifacts';
import { processFileDigests } from '@/lib/digest/task-handler';
import { getLogger } from '@/lib/log/logger';
import { notificationService } from '@/lib/notifications/notification-service';
import type { FileWithDigests } from '@/types/file-card';

// Force Node.js runtime (not Edge)
export const runtime = 'nodejs';

const log = getLogger({ module: 'ApiInbox' });

// Note: App initialization now happens in instrumentation.ts at server startup

export interface InboxItem extends FileWithDigests {
  textPreview?: string;
}

export interface InboxResponse {
  items: InboxItem[];
  total: number;
}

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

    // List files with digests in inbox directory
    // Only fetch screenshot digests (exclude content-md, summary, tags, slug)
    const allFiles = listFilesWithDigests('inbox/', {
      orderBy: 'created_at',
      ascending: false,
      digesters: ['screenshot'],  // Only include screenshot for image preview
    });

    // Filter to only top-level entries (inbox/foo.jpg or inbox/folder, NOT inbox/folder/file.jpg)
    const topLevelFiles = allFiles.filter(file => {
      const relativePath = file.path.replace(/^inbox\//, '');
      // Top-level if: no slashes (file) OR is a folder with no additional path segments
      return !relativePath.includes('/') || (file.isFolder && relativePath.split('/').length === 1);
    });

    // Apply pagination after filtering
    const paginatedFiles = topLevelFiles.slice(offset, offset + limit);

    // Enrich with text preview (truncated for performance)
    const items = await Promise.all(
      paginatedFiles.map(async (file) => {
        const primaryText = await readPrimaryText(file.path);

        // Return first 60 lines (50 to show + 10 buffer) for preview
        const textPreview = primaryText
          ? primaryText.split('\n').slice(0, 60).join('\n')
          : undefined;

        return {
          ...file,
          textPreview,
        };
      })
    );

    const response: InboxResponse = {
      items,
      total: topLevelFiles.length,
    };

    return NextResponse.json(response);
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

    // Emit notification event
    const firstFile = result.files[0];
    notificationService.notify({
      type: 'inbox-created',
      path: result.path,
      timestamp: new Date().toISOString(),
      metadata: firstFile ? {
        name: firstFile.name,
        size: firstFile.size,
        mimeType: firstFile.mimeType,
      } : undefined,
    });

    // Auto-start digest processing (fire and forget - runs in background)
    processFileDigests(result.path).catch(error => {
      log.error({ path: result.path, error }, 'digest processing failed');
    });
    log.info({ path: result.path }, 'auto-started digest processing');

    return NextResponse.json({
      path: result.path,
    }, { status: 201 });
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
