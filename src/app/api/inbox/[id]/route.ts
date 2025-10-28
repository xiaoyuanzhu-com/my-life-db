// API route for individual inbox item operations
import { NextRequest, NextResponse } from 'next/server';
import { getInboxItemById, deleteInboxItem } from '@/lib/db/inbox';
import { INBOX_DIR } from '@/lib/fs/storage';
import fs from 'fs/promises';
import path from 'path';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/inbox/[id]
 * Get a single inbox item by ID
 */
export async function GET(
  request: NextRequest,
  context: RouteContext
) {
  try {
    const { id } = await context.params;
    const item = getInboxItemById(id);

    if (!item) {
      return NextResponse.json(
        { error: 'Inbox item not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(item);
  } catch (error) {
    console.error('Error fetching inbox item:', error);
    return NextResponse.json(
      { error: 'Failed to fetch inbox item' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/inbox/[id]
 * Delete an inbox item and its files
 */
export async function DELETE(
  request: NextRequest,
  context: RouteContext
) {
  try {
    const { id } = await context.params;
    const item = getInboxItemById(id);

    if (!item) {
      return NextResponse.json(
        { error: 'Inbox item not found' },
        { status: 404 }
      );
    }

    // Delete files from filesystem
    const itemDir = path.join(INBOX_DIR, item.folderName);
    await fs.rm(itemDir, { recursive: true, force: true });

    // Delete database record
    deleteInboxItem(id);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting inbox item:', error);
    return NextResponse.json(
      { error: 'Failed to delete inbox item' },
      { status: 500 }
    );
  }
}
