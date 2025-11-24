// API route for general file operations
import { NextRequest, NextResponse } from 'next/server';
export const runtime = 'nodejs';
import { getFileByPath } from '@/lib/db/files';
import { deleteFile } from '@/lib/files/delete-file';
import { getStorageConfig } from '@/lib/config/storage';
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
    const fullPath = path.join(config.dataPath, filePath);

    // Delete file and all related database records
    const result = await deleteFile({
      fullPath,
      relativePath: filePath,
      isFolder: file.isFolder,
    });

    if (!result.success) {
      throw new Error('Delete operation failed');
    }

    log.info(
      {
        filePath,
        isFolder: file.isFolder,
        ...result.databaseRecordsDeleted,
      },
      'file deleted successfully'
    );

    return NextResponse.json({ success: true, result });
  } catch (error) {
    log.error({ err: error }, 'delete file failed');
    return NextResponse.json(
      { error: 'Failed to delete file' },
      { status: 500 }
    );
  }
}
