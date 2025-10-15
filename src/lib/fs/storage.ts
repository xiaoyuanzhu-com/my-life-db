// Filesystem storage utilities for MyLifeDB
import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';
import type { Entry, EntryMetadata, Directory, DirectoryMetadata } from '@/types';

// Data root directory
const DATA_ROOT = path.join(process.cwd(), 'data');
const INBOX_DIR = path.join(DATA_ROOT, 'inbox');
const LIBRARY_DIR = path.join(DATA_ROOT, 'library');

// Initialize data directories
export async function initializeStorage(): Promise<void> {
  await fs.mkdir(INBOX_DIR, { recursive: true });
  await fs.mkdir(LIBRARY_DIR, { recursive: true });
}

// Generate unique ID for entries
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// --- Entry Operations ---

export async function createEntry(content: string, tags?: string[]): Promise<Entry> {
  await initializeStorage();

  const id = generateId();
  const now = new Date().toISOString();

  const metadata: EntryMetadata = {
    id,
    tags: tags || [],
    createdAt: now,
    updatedAt: now,
  };

  const fileName = `${id}.md`;
  const filePath = path.join(INBOX_DIR, fileName);

  const fileContent = matter.stringify(content, metadata);
  await fs.writeFile(filePath, fileContent, 'utf-8');

  return {
    metadata,
    content,
    filePath: `inbox/${fileName}`,
  };
}

export async function readEntry(relativePath: string): Promise<Entry | null> {
  try {
    const fullPath = path.join(DATA_ROOT, relativePath);
    const fileContent = await fs.readFile(fullPath, 'utf-8');
    const { data, content } = matter(fileContent);

    return {
      metadata: data as EntryMetadata,
      content: content.trim(),
      filePath: relativePath,
    };
  } catch (error) {
    console.error('Error reading entry:', error);
    return null;
  }
}

export async function updateEntry(
  relativePath: string,
  updates: { content?: string; metadata?: Partial<EntryMetadata> }
): Promise<Entry | null> {
  const entry = await readEntry(relativePath);
  if (!entry) return null;

  const updatedMetadata = {
    ...entry.metadata,
    ...updates.metadata,
    updatedAt: new Date().toISOString(),
  };

  const updatedContent = updates.content ?? entry.content;
  const fullPath = path.join(DATA_ROOT, relativePath);

  const fileContent = matter.stringify(updatedContent, updatedMetadata);
  await fs.writeFile(fullPath, fileContent, 'utf-8');

  return {
    metadata: updatedMetadata,
    content: updatedContent,
    filePath: relativePath,
  };
}

export async function deleteEntry(relativePath: string): Promise<boolean> {
  try {
    const fullPath = path.join(DATA_ROOT, relativePath);
    await fs.unlink(fullPath);
    return true;
  } catch (error) {
    console.error('Error deleting entry:', error);
    return false;
  }
}

export async function listEntries(directoryPath: string = 'inbox'): Promise<Entry[]> {
  await initializeStorage();

  const fullPath = path.join(DATA_ROOT, directoryPath);

  try {
    const files = await fs.readdir(fullPath);
    const mdFiles = files.filter(f => f.endsWith('.md'));

    const entries = await Promise.all(
      mdFiles.map(async (file) => {
        const relativePath = `${directoryPath}/${file}`;
        return await readEntry(relativePath);
      })
    );

    return entries.filter((e): e is Entry => e !== null)
      .sort((a, b) => new Date(b.metadata.createdAt).getTime() - new Date(a.metadata.createdAt).getTime());
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

    const fileName = path.basename(entryPath);
    const newPath = `${targetDirPath}/${fileName}`;

    const sourceFull = path.join(DATA_ROOT, entryPath);
    const targetFull = path.join(DATA_ROOT, newPath);

    // Ensure target directory exists
    await fs.mkdir(path.dirname(targetFull), { recursive: true });

    // Move file
    await fs.rename(sourceFull, targetFull);

    return newPath;
  } catch (error) {
    console.error('Error moving entry:', error);
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
