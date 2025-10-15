// Filesystem storage utilities for MyLifeDB
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import type { Entry, EntryMetadata, Directory, DirectoryMetadata } from '@/types';
import { formatDateForDirectory, extractDateFromPath } from '@/lib/utils/slug';

// Data root directory
const DATA_ROOT = path.join(process.cwd(), 'data');
const INBOX_DIR = path.join(DATA_ROOT, 'inbox');
const LIBRARY_DIR = path.join(DATA_ROOT, 'library');

// Initialize data directories
export async function initializeStorage(): Promise<void> {
  await fs.mkdir(INBOX_DIR, { recursive: true });
  await fs.mkdir(LIBRARY_DIR, { recursive: true });
}

// Generate unique UUID for entries
export function generateId(): string {
  return randomUUID();
}

// --- Entry Operations ---

export async function createEntry(
  content: string,
  tags?: string[],
  files?: Array<{ buffer: Buffer; filename: string; mimeType: string; size: number }>
): Promise<Entry> {
  await initializeStorage();

  const id = generateId(); // UUID v4
  const now = new Date();
  const nowISO = now.toISOString();
  const dateDir = formatDateForDirectory(now); // YYYY-MM-DD

  // Create directory structure: inbox/YYYY-MM-DD/uuid/
  const entryDir = path.join(INBOX_DIR, dateDir, id);
  await fs.mkdir(entryDir, { recursive: true });

  // Save files alongside text.md
  const attachments = [];
  if (files && files.length > 0) {
    for (const file of files) {
      const filePath = path.join(entryDir, file.filename);
      await fs.writeFile(filePath, file.buffer);

      attachments.push({
        filename: file.filename,
        mimeType: file.mimeType,
        size: file.size,
      });
    }
  }

  // Create metadata
  const metadata: EntryMetadata = {
    id,
    slug: null, // Will be set by AI processing later
    title: null, // Will be set by AI processing later
    createdAt: nowISO,
    updatedAt: nowISO,
    tags: tags || [],
    ai: {
      processed: false,
      processedAt: null,
      title: null,
      tags: [],
      summary: null,
    },
    attachments,
  };

  // Write text.md (plain content, no frontmatter)
  const textPath = path.join(entryDir, 'text.md');
  await fs.writeFile(textPath, content, 'utf-8');

  // Write metadata.json
  const metadataPath = path.join(entryDir, 'metadata.json');
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');

  return {
    metadata,
    content,
    directoryPath: `inbox/${dateDir}/${id}`,
    date: dateDir,
  };
}

export async function readEntry(directoryPath: string): Promise<Entry | null> {
  try {
    const fullPath = path.join(DATA_ROOT, directoryPath);

    // Read metadata.json
    const metadataPath = path.join(fullPath, 'metadata.json');
    const metadataContent = await fs.readFile(metadataPath, 'utf-8');
    const metadata = JSON.parse(metadataContent) as EntryMetadata;

    // Read text.md
    const textPath = path.join(fullPath, 'text.md');
    const content = await fs.readFile(textPath, 'utf-8');

    // Extract date from path
    const date = extractDateFromPath(directoryPath) || '';

    return {
      metadata,
      content: content.trim(),
      directoryPath,
      date,
    };
  } catch (error) {
    console.error('Error reading entry:', error);
    return null;
  }
}

export async function updateEntry(
  directoryPath: string,
  updates: { content?: string; metadata?: Partial<EntryMetadata> }
): Promise<Entry | null> {
  const entry = await readEntry(directoryPath);
  if (!entry) return null;

  const fullPath = path.join(DATA_ROOT, directoryPath);

  // Update metadata
  const updatedMetadata: EntryMetadata = {
    ...entry.metadata,
    ...updates.metadata,
    updatedAt: new Date().toISOString(),
  };

  const metadataPath = path.join(fullPath, 'metadata.json');
  await fs.writeFile(metadataPath, JSON.stringify(updatedMetadata, null, 2), 'utf-8');

  // Update content if provided
  if (updates.content !== undefined) {
    const textPath = path.join(fullPath, 'text.md');
    await fs.writeFile(textPath, updates.content, 'utf-8');
  }

  const updatedContent = updates.content ?? entry.content;

  return {
    metadata: updatedMetadata,
    content: updatedContent,
    directoryPath,
    date: entry.date,
  };
}

