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

async function validatePath(pathSegments: string[]) {
  let decodedSegments: string[];
  try {
    decodedSegments = pathSegments.map((segment) => decodeURIComponent(segment));
  } catch {
    return { error: 'Invalid path', status: 400 };
  }

  const relativePath = decodedSegments.join('/');

  // Security: prevent path traversal attacks
  const normalizedPath = path.normalize(relativePath);
  if (normalizedPath.startsWith('..') || path.isAbsolute(normalizedPath)) {
    return { error: 'Invalid path', status: 400 };
  }

  const filePath = path.resolve(DATA_ROOT, normalizedPath);
  const realDataRoot = await fs.realpath(DATA_ROOT);

  if (!filePath.startsWith(realDataRoot)) {
    return { error: 'Access denied', status: 403 };
  }

  let realPath: string;
  try {
    realPath = await fs.realpath(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { error: 'File not found', status: 404 };
    }
    throw error;
  }

  if (!realPath.startsWith(realDataRoot)) {
    return { error: 'Access denied', status: 403 };
  }

  return { realPath, relativePath: normalizedPath };
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

    const validation = await validatePath(pathSegments);
    if ('error' in validation) {
      return NextResponse.json({ error: validation.error }, { status: validation.status });
    }

    const { realPath } = validation;

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
      '.m4a': 'audio/mp4',
      '.aac': 'audio/aac',
      '.flac': 'audio/flac',
      '.wma': 'audio/x-ms-wma',
      '.aiff': 'audio/aiff',
      '.opus': 'audio/opus',
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

/**
 * PUT /raw/[...path]
 * Save text content to a file in DATA_ROOT
 */
export async function PUT(
  request: NextRequest,
  context: RouteContext
) {
  try {
    const { path: pathSegments } = await context.params;

    const validation = await validatePath(pathSegments);
    if ('error' in validation) {
      return NextResponse.json({ error: validation.error }, { status: validation.status });
    }

    const { realPath } = validation;

    // Read the request body as text
    const content = await request.text();

    // Write the content to the file
    await fs.writeFile(realPath, content, 'utf-8');

    log.info({ path: validation.relativePath }, 'file saved');

    return NextResponse.json({
      success: true,
      message: 'File saved successfully',
      path: validation.relativePath
    });
  } catch (error) {
    log.error({ err: error }, 'failed to save file');
    return NextResponse.json({ error: 'Failed to save file' }, { status: 500 });
  }
}
