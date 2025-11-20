import { useQuery } from '@tanstack/react-query';
import { fileCache } from '@/lib/cache/file-cache';

interface FileData {
  path: string;
  name: string;
  content?: string;
  contentType: string;
  size: number;
  modifiedAt: string;
}

function getFileType(contentType: string): 'text' | 'image' | 'video' | 'audio' | 'pdf' | 'unknown' {
  if (contentType.startsWith('text/') || contentType === 'application/json') return 'text';
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('audio/')) return 'audio';
  if (contentType === 'application/pdf') return 'pdf';
  return 'unknown';
}

/**
 * Fetch file with IndexedDB caching
 * 1. Check IndexedDB cache first
 * 2. If not found, fetch from server
 * 3. Store in IndexedDB for offline access
 * 4. React Query provides memory cache
 */
async function fetchFileWithCache(filePath: string): Promise<FileData> {
  // Try to get from IndexedDB cache first
  const cached = await fileCache.get(filePath);

  let blob: Blob;
  let contentType: string;
  let size: number;

  if (cached) {
    // Cache hit!
    console.log(`[FileCache] Cache HIT: ${filePath}`);
    blob = cached.blob;
    contentType = cached.contentType;
    size = blob.size;
  } else {
    // Cache miss - fetch from server
    console.log(`[FileCache] Cache MISS: ${filePath}`);
    const response = await fetch(`/raw/${filePath}`);

    if (!response.ok) {
      throw new Error('Failed to load file');
    }

    contentType = response.headers.get('content-type') || 'application/octet-stream';
    size = parseInt(response.headers.get('content-length') || '0');
    blob = await response.blob();

    // Store in cache for future use (don't await to avoid blocking)
    fileCache.put(filePath, blob, contentType).catch((err) => {
      console.error('Failed to cache file:', err);
    });
  }

  // Extract filename from path
  const filenameMatch = filePath.match(/[^/]+$/);
  const filename = filenameMatch ? filenameMatch[0] : 'file';

  const fileType = getFileType(contentType);

  // For text files, convert blob to text
  if (fileType === 'text') {
    const text = await blob.text();
    return {
      path: filePath,
      name: filename,
      content: text,
      contentType,
      size,
      modifiedAt: new Date().toISOString(),
    };
  }

  // For binary files, return blob metadata
  return {
    path: filePath,
    name: filename,
    contentType,
    size,
    modifiedAt: new Date().toISOString(),
  };
}

/**
 * Hook to fetch and cache files
 * Combines React Query (memory cache) + IndexedDB (persistent cache)
 */
export function useCachedFile(filePath: string) {
  return useQuery({
    queryKey: ['file', filePath],
    queryFn: () => fetchFileWithCache(filePath),
    staleTime: Infinity, // Files are immutable, never refetch
    gcTime: 24 * 60 * 60 * 1000, // Keep in memory for 24 hours
    retry: 3,
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
  });
}

/**
 * Hook to get cache statistics
 */
export function useCacheStats() {
  return useQuery({
    queryKey: ['cache-stats'],
    queryFn: () => fileCache.getStats(),
    refetchInterval: 60000, // Refresh every minute
  });
}

/**
 * Clear the entire file cache
 */
export async function clearFileCache(): Promise<void> {
  await fileCache.clear();
}

/**
 * Remove a specific file from cache
 */
export async function removeFromCache(filePath: string): Promise<void> {
  await fileCache.remove(filePath);
}
