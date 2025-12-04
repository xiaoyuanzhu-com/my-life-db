# Digest System

The digest system is a pipeline architecture that processes files through multiple stages of AI-powered enrichment (crawling, conversion, summarization, tagging, indexing, etc.).

## Overview

**Purpose**: Transform raw files into enriched, searchable content by running them through a series of digesters that extract, transform, and index information.

**Key Principles**:
- **Sequential Processing**: Digesters execute in registration order, allowing later digesters to depend on earlier ones
- **Incremental State**: Each digester produces one or more digest records with independent status tracking
- **Terminal States**: Once a digest reaches "completed" or "skipped" status, it stays terminal (no reprocessing)
- **Idempotent**: Safe to call `processFile()` multiple times - uses locking to prevent concurrent processing
- **Rebuildable**: All digest data can be deleted and regenerated from source files

## Data Models

### Digest Record

Stored in the `digests` table, each record represents one unit of processing output.

```typescript
interface Digest {
  id: string;              // UUID
  filePath: string;        // Relative path from DATA_ROOT (e.g., 'inbox/photo.jpg')
  digester: string;        // Digester name (e.g., 'doc-to-markdown', 'tags')
  status: DigestStatus;    // Current processing state
  content: string | null;  // Text content (markdown, JSON, etc.)
  sqlarName: string | null; // Path to binary artifacts in SQLAR (e.g., screenshots)
  error: string | null;    // Error message if failed
  attempts: number;        // Retry count (max 3)
  createdAt: string;       // ISO timestamp
  updatedAt: string;       // ISO timestamp
}

type DigestStatus =
  | 'todo'        // Not yet processed
  | 'in-progress' // Currently processing
  | 'completed'   // Successfully finished (terminal)
  | 'skipped'     // Not applicable or no output (terminal)
  | 'failed';     // Error occurred (terminal after 3 attempts)
```

**Key Fields**:
- `filePath`: Links digest to source file (no synthetic item IDs)
- `digester`: Identifies which digester produced this output
- `content`: Stores text output (markdown, JSON payloads, metadata)
- `sqlarName`: References binary artifacts stored in SQLAR table (compressed screenshots, HTML, etc.)
- `status`: Tracks processing state with clear terminal conditions

### State Transitions

```
todo → in-progress → completed (terminal)
                   ↘ skipped (terminal)
                   ↘ failed → todo (retry)
                            ↘ failed (terminal, after 3 attempts)
```

**Terminal States**:
- `completed`: Digester successfully produced output
- `skipped`: Digester will never apply to this file (e.g., url-crawl on a PDF, doc-to-markdown on a text file)
- `failed` (after 3 attempts): Digester failed and max retries reached

**Non-Terminal States**:
- `todo`: Waiting to be processed
- `in-progress`: Currently executing
- `failed` (< 3 attempts): Will retry on next processing cycle (includes dependency failures)

### Binary Artifacts (SQLAR)

Large or binary outputs (screenshots, processed HTML, etc.) are stored in the `sqlar` table using SQLite's archive format:

```
Path format: {path_hash}/{digester_name}/{filename}
Example: a1b2c3d4e5f6/screenshot/page.png

- Automatically compressed with zlib
- Referenced by digest.sqlarName field
- Cleaned up when file is deleted or reset
```

## Digester Architecture

### Digester Interface

Each digester implements this interface:

```typescript
interface Digester {
  readonly name: string;

  // Check if this digester applies to the file
  canDigest(
    filePath: string,
    file: FileRecordRow,
    existingDigests: Digest[],
    db: Database
  ): Promise<boolean>;

  // Execute processing and return outputs
  digest(
    filePath: string,
    file: FileRecordRow,
    existingDigests: Digest[],
    db: Database
  ): Promise<DigestInput[] | null>;

  // Optional: Specify multiple output digest names
  getOutputDigesters?(): string[];
}
```

**Key Concepts**:
- **Multiple Outputs**: A digester can produce multiple digest records (e.g., UrlCrawlerDigester produces content-md, content-html, screenshot, url-metadata)
- **Dependency Access**: Later digesters can read outputs from earlier digesters via `existingDigests`
- **Smart Skipping**: `canDigest()` determines if digester should run based on file metadata and existing digests
- **Dependency Failures**: Digesters that depend on other digesters should throw errors (not return false) when dependencies are missing or failed. This marks them as `failed` (retryable) instead of `skipped` (terminal), allowing them to retry when dependencies become available.

### Registered Digesters (Execution Order)

Digesters execute in registration order. Order matters for dependencies:

