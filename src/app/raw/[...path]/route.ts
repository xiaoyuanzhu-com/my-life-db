import { NextRequest, NextResponse } from 'next/server';
export const runtime = 'nodejs';
import fs from 'fs/promises';
import path from 'path';
import { DATA_ROOT } from '@/lib/fs/storage';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'RawFileAPI' });

interface RouteContext {
  params: Promise<{ path: string[] }>;
}

/**
 * GET /raw/[...path]
 * Serve raw binary content from DATA_ROOT
 * Always returns raw bytes with proper Content-Type header
 */
export async function GET(
  request: NextRequest,
  context: RouteContext
) {
  try {
    const { path: pathSegments } = await context.params;
    const relativePath = pathSegments.join('/');

    // Security: prevent path traversal attacks
    const normalizedPath = path.normalize(relativePath);
    if (normalizedPath.startsWith('..') || path.isAbsolute(normalizedPath)) {
      return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
    }

    const filePath = path.join(DATA_ROOT, normalizedPath);

    // Verify file exists and is within DATA_ROOT
    const realPath = await fs.realpath(filePath);
    const realDataRoot = await fs.realpath(DATA_ROOT);
    if (!realPath.startsWith(realDataRoot)) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    const data = await fs.readFile(realPath);
    const ext = path.extname(realPath).toLowerCase();

    // Content type mapping
    const contentTypeMap: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.pdf': 'application/pdf',
      '.txt': 'text/plain; charset=utf-8',
      '.md': 'text/markdown; charset=utf-8',
      '.html': 'text/html; charset=utf-8',
      '.json': 'application/json',
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.mov': 'video/quicktime',
      '.avi': 'video/x-msvideo',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.ogg': 'audio/ogg',
    };
    const contentType = contentTypeMap[ext] || 'application/octet-stream';

    return new Response(data as unknown as BodyInit, {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `inline; filename="${encodeURIComponent(path.basename(realPath))}"`,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch (error) {
    log.error({ err: error }, 'file not found');
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }
}
