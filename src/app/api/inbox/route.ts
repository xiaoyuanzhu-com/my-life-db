// API route for inbox operations
import { NextRequest, NextResponse } from 'next/server';
import { saveToInbox } from '@/lib/inbox/save-to-inbox';
import { listTopLevelFiles, countTopLevelFiles } from '@/lib/db/files';
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

    // OPTIMIZED: SQL-based filtering and pagination
    // - Filters top-level entries in SQL (not JavaScript)
    // - Applies limit/offset in SQL (not after loading all files)
    // - No digest lookups (not needed for initial render)
    // - Text preview cached in database (no filesystem reads!)
    const files = listTopLevelFiles('inbox/', {
      orderBy: 'created_at',
      ascending: false,
      limit,
      offset,
    });

    // Get total count for pagination
    const total = countTopLevelFiles('inbox/');

    // Convert FileRecord to InboxItem (includes cached textPreview from DB)
    const items: InboxItem[] = files.map((file) => ({
      path: file.path,
      name: file.name,
      isFolder: file.isFolder,
      size: file.size,
      mimeType: file.mimeType,
      hash: file.hash,
      modifiedAt: file.modifiedAt,
      createdAt: file.createdAt,
      digests: [],  // No digests needed for initial render
      textPreview: file.textPreview || undefined,  // From database cache
    }));

    const response: InboxResponse = {
      items,
      total,
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