1. **UrlCrawlerDigester** (no dependencies)
   - Outputs: `url-crawl-content`, `url-crawl-html`, `screenshot`, `url-metadata`
   - Extracts URL from file, crawls webpage, captures screenshot

2. **DocToMarkdownDigester** (no dependencies)
   - Outputs: `doc-to-markdown`
   - Converts PDF/Word/PowerPoint/Excel/EPUB to markdown using HAID service

3. **UrlCrawlSummaryDigester** (depends on url-crawl-content)
   - Outputs: `url-crawl-summary`
   - Generates AI summary of crawled content

4. **TagsDigester** (depends on text content)
   - Outputs: `tags`
   - Generates semantic tags for file content

5. **SlugDigester** (depends on summary or content)
   - Outputs: `slug`
   - Generates friendly filename for UUID-named inbox items

6. **SearchKeywordDigester** (depends on text content)
   - Outputs: `search-keyword`
   - Indexes content in Meilisearch for full-text search

7. **SearchSemanticDigester** (depends on text content)
   - Outputs: `search-semantic`
   - Generates embeddings and indexes in Qdrant for vector search

**Dependency Pattern**: Later digesters can safely read outputs from earlier digesters because `processFile()` loads fresh digest state at the start of each iteration.

## Processing Workflows

### Automatic Processing (Background)

The `DigestSupervisor` runs continuously in the background:

**Trigger 1: Continuous Loop**
```
1. Every 1 second, find files needing digestion
2. Process one file through all digesters
3. If file has failures, apply exponential backoff
4. Repeat
```

**Trigger 2: File System Watcher**
```
1. Listen to file change events from FileSystemWatcher
2. When file added/modified, immediately process
3. Prevents waiting for next loop tick
```

**Stale Digest Cleanup**:
- Every 60 seconds, reset digests stuck in "in-progress" for > 10 minutes
- Handles crashes or long-running processes
- Resets status to "todo" for retry

### Manual Processing (API)

Users can manually trigger digest processing:

**Endpoint**: `POST /api/digest/{...path}`

```typescript
// Example: POST /api/digest/inbox/my-file.docx

1. Validate file exists
2. Call processFileDigests(filePath, { reset: true })
3. Reset clears existing digests (preserves attempt counts)
4. Process all digesters synchronously
5. Return success/error response
```

**Reset Behavior**:
- Sets all digest statuses to "todo"
- Clears content and sqlarName fields
- Resets attempt counts to 0 (allows full retry cycle)
- Deletes SQLAR artifacts for the file

### Processing Algorithm

The `DigestCoordinator.processFile()` method orchestrates the pipeline:

```typescript
async processFile(filePath: string, options?: { reset?: boolean }) {
  // 1. Acquire file-level lock (prevent concurrent processing)
  if (processingFiles.has(filePath)) {
    log.warn('file already being processed, skipping');
    return;
  }
  processingFiles.add(filePath);

  try {
    // 2. Load file metadata
    const file = getFileByPath(filePath);

    // 3. Optional: Reset existing digests
    if (options?.reset) {
      resetDigests(filePath);
    }

    // 4. Get all registered digesters (in order)
    const digesters = registry.getAll();

    // 5. Process each digester sequentially
    for (const digester of digesters) {
      // 5a. Load FRESH digest state (critical for dependencies)
      const existingDigests = listDigestsForPath(filePath);

      // 5b. Get all output names for this digester
      const outputNames = digester.getOutputDigesters?.() ?? [digester.name];

      // 5c. Skip if any output is in-progress
      const inProgress = outputNames.some(name =>
        existingDigests.find(d => d.digester === name && d.status === 'in-progress')
      );
      if (inProgress) continue;

      // 5d. Find pending outputs (todo or failed with attempts < 3)
      const pendingOutputs = outputNames.filter(name => {
        const digest = existingDigests.find(d => d.digester === name);
        if (!digest) return true; // Never created
        if (digest.status === 'todo') return true;
        if (digest.status === 'failed' && digest.attempts < 3) return true;
        return false; // Terminal state
      });

      if (pendingOutputs.length === 0) continue; // All terminal

      // 5e. Check if digester applies
      const can = await digester.canDigest(filePath, file, existingDigests, db);
      if (!can) {
        markDigests(filePath, pendingOutputs, 'skipped', 'Not applicable');
        continue;
      }

      // 5f. Mark as in-progress and increment attempts
      markDigests(filePath, pendingOutputs, 'in-progress', null, { incrementAttempts: true });

      // 5g. Execute digester
      const outputs = await digester.digest(filePath, file, existingDigests, db);

      // 5h. Save outputs to database
      for (const output of outputs) {
        await saveDigestOutput(filePath, output);
      }

      // 5i. Mark missing outputs as skipped
      const producedNames = new Set(outputs.map(o => o.digester));
      const missing = pendingOutputs.filter(name => !producedNames.has(name));
      if (missing.length > 0) {
        markDigests(filePath, missing, 'skipped', 'Output not produced');
      }
    }
  } catch (error) {
    log.error('digester failed', error);
    markDigests(filePath, pendingOutputs, 'failed', error.message);
  } finally {
    // 6. Release file-level lock
    processingFiles.delete(filePath);
  }
}
```

