// API route for reading library directory tree
import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { DATA_ROOT } from '@/lib/fs/storage';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'LibraryTreeAPI' });

// File node structure
export interface FileNode {
  name: string;
  path: string; // relative to DATA_ROOT
  type: 'file' | 'folder';
  size?: number;
  modifiedAt?: string;
  children?: FileNode[];
}

// Helper to determine if a path should be excluded
function shouldExclude(name: string): boolean {
  // Exclude hidden files/folders (except .meta.json which we'll handle separately)
  if (name.startsWith('.')) return true;
  // Exclude node_modules, etc.
  if (name === 'node_modules' || name === '.git') return true;
  return false;
}

// Helper to get file type from extension
function getFileType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'];
  const videoExts = ['.mp4', '.webm', '.mov', '.avi'];
  const audioExts = ['.mp3', '.wav', '.ogg', '.m4a'];

  if (ext === '.pdf') return 'pdf';
  if (imageExts.includes(ext)) return 'image';
  if (videoExts.includes(ext)) return 'video';
  if (audioExts.includes(ext)) return 'audio';
  if (ext === '.md') return 'markdown';
  return 'text';
}

// Recursively read directory structure
async function readDirectoryTree(dirPath: string, relativePath: string = '', maxDepth: number = 5, currentDepth: number = 0): Promise<FileNode[]> {
  if (currentDepth >= maxDepth) {
    return [];
  }

  try {
    const items = await fs.readdir(dirPath, { withFileTypes: true });
    const nodes: FileNode[] = [];

    for (const item of items) {
      // Skip excluded items
      if (shouldExclude(item.name)) continue;

      const itemPath = path.join(dirPath, item.name);
      const itemRelativePath = relativePath ? `${relativePath}/${item.name}` : item.name;

      if (item.isDirectory()) {
        // Read subdirectory (lazy load - don't read children initially)
        nodes.push({
          name: item.name,
          path: itemRelativePath,
          type: 'folder',
          children: [], // Empty array - will be loaded on demand
        });
      } else if (item.isFile()) {
        try {
          const stats = await fs.stat(itemPath);
          nodes.push({
            name: item.name,
            path: itemRelativePath,
            type: 'file',
            size: stats.size,
            modifiedAt: stats.mtime.toISOString(),
          });
        } catch (error) {
          log.error({ err: error, itemPath }, 'Failed to stat file');
        }
      }
    }

    // Sort: folders first, then files, alphabetically
    return nodes.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'folder' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
  } catch (error) {
    log.error({ err: error, dirPath }, 'Failed to read directory tree');
    return [];
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const requestedPath = searchParams.get('path') || '';

    // Security: ensure path doesn't escape DATA_ROOT
    const normalizedPath = path.normalize(requestedPath);
    if (normalizedPath.startsWith('..') || path.isAbsolute(normalizedPath)) {
      return NextResponse.json(
        { error: 'Invalid path' },
        { status: 400 }
      );
    }

    const fullPath = path.join(DATA_ROOT, normalizedPath);

    // Verify the path exists and is within DATA_ROOT
    const realPath = await fs.realpath(fullPath);
    const realDataRoot = await fs.realpath(DATA_ROOT);
    if (!realPath.startsWith(realDataRoot)) {
      return NextResponse.json(
        { error: 'Access denied' },
        { status: 403 }
      );
    }

    const tree = await readDirectoryTree(fullPath, normalizedPath);

    return NextResponse.json({
      path: normalizedPath,
      nodes: tree,
    });
  } catch (error) {
    log.error({ err: error }, 'Library tree API error');
    return NextResponse.json(
      { error: 'Failed to read directory tree' },
      { status: 500 }
    );
  }
}
