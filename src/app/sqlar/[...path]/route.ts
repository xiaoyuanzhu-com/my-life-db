import { NextRequest, NextResponse } from 'next/server';
export const runtime = 'nodejs';

import { sqlarGet } from '@/lib/db/sqlar';
import { getDatabase } from '@/lib/db/connection';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'SqlarAPI' });

interface RouteContext {
  params: Promise<{ path: string[] }>;
}

/**
 * GET /sqlar/[...path]
 * Serve files from SQLAR storage
 * Example: /sqlar/{path-hash}/{digest-type}/filename.ext
 */
export async function GET(
  request: NextRequest,
  context: RouteContext
) {
  try {
    const { path: pathSegments } = await context.params;
    const sqlarName = pathSegments.join('/');

    log.debug({ sqlarName }, 'fetching file from sqlar');

    const db = getDatabase();
    const data = await sqlarGet(db, sqlarName);

    if (!data) {
      log.warn({ sqlarName }, 'file not found in sqlar');
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }

    // Determine content type from file extension
    const extension = sqlarName.split('.').pop()?.toLowerCase() || '';
    const contentType = getContentType(extension);

    return new Response(data as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch (error) {
    log.error({ err: error }, 'failed to serve sqlar file');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

function getContentType(extension: string): string {
  const map: Record<string, string> = {
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'webp': 'image/webp',
    'gif': 'image/gif',
    'bmp': 'image/bmp',
    'tiff': 'image/tiff',
    'html': 'text/html',
    'md': 'text/markdown',
    'txt': 'text/plain',
    'json': 'application/json',
    'pdf': 'application/pdf',
  };
  return map[extension] || 'application/octet-stream';
}