export async function deleteEntry(directoryPath: string): Promise<boolean> {
  try {
    const fullPath = path.join(DATA_ROOT, directoryPath);
    // Delete entire entry directory and all contents
    await fs.rm(fullPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    console.error('Error deleting entry:', error);
    return false;
  }
}

export async function listEntries(basePath: string = 'inbox'): Promise<Entry[]> {
  await initializeStorage();

  const fullPath = path.join(DATA_ROOT, basePath);
  const entries: Entry[] = [];

  try {
    // Read daily directories (YYYY-MM-DD)
    const items = await fs.readdir(fullPath, { withFileTypes: true });
    const dailyDirs = items.filter(item => item.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(item.name));

    // For each daily directory, read entry subdirectories
    for (const dailyDir of dailyDirs) {
      const dailyPath = path.join(fullPath, dailyDir.name);
      const entryDirs = await fs.readdir(dailyPath, { withFileTypes: true });

      for (const entryDir of entryDirs) {
        if (entryDir.isDirectory()) {
          const entryPath = `${basePath}/${dailyDir.name}/${entryDir.name}`;
          const entry = await readEntry(entryPath);
          if (entry) {
            entries.push(entry);
          }
        }
      }
    }

    // Sort by creation date (newest first)
    return entries.sort((a, b) =>
      new Date(b.metadata.createdAt).getTime() - new Date(a.metadata.createdAt).getTime()
    );
  } catch (error) {
    console.error('Error listing entries:', error);
    return [];
  }
}

// --- Directory Operations ---

export async function createDirectory(name: string, description?: string, parentPath: string = 'library'): Promise<Directory> {
  const dirPath = path.join(DATA_ROOT, parentPath, name);
  await fs.mkdir(dirPath, { recursive: true });

  const metadata: DirectoryMetadata = {
    name,
    description,
    createdAt: new Date().toISOString(),
  };

  const metadataPath = path.join(dirPath, '.meta.json');
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');

  return {
    path: `${parentPath}/${name}`,
    metadata,
    entryCount: 0,
    subdirectories: [],
  };
}

export async function readDirectory(relativePath: string): Promise<Directory | null> {
  try {
    const fullPath = path.join(DATA_ROOT, relativePath);
    const metadataPath = path.join(fullPath, '.meta.json');

    let metadata: DirectoryMetadata;
    try {
      const metaContent = await fs.readFile(metadataPath, 'utf-8');
      metadata = JSON.parse(metaContent);
    } catch {
      // If no metadata file, create default
      const name = path.basename(relativePath);
      metadata = {
        name,
        createdAt: new Date().toISOString(),
      };
    }

    const items = await fs.readdir(fullPath, { withFileTypes: true });
    const entryCount = items.filter(item => item.isFile() && item.name.endsWith('.md')).length;
    const subdirectories = items
      .filter(item => item.isDirectory())
      .map(item => item.name);

    return {
      path: relativePath,
      metadata,
      entryCount,
      subdirectories,
    };
  } catch (error) {
    console.error('Error reading directory:', error);
    return null;
  }
}

export async function listDirectories(parentPath: string = 'library'): Promise<Directory[]> {
  await initializeStorage();

  const fullPath = path.join(DATA_ROOT, parentPath);

  try {
    const items = await fs.readdir(fullPath, { withFileTypes: true });
    const directories = items.filter(item => item.isDirectory());

    const dirData = await Promise.all(
      directories.map(async (dir) => {
        const relativePath = `${parentPath}/${dir.name}`;
        return await readDirectory(relativePath);
      })
    );

    return dirData.filter((d): d is Directory => d !== null);
  } catch (error) {
    console.error('Error listing directories:', error);
    return [];
  }
}

export async function moveEntry(entryPath: string, targetDirPath: string): Promise<string | null> {
  try {
    const entry = await readEntry(entryPath);
    if (!entry) return null;

    // Extract entry directory name (UUID or slug)
    const entryDirName = path.basename(entryPath);

    // Get the date from the entry (use original creation date)
    const dateDir = extractDateFromPath(entryPath) || formatDateForDirectory(new Date());

    const newPath = `${targetDirPath}/${dateDir}/${entryDirName}`;

    const sourceFull = path.join(DATA_ROOT, entryPath);
    const targetFull = path.join(DATA_ROOT, newPath);

    // Ensure target directory exists
    await fs.mkdir(path.dirname(targetFull), { recursive: true });

    // Move entire entry directory
    await fs.rename(sourceFull, targetFull);

    return newPath;
  } catch (error) {
    console.error('Error moving entry:', error);
    return null;
  }
}

// Find entry by UUID (searches across all dates)
export async function findEntryByUUID(uuid: string, basePath: string = 'inbox'): Promise<Entry | null> {
  const fullPath = path.join(DATA_ROOT, basePath);

  try {
    const items = await fs.readdir(fullPath, { withFileTypes: true });
    const dailyDirs = items.filter(item => item.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(item.name));

    for (const dailyDir of dailyDirs) {
      const entryPath = `${basePath}/${dailyDir.name}/${uuid}`;
      const entry = await readEntry(entryPath);
      if (entry) {
        return entry;
      }
    }

    return null;
  } catch (error) {
    console.error('Error finding entry by UUID:', error);
    return null;
  }
}

// --- Search Operations ---

export async function searchEntries(query: string, limit: number = 50): Promise<Entry[]> {
  const allEntries: Entry[] = [];

  // Search in inbox
  const inboxEntries = await listEntries('inbox');
  allEntries.push(...inboxEntries);

  // Search in library recursively
  const libraryEntries = await searchInDirectory('library');
  allEntries.push(...libraryEntries);

  // Filter by query
  const queryLower = query.toLowerCase();
  const filtered = allEntries.filter(entry => {
    const contentMatch = entry.content.toLowerCase().includes(queryLower);
    const titleMatch = entry.metadata.title?.toLowerCase().includes(queryLower);
    const tagMatch = entry.metadata.tags?.some(tag => tag.toLowerCase().includes(queryLower));

    return contentMatch || titleMatch || tagMatch;
  });

  return filtered.slice(0, limit);
}

async function searchInDirectory(dirPath: string): Promise<Entry[]> {
  const entries = await listEntries(dirPath);
  const subdirs = await listDirectories(dirPath);

  const subEntries = await Promise.all(
    subdirs.map(async (subdir) => {
      return await searchInDirectory(subdir.path);
    })
  );

  return [...entries, ...subEntries.flat()];
}
