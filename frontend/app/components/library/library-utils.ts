import { File, FileText, Image, Film, Music, FileCode, Folder } from 'lucide-react';
import type { PendingInboxItem } from '~/lib/send-queue/types';

export interface FileNode {
  path: string;
  type: 'file' | 'folder';
  size?: number;
  modifiedAt?: string;
  children?: FileNode[];
  uploadStatus?: 'pending' | 'uploading' | 'error';
  uploadProgress?: number;
}

export function getFileIcon(filename: string) {
  const ext = filename.toLowerCase().split('.').pop();

  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'];
  const videoExts = ['mp4', 'webm', 'mov', 'avi'];
  const audioExts = ['mp3', 'wav', 'ogg', 'm4a'];
  const codeExts = ['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'cpp', 'c', 'go', 'rs'];

  if (ext === 'md' || ext === 'txt') return FileText;
  if (imageExts.includes(ext || '')) return Image;
  if (videoExts.includes(ext || '')) return Film;
  if (audioExts.includes(ext || '')) return Music;
  if (codeExts.includes(ext || '')) return FileCode;
  return File;
}

export function getNodeIcon(node: FileNode) {
  if (node.type === 'folder') return Folder;
  return getFileIcon(getNodeName(node));
}

// Derive name from path
export function getNodeName(node: FileNode): string {
  return node.path.split('/').pop() || node.path;
}

// Sort nodes: folders first, then files, alphabetically within each group
export function sortNodes(nodes: FileNode[]): FileNode[] {
  return [...nodes].sort((a, b) => {
    // Folders come before files
    if (a.type !== b.type) {
      return a.type === 'folder' ? -1 : 1;
    }
    // Alphabetical within same type
    return a.path.localeCompare(b.path);
  });
}

export function getFolderUploadStatus(
  folderPath: string,
  pendingUploads: PendingInboxItem[]
): 'pending' | 'error' | undefined {
  // Find uploads where destination starts with or equals this folder path
  const relevantUploads = pendingUploads.filter(item => {
    const dest = item.destination || '';
    return dest === folderPath || dest.startsWith(folderPath + '/');
  });

  if (relevantUploads.length === 0) return undefined;
  if (relevantUploads.some(u => u.errorMessage)) return 'error';
  return 'pending'; // has pending or uploading
}

export function getFileUploadStatus(item: PendingInboxItem): 'pending' | 'uploading' | 'error' {
  if (item.errorMessage) return 'error';
  if (item.status === 'uploading') return 'uploading';
  return 'pending';
}

export function buildVirtualNodes(
  pendingUploads: PendingInboxItem[],
  basePath: string,
  realNodePaths: Set<string>
): FileNode[] {
  const virtualFolders = new Map<string, PendingInboxItem[]>();
  const virtualFiles: FileNode[] = [];

  for (const item of pendingUploads) {
    const dest = item.destination || '';

    // Skip if destination doesn't match basePath context
    if (basePath) {
      if (!dest.startsWith(basePath + '/') && dest !== basePath) continue;
    }

    // Get relative path from basePath
    const relativeDest = basePath ? dest.slice(basePath.length + 1) : dest;

    // If destination equals basePath, this file goes directly here
    if (dest === basePath || relativeDest === '') {
      // Skip if file already exists in real nodes
      if (realNodePaths.has(item.filename)) continue;

      virtualFiles.push({
        path: item.filename,
        type: 'file',
        size: item.size,
        uploadStatus: getFileUploadStatus(item),
        uploadProgress: item.uploadProgress,
      });
      continue;
    }

    // Otherwise, get the first path segment (folder name)
    const firstSegment = relativeDest.split('/')[0];
    if (!firstSegment) continue;

    // Skip if this folder already exists in real nodes
    if (realNodePaths.has(firstSegment)) continue;

    // Group by first segment for virtual folders
    const existing = virtualFolders.get(firstSegment);
    if (existing) {
      existing.push(item);
    } else {
      virtualFolders.set(firstSegment, [item]);
    }
  }

  // Convert virtual folder map to FileNode array
  const virtualFolderNodes: FileNode[] = Array.from(virtualFolders.entries()).map(
    ([name, items]) => {
      const hasError = items.some(i => i.errorMessage);
      return {
        path: name,
        type: 'folder' as const,
        uploadStatus: hasError ? 'error' : 'pending',
      };
    }
  );

  return [...virtualFolderNodes, ...virtualFiles];
}

export function formatFileSize(bytes?: number): string {
  if (bytes === undefined || bytes === null) return '';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = bytes / Math.pow(1024, i);
  return `${size.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}
