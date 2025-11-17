import 'server-only';
/**
 * Save content to inbox folder
 * No items abstraction - just saves files and updates files table cache
 */
import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { INBOX_DIR, generateId } from '@/lib/fs/storage';
import { getUniqueFilenames } from '@/lib/fs/file-deduplication';
import { upsertFileRecord } from '@/lib/db/files';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'SaveToInbox' });

// Hash files smaller than 10MB
const HASH_SIZE_THRESHOLD = 10 * 1024 * 1024; // 10MB

interface SaveToInboxInput {
  text?: string; // User's text input
  files?: Array<{
    buffer: Buffer;
    filename: string;
    mimeType: string;
    size: number;
  }>;
}

interface SaveToInboxResult {
  path: string; // Relative path from DATA_ROOT (e.g., 'inbox/photo.jpg' or 'inbox/{uuid}')
  isFolder: boolean;
  files: Array<{
    name: string;
    size: number;
    mimeType: string;
    hash?: string;
  }>;
}

/**
 * Save content to inbox
 * - Single file: saved as inbox/{unique-filename} (no folder)
 * - Multiple files or text+files: saved as inbox/{uuid}/ folder
 * - Text-only: saved as inbox/{uuid}.md
 * - Updates files table cache
 * - Returns path for reference
 */
export async function saveToInbox(input: SaveToInboxInput): Promise<SaveToInboxResult> {
  const { text, files = [] } = input;

  // Validation
  if (!text && files.length === 0) {
    throw new Error('Either text or files must be provided');
  }

  const uuid = generateId();
  const now = new Date().toISOString();

  // Prepare file list
  const allFiles: Array<{ filename: string; buffer: Buffer; mimeType: string; size: number }> = [];

  // Add text file if provided
  if (text && text.trim().length > 0) {
    const textBuffer = Buffer.from(text, 'utf-8');
    const filename = files.length === 0 ? `${uuid}.md` : 'text.md';
    allFiles.push({
      filename,
      buffer: textBuffer,
      mimeType: 'text/markdown',
      size: textBuffer.length,
    });
  }

  // Add user files
  allFiles.push(...files);

  // Single file case (no folder)
  if (allFiles.length === 1 && files.length === 1) {
    // Single uploaded file (not text) - use original filename
    return await saveSingleFile(allFiles[0], now);
  }

  if (allFiles.length === 1 && !files.length) {
    // Single text file - use UUID.md as filename
    return await saveSingleFile(allFiles[0], now);
  }

  // Multi-file case (folder with UUID name)
  return await saveToFolder(uuid, allFiles, now);
}

/**
 * Save single file to inbox root (no folder)
 */
async function saveSingleFile(
  file: { filename: string; buffer: Buffer; mimeType: string; size: number },
  now: string
): Promise<SaveToInboxResult> {
  // Get unique filename in inbox to avoid conflicts
  const uniqueName = await getUniqueInboxFilename(file.filename);
  const filePath = path.join(INBOX_DIR, uniqueName);
  const relativePath = `inbox/${uniqueName}`;

  // Write file to disk
  await fs.writeFile(filePath, file.buffer);

  // Compute hash if small enough
  let hash: string | undefined;
  if (file.size < HASH_SIZE_THRESHOLD) {
    hash = createHash('sha256').update(file.buffer).digest('hex');
  }

  // Update files table cache
  upsertFileRecord({
    path: relativePath,
    name: uniqueName,
    isFolder: false,
    size: file.size,
    mimeType: file.mimeType,
    hash,
    modifiedAt: now,
  });

  log.info({ path: relativePath, size: file.size }, 'saved single file to inbox');

  return {
    path: relativePath,
    isFolder: false,
    files: [{
      name: uniqueName,
      size: file.size,
      mimeType: file.mimeType,
      hash,
    }],
  };
}

/**
 * Save multiple files to inbox folder (UUID-named, will be renamed to slug later)
 */
async function saveToFolder(
  uuid: string,
  allFiles: Array<{ filename: string; buffer: Buffer; mimeType: string; size: number }>,
  now: string
): Promise<SaveToInboxResult> {
  const folderName = uuid;
  const folderPath = path.join(INBOX_DIR, folderName);
  const relativePath = `inbox/${folderName}`;

  // Create directory
  await fs.mkdir(folderPath, { recursive: true });

  // Get unique filenames within folder (handle duplicates)
  const originalFilenames = allFiles.map(f => f.filename);
  const uniqueFilenames = await getUniqueFilenames(folderPath, originalFilenames);

  // Save files and collect metadata
  const savedFiles: Array<{ name: string; size: number; mimeType: string; hash?: string }> = [];

  for (let i = 0; i < allFiles.length; i++) {
    const file = allFiles[i];
    const uniqueFilename = uniqueFilenames[i];
    const filePath = path.join(folderPath, uniqueFilename);
    const fileRelativePath = `${relativePath}/${uniqueFilename}`;

    // Write file to disk
    await fs.writeFile(filePath, file.buffer);

    // Compute hash if small enough
    let hash: string | undefined;
    if (file.size < HASH_SIZE_THRESHOLD) {
      hash = createHash('sha256').update(file.buffer).digest('hex');
    }

    // Update files table cache for each file
    upsertFileRecord({
      path: fileRelativePath,
      name: uniqueFilename,
      isFolder: false,
      size: file.size,
      mimeType: file.mimeType,
      hash,
      modifiedAt: now,
    });

    savedFiles.push({
      name: uniqueFilename,
      size: file.size,
      mimeType: file.mimeType,
      hash,
    });
  }

  // Also create a folder entry in files table
  upsertFileRecord({
    path: relativePath,
    name: folderName,
    isFolder: true,
    modifiedAt: now,
  });

  log.info({ path: relativePath, fileCount: savedFiles.length }, 'saved files to inbox folder');

  return {
    path: relativePath,
    isFolder: true,
    files: savedFiles,
  };
}

/**
 * Get unique filename in inbox directory
 * Uses macOS-style naming: file.md, file 2.md, file 3.md, etc.
 */
async function getUniqueInboxFilename(filename: string): Promise<string> {
  const existingFiles = await fs.readdir(INBOX_DIR);
  const existingFilesSet = new Set(existingFiles);

  if (!existingFilesSet.has(filename)) {
    return filename;
  }

  // Extract name and extension
  const ext = path.extname(filename);
  const baseName = path.basename(filename, ext);

  // Try numbered versions
  let counter = 2;
  while (true) {
    const candidateName = `${baseName} ${counter}${ext}`;
    if (!existingFilesSet.has(candidateName)) {
      return candidateName;
    }
    counter++;
  }
}
