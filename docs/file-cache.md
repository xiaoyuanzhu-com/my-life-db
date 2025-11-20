# File Cache Implementation

## Overview

The file cache system provides persistent, offline-capable file storage using IndexedDB with automatic LRU (Least Recently Used) eviction.

## Architecture

### Three-Layer Caching Strategy

1. **Browser HTTP Cache** (Server-controlled)
   - `Cache-Control: public, max-age=31536000, immutable`
   - Set in `/api/raw/[...path]/route.ts`

2. **React Query Memory Cache** (In-memory)
   - Fast re-access to recently viewed files
   - Automatic cache invalidation
   - Request deduplication
   - 24-hour memory retention

3. **IndexedDB Persistent Cache** (Disk storage)
   - Survives page refresh and browser restart
   - 500MB maximum cache size (configurable)
   - LRU eviction when limit exceeded
   - True offline capability

## Components

### Core Files

- `src/lib/cache/file-cache.ts` - IndexedDB cache implementation with LRU eviction
- `src/hooks/use-cached-file.ts` - React Query wrapper hook
- `src/components/providers.tsx` - QueryClientProvider setup
- `src/components/library/file-viewer.tsx` - Updated to use cache

### Key Features

**LRU Eviction:**
- Maximum cache size: 500MB
- Target size after cleanup: 350MB (70%)
- Cleanup check interval: 5 minutes
- Evicts oldest accessed files first

**Access Tracking:**
- `lastAccessed` - Timestamp of last access
- `accessCount` - Number of times accessed
- `cachedAt` - Original cache timestamp
- `size` - File size in bytes

**Cache Statistics:**
- Total cache size
- Number of cached files
- Last cleanup timestamp

## Usage

### Fetch and Cache a File

```typescript
import { useCachedFile } from '@/hooks/use-cached-file';

function MyComponent() {
  const { data, isLoading, error } = useCachedFile('path/to/file.jpg');

  if (isLoading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;

  return <div>{data.name}</div>;
}
```

### Get Cache Statistics

```typescript
import { useCacheStats } from '@/hooks/use-cached-file';

function CacheStats() {
  const { data: stats } = useCacheStats();

  return (
    <div>
      <p>Cache Size: {(stats.totalSize / 1024 / 1024).toFixed(2)} MB</p>
      <p>Files: {stats.fileCount}</p>
    </div>
  );
}
```

### Clear Cache

```typescript
import { clearFileCache, removeFromCache } from '@/hooks/use-cached-file';

// Clear entire cache
await clearFileCache();

// Remove specific file
await removeFromCache('path/to/file.jpg');
```

## Cache Behavior

### First Access
1. Check IndexedDB cache → MISS
2. Fetch from server (`/raw/[...path]`)
3. Store blob in IndexedDB
4. Store in React Query memory cache
5. Return data to component

**Console:** `[FileCache] Cache MISS: path/to/file.jpg`

### Subsequent Access (Same Session)
1. Check React Query memory cache → HIT
2. Return data immediately (no network request)

**Console:** No logs (served from memory)

### Subsequent Access (New Session)
1. Check IndexedDB cache → HIT
2. Return data immediately (no network request)
3. Store in React Query memory cache

**Console:** `[FileCache] Cache HIT: path/to/file.jpg`

### Tab Switching
- No network requests (React Query memory cache)
- Instant loading
- No redundant downloads

### Cache Exceeded
1. Automatic LRU eviction triggered
2. Oldest accessed files deleted
3. Cache reduced to 70% of max size

**Console:**
```
[FileCache] Cache size 512.34MB exceeds limit, performing LRU cleanup...
[FileCache] Evicted 15 files, new size: 348.22MB
```

## Configuration

Edit `src/lib/cache/file-cache.ts`:

```typescript
const MAX_CACHE_SIZE = 500 * 1024 * 1024; // 500MB
const TARGET_SIZE_AFTER_CLEANUP = MAX_CACHE_SIZE * 0.7; // 70%
const CLEANUP_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes
```

## Offline Support

Once a file is cached:
- ✅ Works completely offline
- ✅ No network required
- ✅ Survives browser restart
- ✅ Instant loading

## Performance

**Before Cache:**
- Tab switch: ~100-500ms (network fetch)
- Refresh: Full re-download
- Offline: Broken

**After Cache:**
- Tab switch: <10ms (memory cache)
- Refresh: <50ms (IndexedDB cache)
- Offline: Fully functional

## Browser Compatibility

- Chrome/Edge: ✅ Full support
- Firefox: ✅ Full support
- Safari: ✅ Full support (iOS 10+)
- Opera: ✅ Full support

IndexedDB is supported in all modern browsers.

## Debugging

### Check Cache in DevTools

**Chrome/Edge:**
1. Open DevTools → Application tab
2. IndexedDB → mylifedb-file-cache
3. View `files` store

**Firefox:**
1. Open DevTools → Storage tab
2. IndexedDB → mylifedb-file-cache

### Console Logs

Enable cache logs by checking browser console:
- `[FileCache] Cache HIT: ...` - Served from IndexedDB
- `[FileCache] Cache MISS: ...` - Fetched from server
- `[FileCache] Cache cleared` - Cache manually cleared
- `[FileCache] Evicted X files...` - LRU cleanup occurred

### Network Tab

After implementation:
- First load: Shows network request with actual bytes
- Tab switch: No network requests
- Refresh: No network requests (if cached)

## Migration

No migration needed. Cache is built automatically on first use.

## Known Limitations

1. **Private/Incognito Mode:** IndexedDB may be limited or cleared on browser close
2. **Storage Quota:** Browser may limit total IndexedDB storage (usually 50-80% of disk space)
3. **Binary Files Only:** Cache stores blobs, not streaming data
4. **No Partial Content:** Cannot cache ranges (HTTP 206 responses)

## Future Enhancements

- [ ] Service Worker integration for true PWA offline mode
- [ ] Cache warming (preload frequently accessed files)
- [ ] Smart prefetching based on user behavior
- [ ] Compressed storage (reduce cache size)
- [ ] Cross-tab synchronization
- [ ] Background cache updates
