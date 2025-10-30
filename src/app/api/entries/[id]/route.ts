// API route for single entry operations
import { NextRequest, NextResponse } from 'next/server';
export const runtime = 'nodejs';
import { findEntryByUUID, updateEntry, deleteEntry } from '@/lib/fs/storage';
import { z } from 'zod';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'ApiEntryById' });

const UpdateEntrySchema = z.object({
  content: z.string().optional(),
  metadata: z.object({
    title: z.string().optional(),
    tags: z.array(z.string()).optional(),
  }).optional(),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    // Find entry by UUID across all dates
    const entry = await findEntryByUUID(id, 'inbox');

    if (!entry) {
      return NextResponse.json(
        { error: 'Entry not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(entry);
  } catch (error) {
    log.error({ err: error }, 'fetch entry failed');
    return NextResponse.json(
      { error: 'Failed to fetch entry' },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const validated = UpdateEntrySchema.parse(body);

    // Find entry by UUID first
    const existingEntry = await findEntryByUUID(id, 'inbox');
    if (!existingEntry) {
      return NextResponse.json(
        { error: 'Entry not found' },
        { status: 404 }
      );
    }

    // Update using the entry's directory path
    const entry = await updateEntry(existingEntry.directoryPath, validated);

    return NextResponse.json(entry);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid request data', details: error.issues },
        { status: 400 }
      );
    }

    log.error({ err: error }, 'update entry failed');
    return NextResponse.json(
      { error: 'Failed to update entry' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Find entry by UUID first
    const entry = await findEntryByUUID(id, 'inbox');
    if (!entry) {
      return NextResponse.json(
        { error: 'Entry not found' },
        { status: 404 }
      );
    }

    // Delete using the entry's directory path
    const success = await deleteEntry(entry.directoryPath);

    if (!success) {
      return NextResponse.json(
        { error: 'Could not delete entry' },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    log.error({ err: error }, 'delete entry failed');
    return NextResponse.json(
      { error: 'Failed to delete entry' },
      { status: 500 }
    );
  }
}