**Key Mechanisms**:

1. **File-Level Locking**: Prevents concurrent `processFile()` calls for same file
   - Multiple systems (API, supervisor, watcher) can safely trigger processing
   - First caller acquires lock, subsequent callers skip with warning
   - Lock released in `finally` block (handles errors)

2. **Fresh State Loading**: `listDigestsForPath()` called at start of each digester iteration
   - Later digesters see outputs from earlier digesters
   - Enables dependency chains (e.g., search depends on doc-to-markdown)

3. **Terminal State Respect**: Once a digest reaches "completed" or "skipped", it stays terminal
   - Prevents redundant reprocessing
   - Reset option (`{ reset: true }`) explicitly clears terminal states

4. **Max Attempts Protection**: Failed digests retry up to 3 times
   - `attempts` field incremented on each failure
   - After 3 attempts, digest stays in "failed" state (terminal)
   - Manual reset (via API) clears attempt counts, allowing fresh retry cycle

5. **Partial Progress**: Each digest saved immediately after completion
   - Survives crashes or interruptions
   - Next run resumes from where it left off

## Text Source Priority

Many digesters (tags, summary, search) need text content. The system checks sources in priority order:

```typescript
1. URL Crawl Content (url-crawl-content digest)
   - Markdown extracted from crawled webpage

2. Doc-to-Markdown Content (doc-to-markdown digest)
   - Converted document (PDF, Word, etc.)

3. Local File Content
   - Direct read from filesystem for text files
```

This priority is implemented in `hasAnyTextSource()` and `getPrimaryTextContent()` functions.

## Common Patterns

### Digester Dependencies

**Pattern**: Later digester depends on earlier digester's output

```typescript
// SearchKeywordDigester checks for doc-to-markdown content
async canDigest(filePath, file, existingDigests, db) {
  return hasAnyTextSource(file, existingDigests);
}

async digest(filePath, file, existingDigests, db) {
  // Throw error if dependencies not ready - marks as 'failed' (retryable)
  if (!hasAnyTextSource(file, existingDigests)) {
    throw new Error('No text source available for indexing');
  }

  // ... indexing logic
}

// hasAnyTextSource() checks url-crawl-content, doc-to-markdown, then local files
```

**Execution Flow (Success Case)**:
1. DocToMarkdownDigester runs first (position 2)
2. Produces `doc-to-markdown` digest with markdown content
3. SearchKeywordDigester runs later (position 6)
4. Loads fresh digests, sees completed `doc-to-markdown`
5. `hasAnyTextSource()` returns true
6. SearchKeywordDigester indexes the markdown

**Execution Flow (Dependency Failure Case)**:
1. DocToMarkdownDigester runs and fails (status='failed', attempts=1)
2. SearchKeywordDigester runs later (position 6)
3. `hasAnyTextSource()` returns false (no doc-to-markdown content)
4. `canDigest()` returns false, but `digest()` throws error
5. SearchKeywordDigester marked as 'failed' (attempts=1, retryable)
6. On next processing cycle:
   - If DocToMarkdownDigester succeeds → SearchKeywordDigester retries and succeeds
   - If DocToMarkdownDigester still failing → SearchKeywordDigester retries and fails again
   - After 3 attempts, both become terminally 'failed'

### Re-indexing on Content Change

**Pattern**: Digester checks if upstream content changed since last run

```typescript
private needsIndexing(filePath, file, existingDigests): boolean {
  const existingSearch = existingDigests.find(d => d.digester === 'search-keyword');
  if (!existingSearch) return true; // Never indexed
  if (existingSearch.status === 'failed') return true; // Retry

  const lastIndexed = toTimestamp(existingSearch.updatedAt);
  const docDigest = existingDigests.find(d => d.digester === 'doc-to-markdown');

  // Re-index if doc-to-markdown updated after last index
  if (docDigest && toTimestamp(docDigest.updatedAt) > lastIndexed) {
    return true;
  }

  return false; // Up to date
}
```

This pattern ensures search indexes stay in sync with content changes.

### Multiple Outputs

