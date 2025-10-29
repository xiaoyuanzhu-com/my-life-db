# Task Queue Implementation - URL Crawling

> **Note:** This document describes the project-specific implementation. For the general task queue specification, see [README.md](./README.md).

This document describes how the task queue is used for URL crawling in this project.

## Overview

The task queue system provides a robust, fault-tolerant background job processing infrastructure. It handles URL crawling, content extraction, AI-powered slug generation, and automatic file organization.

## Architecture

```
┌─────────────────────┐
│  User adds URL      │
│  POST /api/inbox    │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  Inbox Item Created │
│  type: 'url'        │
│  status: 'pending'  │
└──────────┬──────────┘
           │
           │ (TODO: Auto-trigger)
           ▼
┌─────────────────────┐
│  Enqueue Task       │
│  tq('process_url')  │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  Task Worker        │
│  Background Polling │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  Execute Handler    │
│  processUrlInboxItem│
└──────────┬──────────┘
           │
           ├─► Crawl URL
           ├─► Extract Content
           ├─► Generate AI Slug
           ├─► Save Files
           └─► Update Inbox Item
```

## Components

### 1. Task Queue Core

**Location:** `src/lib/task-queue/`

- **[index.ts](./index.ts)** - Main entry point, exports `tq()` function
- **[task-manager.ts](./task-manager.ts)** - CRUD operations for tasks
- **[scheduler.ts](./scheduler.ts)** - Retry delay calculation, ready task fetching
- **[executor.ts](./executor.ts)** - Task execution with handler registry
- **[worker.ts](./worker.ts)** - Background polling worker
- **[uuid.ts](./uuid.ts)** - UUID v7 generator (time-sortable)
- **[startup.ts](./startup.ts)** - Initialization and handler registration

### 2. URL Crawling

**Location:** `src/lib/crawl/`

- **[urlCrawler.ts](../crawl/urlCrawler.ts)** - Fetch and parse web pages
- **[contentProcessor.ts](../crawl/contentProcessor.ts)** - HTML → Markdown conversion
- **[urlSlugGenerator.ts](../crawl/urlSlugGenerator.ts)** - AI-powered slug generation

### 3. Inbox Processing

**Location:** `src/lib/inbox/`

- **[processUrlInboxItem.ts](../inbox/processUrlInboxItem.ts)** - URL processing orchestrator

### 4. Database

**Location:** `src/lib/db/migrations/`

- **[005_tasks.ts](../db/migrations/005_tasks.ts)** - Tasks table migration

### 5. API Routes

**Location:** `src/app/api/tasks/`

- **[route.ts](../../app/api/tasks/route.ts)** - GET/POST /api/tasks
- **[id]/route.ts** - GET/DELETE /api/tasks/:id
- **[stats]/route.ts** - GET /api/tasks/stats
- **[worker]/pause/route.ts** - POST /api/tasks/worker/pause
- **[worker]/resume/route.ts** - POST /api/tasks/worker/resume
- **[worker]/status/route.ts** - GET /api/tasks/worker/status

## Usage

### 1. Initialize Task Queue (On App Startup)

```typescript
// src/app/layout.tsx or middleware
import { initializeTaskQueue } from '@/lib/task-queue/startup';

// Call once on server startup
initializeTaskQueue({
  verbose: true, // Enable logging
  startWorker: true, // Auto-start worker
});
```

### 2. Trigger URL Processing (TODO)

Uncomment the code in [src/app/api/inbox/route.ts](../../app/api/inbox/route.ts):

```typescript
// After creating inbox item
if (inboxItem.type === 'url') {
  const urlFile = inboxItem.files.find(f => f.filename === 'url.txt');
  if (urlFile) {
    const urlPath = path.join(
      storageConfig.dataPath,
      '.app',
      'mylifedb',
      'inbox',
      inboxItem.folderName,
      'url.txt'
    );
    const url = await fs.readFile(urlPath, 'utf-8');
    enqueueUrlProcessing(inboxItem.id, url.trim());
  }
}
```

### 3. Monitor Tasks

```bash
# Get task statistics
curl http://localhost:3000/api/tasks/stats

# List all tasks
curl http://localhost:3000/api/tasks

# Filter by status
curl http://localhost:3000/api/tasks?status=failed

# Check worker status
curl http://localhost:3000/api/tasks/worker/status
```

### 4. Control Worker

```bash
# Pause worker
curl -X POST http://localhost:3000/api/tasks/worker/pause

# Resume worker
curl -X POST http://localhost:3000/api/tasks/worker/resume
```

## Task Processing Flow

### URL Crawling Task (`process_url`)

1. **Fetch task from queue** - Worker polls for ready tasks
2. **Claim task** - Optimistic locking prevents duplicate execution
3. **Update inbox status** - Set to `processing`
4. **Crawl URL** - Fetch HTML content
   - Extract metadata (title, description, author, etc.)
   - Parse Open Graph tags
   - Handle redirects
5. **Process content**
   - Convert HTML to Markdown
   - Extract clean text
   - Calculate reading time
6. **Generate slug**
   - Try AI generation (if configured)
   - Fall back to metadata title
   - Fall back to URL path
7. **Save files**
   - `content.html` - Original HTML
   - `content.md` - Markdown conversion
   - `main-content.md` - Clean text
8. **Rename folder** - UUID → slug
9. **Update inbox item**
   - Set `status: 'completed'`
   - Set `aiSlug`
   - Update `files` array with enrichment
10. **Mark task success**

### Retry Strategy

- **Exponential backoff with jitter**
- **Max attempts:** 3 (configurable)
- **Delays:**
  - Attempt 1: ~10s
  - Attempt 2: ~20s
  - Attempt 3: ~40s

