// API route for entries
import { NextRequest, NextResponse } from 'next/server';
export const runtime = 'nodejs';
import { createEntry, listEntries } from '@/lib/fs/storage';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'ApiEntries' });

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const directory = searchParams.get('directory') || 'inbox';

    const entries = await listEntries(directory);

    return NextResponse.json({ entries, total: entries.length });
  } catch (error) {
    log.error({ err: error }, 'fetch entries failed');
    return NextResponse.json(
      { error: 'Failed to fetch entries' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const content = formData.get('content') as string;
    const fileEntries = formData.getAll('files') as File[];

    if (!content && fileEntries.length === 0) {
      return NextResponse.json(
        { error: 'Content or files required' },
        { status: 400 }
      );
    }

    // Process uploaded files
    const files = [];
    for (const file of fileEntries) {
      const bytes = await file.arrayBuffer();
      const buffer = Buffer.from(bytes);

      files.push({
        buffer,
        filename: file.name,
        mimeType: file.type,
        size: file.size,
      });
    }

    const entry = await createEntry(content || '', undefined, files);

    return NextResponse.json(entry, { status: 201 });
  } catch (error) {
    log.error({ err: error }, 'create entry failed');
    return NextResponse.json(
      { error: 'Failed to create entry' },
      { status: 500 }
    );
  }
}