**Pattern**: Single digester produces multiple related outputs

```typescript
class UrlCrawlerDigester implements Digester {
  name = 'url-crawler';

  getOutputDigesters() {
    return ['url-crawl-content', 'url-crawl-html', 'screenshot', 'url-metadata'];
  }

  async digest(filePath, file, existingDigests, db) {
    // Single crawl operation
    const result = await crawlUrl(url);

    // Return multiple digest records
    return [
      { digester: 'url-crawl-content', content: result.markdown, ... },
      { digester: 'url-crawl-html', content: result.html, ... },
      { digester: 'screenshot', sqlarName: 'hash/screenshot/page.png', ... },
      { digester: 'url-metadata', content: JSON.stringify(metadata), ... },
    ];
  }
}
```

Coordinator tracks each output independently with its own status.

## Troubleshooting

### Issue: Search digesters not running for documents

**Symptom**: doc-to-markdown completes, but search-keyword/search-semantic show "skipped" or "failed"

**Previous Cause (Fixed)**: Digesters were marked as "skipped" when dependencies weren't ready, making them permanently terminal even when dependencies later succeeded.

**Solution Implemented**: Digesters now throw errors instead of returning null when dependencies are missing:
- When doc-to-markdown fails or hasn't completed yet, dependent digesters throw errors
- This marks them as 'failed' (retryable) instead of 'skipped' (terminal)
- When doc-to-markdown succeeds on retry, dependent digesters automatically retry and succeed
- Both digesters follow the same retry logic (max 3 attempts)

**Additional Protection**: File-level locking in coordinator prevents concurrent processing
- Multiple calls to `processFile()` for the same file are rejected with warning log
- Ensures digesters see consistent state within a single processing run

### Issue: Digests stuck in "in-progress"

**Symptom**: Files not processing, digests show "in-progress" for long time

**Cause**: Process crashed or digester hung without finishing

**Fix**: Stale digest cleanup runs every 60 seconds
- Resets digests in "in-progress" for > 10 minutes
- Changes status back to "todo" for retry

### Issue: Digester failing repeatedly

**Symptom**: Digest shows "failed" status with error message

**Solution**:
1. Check error message in digest.error field
2. If attempts < 3, will auto-retry on next cycle
3. If attempts = 3, digest is terminal - must manually reset
4. Use `POST /api/digest/{path}` with reset=true to retry

## Best Practices

1. **Order Matters**: Register digesters in dependency order
   - Digesters with no dependencies first
   - Digesters that consume outputs later

2. **Check Fresh State**: Always use `existingDigests` parameter passed to your digester
   - Contains latest digest records including earlier digesters in same run
   - Never cache or reuse digest state across calls

3. **Respect Terminal States**: Don't try to reprocess completed/skipped digests
   - Trust the status field
   - Use reset option when intentional reprocessing needed

4. **Use Text Source Helpers**: Don't reinvent content detection
   - Call `hasAnyTextSource()` to check for any text content
   - Call `getPrimaryTextContent()` to get highest-priority text

5. **Throw Errors for Dependency Failures**: If a digester depends on another digester's output
   - Use `canDigest()` for quick checks (file type, size, etc.)
   - In `digest()`, throw an error if dependencies are missing: `throw new Error('No text source available')`
   - This marks the digest as 'failed' (retryable) instead of 'skipped' (terminal)
   - Allows automatic retry when dependencies become available

6. **Return Null Only for True Skips**: If digester has nothing to do and never will
   - Return `null` only when the file type is fundamentally incompatible
   - Example: URL crawler returning null for non-URL files
   - Coordinator marks these as "skipped" (terminal)

7. **Always Throw Errors, Never Return Failed DigestInput**: Let coordinator handle all error tracking
   - **ALWAYS** throw errors from `digest()` - never catch and return `DigestInput` with `status: 'failed'`
   - Coordinator catches errors, increments attempts (capped at MAX_DIGEST_ATTEMPTS), and marks as failed
   - This ensures consistent retry logic and prevents attempts from exceeding the cap
   - After 3 attempts, digest stays failed (terminal)

   ```typescript
   // CORRECT: Throw errors
   async digest(...): Promise<DigestInput[] | null> {
     const result = await externalService.process(file); // Let errors propagate
     return [{ digester: 'my-digester', status: 'completed', content: result }];
   }

   // WRONG: Catching and returning failed status
   async digest(...): Promise<DigestInput[] | null> {
     try {
       const result = await externalService.process(file);
       return [{ status: 'completed', ... }];
     } catch (error) {
       return [{ status: 'failed', error: error.message }]; // DON'T DO THIS
     }
   }
   ```
