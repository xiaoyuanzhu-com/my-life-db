/**
 * Save content to inbox folder
 * No items abstraction - just saves files and updates files table cache
 */
import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { INBOX_DIR, generateId } from '~/.server/fs/storage';
import { upsertFileRecord } from '~/.server/db/files';
import { ensureAllDigesters } from '~/.server/digest/ensure';
import { getLogger } from '~/.server/log/logger';
import { generateTextFilename } from '~/.server/fs/generate-text-filename';

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
  path: string; // Primary path (first saved file) for backward compatibility
  paths: string[]; // All saved file paths (relative from DATA_ROOT)
  files: Array<{
    name: string;
    size: number;
    mimeType: string;
    hash?: string;
  }>;
}

/**
 * Save content to inbox - all files saved individually in inbox root
 * - Text only: saved as inbox/{uuid}.md
 * - Single file: saved as inbox/{unique-filename}
 * - Text + files: saved as inbox/{uuid}.md, inbox/{filename1}, inbox/{filename2}, etc.
 * - Multiple files: saved as inbox/{filename1}, inbox/{filename2}, etc.
 * - Updates files table cache
 * - Returns all paths
 */
export async function saveToInbox(input: SaveToInboxInput): Promise<SaveToInboxResult> {
  const { text, files = [] } = input;

  // Validation
  if (!text && files.length === 0) {
    throw new Error('Either text or files must be provided');
  }

  // Ensure inbox directory exists (handles first-run environments)
  await fs.mkdir(INBOX_DIR, { recursive: true });

  const now = new Date().toISOString();
  const savedPaths: string[] = [];
  const savedFiles: Array<{ name: string; size: number; mimeType: string; hash?: string }> = [];

  // 1. Save text first (if provided) with generated or UUID name
  if (text && text.trim().length > 0) {
    // Try to generate a human-readable filename, fallback to UUID
    const generatedName = generateTextFilename(text);
    const baseName = generatedName ?? generateId();
    const textBuffer = Buffer.from(text, 'utf-8');
    const textFile = {
      filename: `${baseName}.md`,
      buffer: textBuffer,
      mimeType: 'text/markdown',
      size: textBuffer.length,
    };
    const result = await saveSingleFile(textFile, now);
    savedPaths.push(result.path);
    savedFiles.push(...result.files);
  }

  // 2. Save each file with original name (in order)
  for (const file of files) {
    const result = await saveSingleFile(file, now);
    savedPaths.push(result.path);
    savedFiles.push(...result.files);
  }

  log.info({ paths: savedPaths, fileCount: savedFiles.length }, 'saved files to inbox');

  return {
    path: savedPaths[0], // Primary path (backward compat)
    paths: savedPaths,   // All saved paths
    files: savedFiles,
  };
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

  // Read text preview for text files (first 50 lines)
  let textPreview: string | undefined;
  if (file.mimeType.startsWith('text/')) {
    const text = file.buffer.toString('utf-8');
    const lines = text.split('\n').slice(0, 50);
    textPreview = lines.join('\n');
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
    textPreview,
  });

  ensureAllDigesters(relativePath);

  log.info({ path: relativePath, size: file.size }, 'saved single file to inbox');

  return {
    path: relativePath,
    paths: [relativePath],
    files: [{
      name: uniqueName,
      size: file.size,
      mimeType: file.mimeType,
      hash,
    }],
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
