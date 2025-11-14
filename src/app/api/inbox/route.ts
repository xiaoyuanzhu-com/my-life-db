// API route for inbox operations
import { NextRequest, NextResponse } from 'next/server';
import { saveToInbox } from '@/lib/inbox/saveToInbox';
import { listFilesWithDigests, countFilesWithDigests } from '@/lib/db/files-with-digests';
import { readPrimaryText } from '@/lib/inbox/digestArtifacts';
import { getLogger } from '@/lib/log/logger';
import type { FileWithDigests } from '@/types/file-card';

// Force Node.js runtime (not Edge)
export const runtime = 'nodejs';

const log = getLogger({ module: 'ApiInbox' });

// Note: App initialization now happens in instrumentation.ts at server startup

export interface InboxItemWithText extends FileWithDigests {
  primaryText?: string | null;
}

export interface InboxResponse {
  items: InboxItemWithText[];
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
    const allFiles = listFilesWithDigests('inbox/', {
      orderBy: 'created_at',
      ascending: false
    });

    // Filter to only top-level entries (inbox/foo.jpg or inbox/folder, NOT inbox/folder/file.jpg)
    const topLevelFiles = allFiles.filter(file => {
      const relativePath = file.path.replace(/^inbox\//, '');
      // Top-level if: no slashes (file) OR is a folder with no additional path segments
      return !relativePath.includes('/') || (file.isFolder && relativePath.split('/').length === 1);
    });

    // Apply pagination after filtering
    const paginatedFiles = topLevelFiles.slice(offset, offset + limit);

    // Enrich with primary text (add to digests array)
    const items: InboxItemWithText[] = await Promise.all(
      paginatedFiles.map(async (file) => {
        const primaryText = await readPrimaryText(file.path);

        // Add primaryText as a synthetic digest if it exists
        const enrichedDigests = primaryText
          ? [
              ...file.digests,
              {
                type: 'primary-text',
                status: 'enriched' as const,
                content: primaryText,
                sqlarName: null,
                error: null,
                updatedAt: file.createdAt, // Use file creation time
              },
            ]
          : file.digests;

        return {
          ...file,
          digests: enrichedDigests,
          primaryText,
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
