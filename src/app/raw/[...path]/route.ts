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

/**
 * GET /raw/[...path]
 * Serve raw binary content from DATA_ROOT
 * Supports HTTP Range requests for audio/video seeking
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
    const ext = path.extname(realPath).toLowerCase();
    const contentType = contentTypeMap[ext] || 'application/octet-stream';
    const stat = await fs.stat(realPath);
    const fileSize = stat.size;

    // Check for Range header (needed for audio/video seeking)
    const rangeHeader = request.headers.get('range');

    if (rangeHeader) {
      // Parse Range header: "bytes=start-end"
      const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
      if (match) {
        const start = match[1] ? parseInt(match[1], 10) : 0;
        const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

        // Validate range
        if (start >= fileSize || end >= fileSize || start > end) {
          return new Response('Range Not Satisfiable', {
            status: 416,
            headers: {
              'Content-Range': `bytes */${fileSize}`,
            },
          });
        }

        const chunkSize = end - start + 1;

        // Read the specific range using file handle
        const fileHandle = await fs.open(realPath, 'r');
        const buffer = Buffer.alloc(chunkSize);
        await fileHandle.read(buffer, 0, chunkSize, start);
        await fileHandle.close();

        return new Response(buffer, {
          status: 206,
          headers: {
            'Content-Type': contentType,
            'Content-Length': String(chunkSize),
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Disposition': `inline; filename="${encodeURIComponent(path.basename(realPath))}"`,
            'Cache-Control': 'public, max-age=31536000, immutable',
          },
        });
      }
    }

    // No Range header - return full file
    const data = await fs.readFile(realPath);

    return new Response(data as unknown as BodyInit, {
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(fileSize),
        'Accept-Ranges': 'bytes',
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
