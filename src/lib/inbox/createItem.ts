import 'server-only';
// Create items in the new items-based architecture
import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { INBOX_DIR, generateId } from '@/lib/fs/storage';
import { getUniqueFilenames } from '@/lib/fs/fileDeduplication';
import { createItem, getUniqueName } from '@/lib/db/items';
import type { Item, ItemFile, MessageType } from '@/types';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'CreateItem' });

// Hash files smaller than 10MB, just store size for larger files
const HASH_SIZE_THRESHOLD = 10 * 1024 * 1024; // 10MB

interface CreateItemInput {
  text?: string; // User's text input
  files?: Array<{
    buffer: Buffer;
    filename: string;
    mimeType: string;
    size: number;
  }>;
}

/**
 * Create a new item in inbox
 * - Single file: saved as inbox/{filename} (no folder)
 * - Multiple files or text: saved as inbox/{uuid}/ folder
 * - Files list stored in database
 * - Small files hashed, all files sized
 */
export async function createInboxItem(
  input: CreateItemInput
): Promise<Item> {
  const { text, files = [] } = input;

  // Validation
  if (!text && files.length === 0) {
    throw new Error('Either text or files must be provided');
  }

  const id = generateId();
  const now = new Date().toISOString();

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

  // Determine message type
  const rawType = determineRawType(text, allFiles);

  // Single file case (no folder) - includes single text.md
  if (allFiles.length === 1) {
    return await createSingleFileItem(id, allFiles[0], rawType, now);
  }

  // Multi-file case (folder)
  return await createFolderItem(id, allFiles, rawType, now);
}

/**
 * Create a single file item (no folder)
 */
async function createSingleFileItem(
  id: string,
  file: { filename: string; buffer: Buffer; mimeType: string; size: number },
  rawType: MessageType,
  now: string
): Promise<Item> {
  // Get unique filename in inbox
  const uniqueName = getUniqueName(file.filename, 'inbox');
  const filePath = path.join(INBOX_DIR, uniqueName);
  const relativePath = `inbox/${uniqueName}`;

  // Write file to disk
  await fs.writeFile(filePath, file.buffer);

  log.info({ id, path: relativePath, size: file.size }, 'created single file item');

  // Compute hash if small enough
  let hash: string | undefined;
  if (file.size < HASH_SIZE_THRESHOLD) {
    hash = createHash('sha256').update(file.buffer).digest('hex');
  }

  // Create ItemFile record
  const itemFile: ItemFile = {
    name: uniqueName,
    size: file.size,
    type: file.mimeType,
    hash,
    modifiedAt: now,
  };

  // Create item
  const item: Item = {
    id,
    name: uniqueName,
    rawType,
    detectedType: null,
    isFolder: false,
    path: relativePath,
    files: [itemFile],
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  };

  // Save to database
  createItem(item);

  return item;
}

/**
 * Create a folder item (multiple files or text)
 */
async function createFolderItem(
  id: string,
  allFiles: Array<{ filename: string; buffer: Buffer; mimeType: string; size: number }>,
  rawType: MessageType,
  now: string
): Promise<Item> {
  // Use UUID as folder name initially (will be renamed to slug later)
  const folderName = id;
  const entryDir = path.join(INBOX_DIR, folderName);
  const relativePath = `inbox/${folderName}`;

  // Create directory
  await fs.mkdir(entryDir, { recursive: true });

  // Get unique filenames (handle duplicates)
  const originalFilenames = allFiles.map(f => f.filename);
  const uniqueFilenames = await getUniqueFilenames(entryDir, originalFilenames);

  // Save files and create ItemFile records
  const itemFiles: ItemFile[] = [];

  for (let i = 0; i < allFiles.length; i++) {
    const file = allFiles[i];
    const uniqueFilename = uniqueFilenames[i];
    const filePath = path.join(entryDir, uniqueFilename);

    // Write file to disk
    await fs.writeFile(filePath, file.buffer);

    // Compute hash if small enough
    let hash: string | undefined;
    if (file.size < HASH_SIZE_THRESHOLD) {
      hash = createHash('sha256').update(file.buffer).digest('hex');
    }

    // Create ItemFile record
    itemFiles.push({
      name: uniqueFilename,
      size: file.size,
      type: file.mimeType,
      hash,
      modifiedAt: now,
    });
  }

  log.info({ id, path: relativePath, fileCount: itemFiles.length }, 'created folder item');

  // Create item
  const item: Item = {
    id,
    name: folderName,
    rawType,
    detectedType: null,
    isFolder: true,
    path: relativePath,
    files: itemFiles,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  };

  // Save to database
  createItem(item);

  return item;
}

/**
 * Determine raw type based on content and files
 * Note: detected_type will be set later by AI (e.g., 'url', 'note', 'todo')
 */
function determineRawType(
  text: string | undefined,
  files: Array<{ filename: string; mimeType: string }>
): MessageType {
  const hasText = text && text.trim().length > 0;
  const nonTextFiles = files.filter(f => f.filename !== 'text.md');
  const hasFiles = nonTextFiles.length > 0;

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
    if (nonTextFiles.length === 1) {
      const file = nonTextFiles[0];
      if (file.mimeType.startsWith('image/')) return 'image';
      if (file.mimeType.startsWith('audio/')) return 'audio';
      if (file.mimeType.startsWith('video/')) return 'video';
      if (file.mimeType === 'application/pdf') return 'pdf';
    }
    // Multiple files or unknown type
    return 'mixed';
  }

  // Both text and files
  return 'mixed';
}
