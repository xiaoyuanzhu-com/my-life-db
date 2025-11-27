// API route for individual inbox item operations
import { NextRequest, NextResponse } from 'next/server';
export const runtime = 'nodejs';
import { getFileByPath, upsertFileRecord, deleteFileRecord, deleteFilesByPrefix } from '@/lib/db/files';
import { deleteDigestsForPath, deleteDigestsByPrefix } from '@/lib/db/digests';
import { getStorageConfig } from '@/lib/config/storage';
import fs from 'fs/promises';
import path from 'path';
import { getDigestStatusView } from '@/lib/inbox/status-view';
import { getLogger } from '@/lib/log/logger';
import { readPrimaryText, readDigestSummary, readDigestTags, readDigestScreenshot, readDigestSlug } from '@/lib/inbox/digest-artifacts';

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
 * Update an inbox item - only supports editing markdown files
 */
export async function PUT(
  request: NextRequest,
  context: RouteContext
) {
  try {
    const { id } = await context.params;
    const filePath = `inbox/${id}`;

    // Only allow editing .md files
    if (!filePath.endsWith('.md')) {
      return NextResponse.json(
        { error: 'Only markdown files can be edited' },
        { status: 400 }
      );
    }

    const file = getFileByPath(filePath);
    if (!file) {
      return NextResponse.json(
        { error: 'File not found' },
        { status: 404 }
      );
    }

    const config = await getStorageConfig();
    const body = await request.json();
    const text = body.text;

    if (typeof text !== 'string') {
      return NextResponse.json(
        { error: 'Text content required' },
        { status: 400 }
      );
    }

    // Write text to file
    const fullPath = path.join(config.dataPath, filePath);
    await fs.writeFile(fullPath, text, 'utf-8');

    // Update file record with new modified time
    const stats = await fs.stat(fullPath);
    const hash = text.length < 10 * 1024 * 1024
      ? require('crypto').createHash('sha256').update(text).digest('hex')
      : undefined;

    const lines = text.split('\n').slice(0, 50);
    const textPreview = lines.join('\n');

    upsertFileRecord({
      path: filePath,
      name: file.name,
      isFolder: false,
      mimeType: 'text/markdown',
      size: stats.size,
      hash,
      modifiedAt: stats.mtime.toISOString(),
      textPreview,
    });

    // Return updated file
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
 * Delete an inbox item (file or folder)
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
    const fullPath = path.join(config.dataPath, filePath);

    // Delete from filesystem (recursive handles both files and folders)
    await fs.rm(fullPath, { recursive: true, force: true });

    // Delete database records
    if (file.isFolder) {
      // For existing folders, delete all children first
      deleteFilesByPrefix(`${filePath}/`);
      deleteDigestsByPrefix(`${filePath}/`);
    }
    // Delete the file/folder record itself (cascades to digests via FK)
    deleteFileRecord(filePath);
    deleteDigestsForPath(filePath);

    log.info({ path: filePath }, 'deleted inbox item');

    return NextResponse.json({ success: true });
  } catch (error) {
    log.error({ err: error }, 'delete inbox item failed');
    return NextResponse.json(
      { error: 'Failed to delete inbox item' },
      { status: 500 }
    );
  }
}