### Error Handling

- **Task fails** → Set `status: 'failed'`, retry if attempts < max
- **No handler** → Permanent failure (no retry)
- **Stale tasks** → Auto-recovered after 5 minutes

## Database Schema

### Tasks Table

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,              -- UUID v7 (time-sortable)
  type TEXT NOT NULL,               -- 'process_url', 'image_caption', etc.
  payload TEXT NOT NULL,            -- JSON: { inboxId, url }
  status TEXT DEFAULT 'to-do',      -- 'to-do', 'in-progress', 'success', 'failed'
  version INTEGER DEFAULT 0,        -- Optimistic locking
  attempts INTEGER DEFAULT 0,
  last_attempt_at INTEGER,
  result TEXT,                      -- JSON result on success
  error TEXT,                       -- Error message on failure
  run_after INTEGER,                -- Schedule for future
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
```

## File Structure (After Processing)

```
.app/mylifedb/inbox/understanding-react-hooks/
├── url.txt                  # Original URL
├── content.html             # Raw HTML (preserved)
├── content.md               # Markdown conversion
└── main-content.md          # Clean text extraction
```

## Configuration

### AI Providers (for slug generation)

Configure in Settings UI or environment variables:

```typescript
{
  provider: 'openai' | 'ollama' | 'custom' | 'none',
  openai: {
    apiKey: 'sk-...',
    model: 'gpt-4',
    baseUrl: 'https://api.openai.com/v1'
  },
  ollama: {
    baseUrl: 'http://localhost:11434',
    model: 'llama2'
  }
}
```

### Worker Configuration

```typescript
startWorker({
  pollIntervalMs: 1000,              // Poll every 1 second
  batchSize: 5,                      // Process 5 tasks at once
  maxAttempts: 3,                    // Retry failed tasks 3 times
  staleTaskTimeoutMs: 300_000,       // 5 minutes
  staleTaskRecoveryIntervalMs: 60_000, // Check every minute
  verbose: true,                     // Enable logging
});
```

## Adding New Task Types

1. **Create handler function:**

```typescript
// src/lib/tasks/imageCaption.ts
export async function captionImage(payload: { inboxId: string, imagePath: string }) {
  // Your logic here
  return { caption: 'A beautiful sunset' };
}
```

2. **Register handler on startup:**

```typescript
// src/lib/task-queue/startup.ts
import { captionImage } from '../tasks/imageCaption';

export function initializeTaskQueue() {
  // ...
  tq('image_caption', captionImage);
}
```

3. **Enqueue tasks:**

```typescript
tq('image_caption', {
  inboxId: '123',
  imagePath: '/path/to/image.jpg'
});
```

## Testing

### Manual Testing

```bash
# 1. Start dev server
npm run dev

# 2. Add URL via API
curl -X POST http://localhost:3000/api/inbox \
  -F "text=https://react.dev/learn"

# 3. Check inbox item (note the ID)
curl http://localhost:3000/api/inbox

# 4. Manually trigger processing (TODO: auto-trigger)
curl -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "type": "process_url",
    "payload": {
      "inboxId": "<inbox-id>",
      "url": "https://react.dev/learn"
    }
  }'

# 5. Monitor task status
curl http://localhost:3000/api/tasks?type=process_url

# 6. Check processed files
ls -la data/.app/mylifedb/inbox/
```

## TODOs

- [ ] **Auto-trigger URL processing** - Uncomment code in `src/app/api/inbox/route.ts`
- [ ] **Screenshot capture** - Add Playwright/Puppeteer for visual snapshots
- [ ] **Embeddings generation** - Generate vectors for semantic search
- [ ] **Search indexing** - Push to Meilisearch/Qdrant
- [ ] **File hash calculation** - Add SHA256 hashing for deduplication
- [ ] **Rate limiting** - Add per-domain rate limits for crawling
- [ ] **User agent customization** - Allow configuring user agent per site
- [ ] **Content extraction improvements** - Integrate Mozilla Readability
- [ ] **Task queue UI** - Build admin panel for monitoring

## Troubleshooting

### Worker not processing tasks

```typescript
// Check worker status
const worker = getWorker();
console.log('Running:', worker.isRunning());
console.log('Paused:', worker.isPaused());

// Manually start if needed
startWorker({ verbose: true });
```

### Tasks stuck in 'in-progress'

Stale tasks are automatically recovered after 5 minutes. Force recovery:

```typescript
import { getStaleTasks } from '@/lib/task-queue/scheduler';
import { recoverStaleTasks } from '@/lib/task-queue/executor';

const staleTasks = getStaleTasks(60_000); // 1 minute timeout
recoverStaleTasks(staleTasks);
```

### Crawling fails for specific URLs

Check error in task:

```bash
curl http://localhost:3000/api/tasks?status=failed&type=process_url
```

Common issues:
- Timeout (30s default) - Increase in `crawlUrl()`
- Blocked by robots.txt - Respect or customize user agent
- JavaScript-heavy sites - Consider Playwright/Puppeteer

## Performance

- **Task insertion:** ~1ms (SQLite write)
- **Task polling:** ~5ms (indexed query)
- **URL crawl:** 1-5s (depends on site)
- **Content processing:** 10-100ms
- **AI slug generation:** 1-3s (depends on provider)
- **Total processing time:** 2-10s per URL

## References

- [Task Queue Specification](./README.md)
- [Tech Design Document](../../../docs/tech-design.md#58-url-crawl-implementation)
- [UUID v7 Spec](https://datatracker.ietf.org/doc/draft-peabody-dispatch-new-uuid-format/)
