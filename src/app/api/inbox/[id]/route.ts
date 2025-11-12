// API route for individual inbox item operations
import { NextRequest, NextResponse } from 'next/server';
export const runtime = 'nodejs';
import { getFileByPath, upsertFileRecord, deleteFileRecord } from '@/lib/db/files';
import { deleteDigestsForPath, listDigestsForPath } from '@/lib/db/digests';
import { getStorageConfig } from '@/lib/config/storage';
import { getUniqueFilename } from '@/lib/fs/fileDeduplication';
import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { getDigestStatusView } from '@/lib/inbox/statusView';
import { getLogger } from '@/lib/log/logger';
import { readPrimaryText, readDigestSummary, readDigestTags, readDigestScreenshot, readDigestSlug } from '@/lib/inbox/digestArtifacts';

const log = getLogger({ module: 'ApiInboxById' });

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/inbox/[id]
 * Get a single inbox item by path
 */
export async function GET(
  request: NextRequest,
  context: RouteContext
) {
  try {
    const { id } = await context.params;
    const filePath = `inbox/${id}`;
    const file = getFileByPath(filePath);

    if (!file) {
      return NextResponse.json(
        { error: 'Inbox item not found' },
        { status: 404 }
      );
    }

    // Attach enrichment summary and digest artifacts
    const enrichment = getDigestStatusView(filePath);
    const [primaryText, summary, tags, screenshot, slug] = await Promise.all([
      readPrimaryText(filePath),
      readDigestSummary(filePath),
      readDigestTags(filePath),
      readDigestScreenshot(filePath),
      readDigestSlug(filePath),
    ]);

    return NextResponse.json({
      path: file.path,
      name: file.name,
      isFolder: file.isFolder,
      files: [], // Files are on disk
      createdAt: file.createdAt,
      updatedAt: file.modifiedAt,
      enrichment,
      primaryText,
      digest: {
        summary,
        tags,
        screenshot,
        slug,
      },
    });
  } catch (error) {
    log.error({ err: error }, 'fetch inbox item failed');
    return NextResponse.json(
      { error: 'Failed to fetch inbox item' },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/inbox/[id]
 * Update an inbox item (text and/or files)
 */
export async function PUT(
  request: NextRequest,
  context: RouteContext
) {
  try {
    const { id } = await context.params;
    const filePath = `inbox/${id}`;
    const file = getFileByPath(filePath);

    if (!file) {
      return NextResponse.json(
        { error: 'Inbox item not found' },
        { status: 404 }
      );
    }

    const config = await getStorageConfig();
    const formData = await request.formData();
    const text = formData.get('text') as string | null;
    const removeFiles = formData.getAll('removeFiles') as string[];
    const newFileEntries = formData.getAll('files') as File[];

    const itemDir = path.join(config.dataPath, filePath);

    // 1. Handle text update
    if (text !== null) {
      const textFilePath = path.join(itemDir, 'text.md');

      if (text.trim().length === 0) {
        // Remove text.md if text is empty
        await fs.rm(textFilePath, { force: true });
      } else {
        // Update or create text.md
        const textBuffer = Buffer.from(text, 'utf-8');
        await fs.writeFile(textFilePath, textBuffer);
      }
    }

    // 2. Handle file removal
    if (removeFiles.length > 0) {
      for (const filename of removeFiles) {
        const filePathToRemove = path.join(itemDir, filename);
        await fs.rm(filePathToRemove, { force: true });
      }
    }

    // 3. Handle new file additions
    if (newFileEntries.length > 0) {
      for (const fileEntry of newFileEntries) {
        if (fileEntry.size === 0) continue;

        const buffer = Buffer.from(await fileEntry.arrayBuffer());

        // Get unique filename
        const uniqueFilename = await getUniqueFilename(itemDir, fileEntry.name);
        const filePathToWrite = path.join(itemDir, uniqueFilename);

        // Save file
        await fs.writeFile(filePathToWrite, buffer);
      }
    }

    // 4. Update database file record with new modified time
    const stats = await fs.stat(itemDir);
    upsertFileRecord({
      path: filePath,
      name: file.name,
      isFolder: file.isFolder,
      mimeType: file.mimeType,
      size: file.size,
      hash: file.hash,
      modifiedAt: stats.mtime.toISOString(),
    });

    // 5. Return updated file
    const updatedFile = getFileByPath(filePath);
    return NextResponse.json(updatedFile);

  } catch (error) {
    log.error({ err: error }, 'update inbox item failed');
    return NextResponse.json(
      { error: 'Failed to update inbox item' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/inbox/[id]
 * Delete an inbox item and its files
 */
export async function DELETE(
  request: NextRequest,
  context: RouteContext
) {
  try {
    const { id } = await context.params;
    const filePath = `inbox/${id}`;
    const file = getFileByPath(filePath);

    if (!file) {
      return NextResponse.json(
        { error: 'Inbox item not found' },
        { status: 404 }
      );
    }

    const config = await getStorageConfig();

    // Delete files from filesystem
    const itemPath = path.join(config.dataPath, filePath);
    await fs.rm(itemPath, { recursive: true, force: true });

    // Delete database records (file and digests)
    deleteFileRecord(filePath);
    deleteDigestsForPath(filePath);

    return NextResponse.json({ success: true });
  } catch (error) {
    log.error({ err: error }, 'delete inbox item failed');
    return NextResponse.json(
      { error: 'Failed to delete inbox item' },
      { status: 500 }
    );
  }
}
