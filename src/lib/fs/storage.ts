// Filesystem storage utilities for MyLifeDB
import 'server-only';
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import type { Directory, DirectoryMetadata } from '@/types';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'Storage' });

// Data root directory (respects MY_DATA_DIR environment variable)
export const DATA_ROOT = process.env.MY_DATA_DIR || path.join(process.cwd(), 'data');
export const APP_DIR = path.join(DATA_ROOT, 'app', 'mylifedb');
export const INBOX_DIR = path.join(DATA_ROOT, 'inbox');

// Initialize data directories
export async function initializeStorage(): Promise<void> {
  await fs.mkdir(APP_DIR, { recursive: true });
  await fs.mkdir(INBOX_DIR, { recursive: true });
}

// Generate unique UUID for entries
export function generateId(): string {
  return randomUUID();
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
    log.error({ err: error, relativePath }, 'read directory failed');
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
    log.error({ err: error, parentPath }, 'list directories failed');
    return [];
  }
}

// Note: legacy Entry CRUD/search removed in favor of DB-backed Inbox with flat folder structure
