// API route for reading file contents
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { DATA_ROOT } from '@/lib/fs/storage';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'LibraryFileAPI' });

// Helper to determine content type
function getContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();

  const mimeTypes: Record<string, string> = {
    // Text
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.xml': 'application/xml',
    '.csv': 'text/csv',
    '.log': 'text/plain',

    // Images
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',

    // Audio
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',

    // Video
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',

    // Documents
    '.pdf': 'application/pdf',
  };

  return mimeTypes[ext] || 'application/octet-stream';
}

// Check if file is binary
function isBinaryFile(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  const binaryExts = [
    '.jpg', '.jpeg', '.png', '.gif', '.webp',
    '.mp3', '.wav', '.ogg', '.m4a',
    '.mp4', '.webm', '.mov', '.avi',
    '.pdf', '.zip', '.tar', '.gz',
  ];
  return binaryExts.includes(ext);
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const requestedPath = searchParams.get('path');
    const download = searchParams.get('download') === 'true';

    if (!requestedPath) {
      return NextResponse.json(
        { error: 'Path parameter required' },
        { status: 400 }
      );
    }

    // Security: ensure path doesn't escape DATA_ROOT
    const normalizedPath = path.normalize(requestedPath);
    if (normalizedPath.startsWith('..') || path.isAbsolute(normalizedPath)) {
      return NextResponse.json(
        { error: 'Invalid path' },
        { status: 400 }
      );
    }

    const fullPath = path.join(DATA_ROOT, normalizedPath);

    // Verify the path exists and is within DATA_ROOT
    try {
      const realPath = await fs.realpath(fullPath);
      const realDataRoot = await fs.realpath(DATA_ROOT);
      if (!realPath.startsWith(realDataRoot)) {
        return NextResponse.json(
          { error: 'Access denied' },
          { status: 403 }
        );
      }

      // Check if file exists and is a file
      const stats = await fs.stat(realPath);
      if (!stats.isFile()) {
        return NextResponse.json(
          { error: 'Not a file' },
          { status: 400 }
        );
      }

      const contentType = getContentType(path.basename(fullPath));
      const isBinary = isBinaryFile(path.basename(fullPath));

      // For binary files or download request, stream the file
      if (isBinary || download) {
        const fileBuffer = await fs.readFile(realPath);
        const headers = new Headers();
        headers.set('Content-Type', contentType);
        if (download) {
          headers.set('Content-Disposition', `attachment; filename="${path.basename(fullPath)}"`);
        }
        return new NextResponse(fileBuffer, { headers });
      }

      // For text files, return as JSON with metadata
      const content = await fs.readFile(realPath, 'utf-8');
      return NextResponse.json({
        path: normalizedPath,
        name: path.basename(fullPath),
        content,
        contentType,
        size: stats.size,
        modifiedAt: stats.mtime.toISOString(),
      });
    } catch (error) {
      log.error({ err: error, requestedPath }, 'File not found or access error');
      return NextResponse.json(
        { error: 'File not found' },
        { status: 404 }
      );
    }
  } catch (error) {
    log.error({ err: error }, 'Library file API error');
    return NextResponse.json(
      { error: 'Failed to read file' },
      { status: 500 }
    );
  }
}
