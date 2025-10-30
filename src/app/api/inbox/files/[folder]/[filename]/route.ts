// Serve inbox item files by folder name and filename
import { NextRequest, NextResponse } from 'next/server';
export const runtime = 'nodejs';
import fs from 'fs/promises';
import path from 'path';
import { INBOX_DIR } from '@/lib/fs/storage';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ folder: string; filename: string }> }
) {
  try {
    const { folder, filename } = await params;
    const filePath = path.join(INBOX_DIR, folder, filename);
    const data = await fs.readFile(filePath);

    const ext = path.extname(filename).toLowerCase();
    const contentTypeMap: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.pdf': 'application/pdf',
      '.txt': 'text/plain',
      '.md': 'text/markdown',
      '.html': 'text/html; charset=utf-8',
    };
    const contentType = contentTypeMap[ext] || 'application/octet-stream';

    return new Response(data as unknown as BodyInit, {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `inline; filename="\${encodeURIComponent(filename)}\"`,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch (error) {
    console.error('[API] Inbox file not found:', error);
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }
}

