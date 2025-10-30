// API route for individual inbox item operations
import { NextRequest, NextResponse } from 'next/server';
export const runtime = 'nodejs';
import { getInboxItemById, deleteInboxItem, updateInboxItem } from '@/lib/db/inbox';
import { INBOX_DIR } from '@/lib/fs/storage';
import { getUniqueFilename } from '@/lib/fs/fileDeduplication';
import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import type { InboxFile } from '@/types';
import { getInboxTaskStates } from '@/lib/db/inboxTaskState';
import { summarizeInboxProcessing } from '@/lib/inbox/statusView';

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

    // Attach processing summary
    const states = getInboxTaskStates(id);
    const processing = summarizeInboxProcessing(item, states);
    return NextResponse.json({ ...item, processing } as unknown);
  } catch (error) {
    console.error('Error fetching inbox item:', error);
    return NextResponse.json(
      { error: 'Failed to fetch inbox item' },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/inbox/[id]
 * Update an inbox item (text and/or files)
 */
export async function PUT(
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

    const formData = await request.formData();
    const text = formData.get('text') as string | null;
    const removeFiles = formData.getAll('removeFiles') as string[];
    const newFileEntries = formData.getAll('files') as File[];

    const itemDir = path.join(INBOX_DIR, item.folderName);
    let updatedFiles = [...item.files];

    // 1. Handle text update
    if (text !== null) {
      const textFilePath = path.join(itemDir, 'text.md');

      if (text.trim().length === 0) {
        // Remove text.md if text is empty
        await fs.rm(textFilePath, { force: true });
        updatedFiles = updatedFiles.filter(f => f.filename !== 'text.md');
      } else {
        // Update or create text.md
        const textBuffer = Buffer.from(text, 'utf-8');
        await fs.writeFile(textFilePath, textBuffer);

        const hash = createHash('sha256').update(textBuffer).digest('hex');
        const existingTextFile = updatedFiles.find(f => f.filename === 'text.md');

        if (existingTextFile) {
          // Update existing
          existingTextFile.size = textBuffer.length;
          existingTextFile.hash = hash;
        } else {
          // Add new
          updatedFiles.push({
            filename: 'text.md',
            size: textBuffer.length,
            mimeType: 'text/markdown',
            type: 'text',
            hash,
          });
        }
      }
    }

    // 2. Handle file removal
    if (removeFiles.length > 0) {
      for (const filename of removeFiles) {
        const filePath = path.join(itemDir, filename);
        await fs.rm(filePath, { force: true });
        updatedFiles = updatedFiles.filter(f => f.filename !== filename);
      }
    }

    // 3. Handle new file additions
    if (newFileEntries.length > 0) {
      for (const file of newFileEntries) {
        if (file.size === 0) continue;

        const buffer = Buffer.from(await file.arrayBuffer());

        // Get unique filename
        const uniqueFilename = await getUniqueFilename(itemDir, file.name);
        const filePath = path.join(itemDir, uniqueFilename);

        // Save file
        await fs.writeFile(filePath, buffer);

        // Compute hash
        const hash = createHash('sha256').update(buffer).digest('hex');

        // Determine file type
        let fileType: InboxFile['type'] = 'other';
        if (file.type.startsWith('image/')) fileType = 'image';
        else if (file.type.startsWith('audio/')) fileType = 'audio';
        else if (file.type.startsWith('video/')) fileType = 'video';
        else if (file.type === 'application/pdf') fileType = 'pdf';

        // Add to files array
        updatedFiles.push({
          filename: uniqueFilename,
          size: buffer.length,
          mimeType: file.type,
          type: fileType,
          hash,
        });
      }
    }

    // 4. Update database
    updateInboxItem(id, {
      files: updatedFiles,
      updatedAt: new Date().toISOString(),
    });

    // 5. Return updated item
    const updatedItem = getInboxItemById(id);
    return NextResponse.json(updatedItem);

  } catch (error) {
    console.error('Error updating inbox item:', error);
    return NextResponse.json(
      { error: 'Failed to update inbox item' },
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
