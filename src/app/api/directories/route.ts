// API route for directories
import { NextRequest, NextResponse } from 'next/server';
export const runtime = 'nodejs';
import { createDirectory, listDirectories, readDirectory } from '@/lib/fs/storage';
import { z } from 'zod';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'ApiDirectories' });

const CreateDirectorySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  parentPath: z.string().default('library'),
});

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const parentPath = searchParams.get('parent') || 'library';
    const path = searchParams.get('path');

    if (path) {
      // Get specific directory
      const directory = await readDirectory(path);

      if (!directory) {
        return NextResponse.json(
          { error: 'Directory not found' },
          { status: 404 }
        );
      }

      return NextResponse.json(directory);
    }

    // List directories
    const directories = await listDirectories(parentPath);
    return NextResponse.json({ directories, total: directories.length });
  } catch (error) {
    log.error({ err: error }, 'fetch directories failed');
    return NextResponse.json(
      { error: 'Failed to fetch directories' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const validated = CreateDirectorySchema.parse(body);

    const directory = await createDirectory(
      validated.name,
      validated.description,
      validated.parentPath
    );

    return NextResponse.json(directory, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid request data', details: error.issues },
        { status: 400 }
      );
    }

    log.error({ err: error }, 'create directory failed');
    return NextResponse.json(
      { error: 'Failed to create directory' },
      { status: 500 }
    );
  }
}
