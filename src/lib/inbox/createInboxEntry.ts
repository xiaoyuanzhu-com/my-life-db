// Create inbox entry with file-based approach
import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { INBOX_DIR, generateId } from '@/lib/fs/storage';
import { getUniqueFilenames } from '@/lib/fs/fileDeduplication';
import { createInboxRecord } from '@/lib/db/inbox';
import type { InboxItem, InboxFile, MessageType, FileType } from '@/types';

interface CreateInboxEntryInput {
  text?: string; // User's text input
  files?: Array<{
    buffer: Buffer;
    filename: string;
    mimeType: string;
    size: number;
  }>;
}

/**
 * Create a new inbox entry
 * - Saves files to .app/mylifedb/inbox/{uuid}/
 * - Creates database record in inbox table
 * - Text input saved as text.md (treated as a file)
 * - Handles file deduplication
 */
export async function createInboxEntry(
  input: CreateInboxEntryInput
): Promise<InboxItem> {
  const { text, files = [] } = input;

  // Validation
  if (!text && files.length === 0) {
    throw new Error('Either text or files must be provided');
  }

  // Generate UUID for this entry
  const id = generateId();
  const folderName = id; // Initially UUID, may be renamed to slug later
  const entryDir = path.join(INBOX_DIR, folderName);

  // Create directory
  await fs.mkdir(entryDir, { recursive: true });

  // Prepare file list
  const allFiles: Array<{ filename: string; buffer: Buffer; mimeType: string; size: number }> = [];

  // Add text.md if text provided
  if (text && text.trim().length > 0) {
    const textBuffer = Buffer.from(text, 'utf-8');
    allFiles.push({
      filename: 'text.md',
      buffer: textBuffer,
      mimeType: 'text/markdown',
      size: textBuffer.length,
    });
  }

  // Add user files
  allFiles.push(...files);

  // Get unique filenames (handle duplicates)
  const originalFilenames = allFiles.map(f => f.filename);
  const uniqueFilenames = await getUniqueFilenames(entryDir, originalFilenames);

  // Save files and create InboxFile records
  const inboxFiles: InboxFile[] = [];

  for (let i = 0; i < allFiles.length; i++) {
    const file = allFiles[i];
    const uniqueFilename = uniqueFilenames[i];
    const filePath = path.join(entryDir, uniqueFilename);

    // Write file to disk
    await fs.writeFile(filePath, file.buffer);

    // Compute hash for deduplication
    const hash = createHash('sha256').update(file.buffer).digest('hex');

    // Create InboxFile record
    inboxFiles.push({
      filename: uniqueFilename,
      size: file.size,
      mimeType: file.mimeType,
      type: getFileType(file.mimeType),
      hash,
      // No enrichment yet
    });
  }

  // Determine message type
  const messageType = determineMessageType(text, inboxFiles);

  // Create inbox item
  const now = new Date().toISOString();
  const inboxItem: InboxItem = {
    id,
    folderName,
    type: messageType,
    files: inboxFiles,
    status: 'pending',
    processedAt: null,
    error: null,
    aiSlug: null,
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
  };

  // Save to database
  createInboxRecord(inboxItem);

  return inboxItem;
}

/**
 * Determine file type from MIME type
 */
function getFileType(mimeType: string): FileType {
  if (mimeType.startsWith('text/')) return 'text';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType === 'application/pdf') return 'pdf';
  return 'other';
}

/**
 * Determine message type based on content and files
 */
function determineMessageType(
  text: string | undefined,
  files: InboxFile[]
): MessageType {
  const hasText = text && text.trim().length > 0;
  const hasFiles = files.filter(f => f.filename !== 'text.md').length > 0;

  // No content at all
  if (!hasText && !hasFiles) {
    return 'text'; // Default
  }

  // Only text, no files
  if (hasText && !hasFiles) {
    // Check if it's a URL
    const urlPattern = /^https?:\/\//i;
    if (urlPattern.test(text!.trim())) {
      return 'url';
    }
    return 'text';
  }

  // Only files, no text
  if (!hasText && hasFiles) {
    // Single file determines type
    if (files.length === 1) {
      const file = files[0];
      if (file.type === 'image') return 'image';
      if (file.type === 'audio') return 'audio';
      if (file.type === 'video') return 'video';
      if (file.type === 'pdf') return 'pdf';
    }
    // Multiple files or unknown type
    return 'mixed';
  }

  // Both text and files
  return 'mixed';
}
