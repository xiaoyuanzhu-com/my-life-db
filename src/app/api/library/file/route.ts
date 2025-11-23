// API route for general file operations
import { NextRequest, NextResponse } from 'next/server';
export const runtime = 'nodejs';
import { getFileByPath, deleteFileRecord, deleteFilesByPrefix } from '@/lib/db/files';
import { deleteDigestsForPath, deleteDigestsByPrefix } from '@/lib/db/digests';
import { getStorageConfig } from '@/lib/config/storage';
import fs from 'fs/promises';
import path from 'path';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'ApiLibraryFile' });

/**
 * DELETE /api/library/file?path=<file-path>
 * Delete any file or folder in the library (except reserved folders)
 */
export async function DELETE(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const filePath = searchParams.get('path');

    if (!filePath) {
      return NextResponse.json(
        { error: 'Missing path parameter' },
        { status: 400 }
      );
    }

    // Prevent deletion of reserved folders
    const topLevelFolder = filePath.split('/')[0];
    if (topLevelFolder === 'app') {
      return NextResponse.json(
        { error: 'Cannot delete app folder' },
        { status: 403 }
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

    // Delete files from filesystem
    const fullPath = path.join(config.dataPath, filePath);
    await fs.rm(fullPath, { recursive: true, force: true });

    // Delete database records (file and digests)
    if (file.isFolder) {
      // For folders, delete all children first
      deleteFilesByPrefix(`${filePath}/`);
      deleteDigestsByPrefix(`${filePath}/`);
    }
    // Delete the folder/file record itself
    deleteFileRecord(filePath);
    deleteDigestsForPath(filePath);

    return NextResponse.json({ success: true });
  } catch (error) {
    log.error({ err: error }, 'delete file failed');
    return NextResponse.json(
      { error: 'Failed to delete file' },
      { status: 500 }
    );
  }
}
