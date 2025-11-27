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
- `skipped`: Digester determined file is not applicable (e.g., doc-to-markdown for non-document files)
- `failed` (after 3 attempts): Digester failed and max retries reached

**Non-Terminal States**:
- `todo`: Waiting to be processed
- `in-progress`: Currently executing
- `failed` (< 3 attempts): Will retry on next processing cycle

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
- Preserves attempt counts (max-attempt logic still applies)
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
   - Reset preserves attempt counts to prevent infinite retries

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

// hasAnyTextSource() checks url-crawl-content, doc-to-markdown, then local files
```

**Execution Flow**:
1. DocToMarkdownDigester runs first (position 2)
2. Produces `doc-to-markdown` digest with markdown content
3. SearchKeywordDigester runs later (position 6)
4. Loads fresh digests, sees completed `doc-to-markdown`
5. `hasAnyTextSource()` returns true
6. SearchKeywordDigester indexes the markdown

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

**Symptom**: doc-to-markdown completes, but search-keyword/search-semantic show "skipped"

**Cause**: Concurrent `processFile()` calls created race condition:
1. First call starts doc-to-markdown (status='in-progress')
2. Second call starts while first is running
3. Second call checks `hasDocToMarkdownContent()` → returns false (status not 'completed')
4. Search digesters marked as "skipped"
5. First call completes doc-to-markdown (too late)

**Fix**: File-level locking in coordinator prevents concurrent processing
- Second call now rejected immediately with warning log
- Search digesters wait for doc-to-markdown to complete

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

5. **Return Null for Skip**: If digester has nothing to do, return `null`
   - Coordinator automatically marks outputs as "skipped"
   - Better than returning empty array

6. **Handle Errors Gracefully**: Let coordinator handle retries
   - Throw errors for transient failures
   - Coordinator increments attempts and applies backoff
   - After 3 attempts, digest stays failed (terminal)
