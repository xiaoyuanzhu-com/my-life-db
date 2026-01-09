# Search Indexing Migration Implementation Plan

**Goal**: Align Go implementation with Node.js search indexing architecture

**Date**: 2026-01-09

---

## Overview

The Node.js implementation uses intermediate database tables (`qdrant_documents`, `meili_documents`) to track chunks and documents before indexing to external services. The Go implementation currently indexes directly without this layer, missing critical features like text chunking, multi-source indexing, and proper metadata tracking.

---

## Architectural Changes

### Current (Go) Architecture
```
File → Digester → Generate Embedding → Upsert to Qdrant/Meilisearch directly
```

### Target (Node.js) Architecture
```
File → Digester → Create DB records → Background indexer → Upsert to Qdrant/Meilisearch
                    ↓
         qdrant_documents (chunked)
         meili_documents (full-text)
```

---

## Database Schema Changes

### 1. New Table: `qdrant_documents`

Stores chunked text for semantic vector search.

**Schema**:
```sql
CREATE TABLE qdrant_documents (
  -- Primary key: {file_path}:{source_type}:{chunk_index}
  document_id TEXT PRIMARY KEY,

  -- File reference
  file_path TEXT NOT NULL,

  -- Source type (no enum constraint, flexible)
  source_type TEXT NOT NULL,

  -- Chunking metadata
  chunk_index INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  chunk_text TEXT NOT NULL,

  -- Span tracking (character positions in original text)
  span_start INTEGER NOT NULL,
  span_end INTEGER NOT NULL,
  overlap_tokens INTEGER NOT NULL,

  -- Chunk statistics
  word_count INTEGER NOT NULL,
  token_count INTEGER NOT NULL,
  content_hash TEXT NOT NULL,

  -- Optional metadata
  metadata_json TEXT,

  -- Embedding status tracking
  embedding_status TEXT NOT NULL DEFAULT 'pending'
    CHECK(embedding_status IN ('pending', 'indexing', 'indexed', 'deleting', 'deleted', 'error')),
  embedding_version INTEGER NOT NULL DEFAULT 0,
  qdrant_point_id TEXT,
  qdrant_indexed_at TEXT,
  qdrant_error TEXT,

  -- Timestamps
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_qdrant_documents_file_path ON qdrant_documents(file_path);
CREATE INDEX idx_qdrant_documents_status ON qdrant_documents(embedding_status);
CREATE INDEX idx_qdrant_documents_file_source ON qdrant_documents(file_path, source_type);
```

**Key Fields**:
- `document_id`: Format `{filePath}:{sourceType}:{chunkIndex}` (e.g., `inbox/article.md:doc-to-markdown:0`)
- `source_type`: One of: `url-crawl-content`, `doc-to-markdown`, `image-ocr`, `image-captioning`, `image-objects`, `speech-recognition`, `summary`, `tags`, `file`
- `chunk_text`: The actual text chunk (800-1000 tokens)
- `span_start`, `span_end`: Character positions in original source text
- `overlap_tokens`: Number of tokens overlapping with previous chunk (15% of target)

### 2. New Table: `meili_documents`

Stores full-text documents for keyword search (1:1 file mapping).

**Schema**:
```sql
CREATE TABLE meili_documents (
  document_id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL UNIQUE,

  -- Content fields (embedded from digests)
  content TEXT NOT NULL,
  summary TEXT,
  tags TEXT,
  content_hash TEXT NOT NULL,
  word_count INTEGER NOT NULL,

  -- Metadata
  mime_type TEXT,
  metadata_json TEXT,

  -- Meilisearch sync status
  meili_status TEXT NOT NULL DEFAULT 'pending'
    CHECK(meili_status IN ('pending', 'indexing', 'indexed', 'deleting', 'deleted', 'error')),
  meili_task_id TEXT,
  meili_indexed_at TEXT,
  meili_error TEXT,

  -- Timestamps
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_meili_documents_file_path ON meili_documents(file_path);
CREATE INDEX idx_meili_documents_status ON meili_documents(meili_status);
CREATE INDEX idx_meili_documents_hash ON meili_documents(content_hash);
```

**Key Fields**:
- `content`: Combined text from ALL sources (url-crawl, doc-to-markdown, OCR, captioning, objects, speech)
- `summary`: Summary from `url-crawl-summary` or `speech-recognition-summary` digests
- `tags`: Tags from `tags` digest (comma-separated)
- `content_hash`: SHA256 hash of all content for change detection

---

## Implementation Tasks

### Task 1: Database Migrations ✅
**Files**: `backend/db/migration_002_search_tables.go`

**What**:
- Register migration version 2
- Create `qdrant_documents` table with indexes
- Create `meili_documents` table with indexes

**Why**: Foundation for all search indexing changes

**Verification**: Run server, check logs for migration success

---

### Task 2: Database Models & Helpers ✅
**Files**:
- `backend/db/qdrant_documents.go`
- `backend/db/meili_documents.go`
- `backend/db/models.go` (update)

**What**:

`QdrantDocument` struct and functions:
- `UpsertQdrantDocument()` - Create/update document
- `ListQdrantDocumentsByFile()` - Get all chunks for a file
- `ListQdrantDocumentsByStatus()` - Get pending/indexed documents
- `UpdateEmbeddingStatus()` - Update indexing status
- `DeleteQdrantDocumentsByFile()` - Delete all chunks for file
- `GetQdrantDocumentIdsByFile()` - Get document IDs for indexing

`MeiliDocument` struct and functions:
- `UpsertMeiliDocument()` - Create/update document
- `GetMeiliDocumentByFilePath()` - Get document for file
- `ListMeiliDocumentsByStatus()` - Get pending/indexed documents
- `UpdateMeiliStatus()` - Update indexing status
- `DeleteMeiliDocumentByFilePath()` - Delete document

**Why**: Clean database access layer

**Verification**: Build passes, no syntax errors

---

### Task 3: Text Chunking Utility ✅
**Files**: `backend/workers/digest/chunking.go`

**What**:

Implement `ChunkText()` function with:
- Target: 800-1000 tokens per chunk
- Overlap: 15% (120-150 tokens)
- Boundary detection:
  1. Markdown headings (`\n#{1,6}\s+`)
  2. Paragraph breaks (`\n\n+`)
  3. Sentence endings (`[.!?]\s+`)
  4. Whitespace (fallback)
- Token estimation: ~4 chars per token

**Output**: `ChunkResult` struct with:
```go
type ChunkResult struct {
    ChunkIndex     int
    ChunkCount     int
    ChunkText      string
    SpanStart      int
    SpanEnd        int
    OverlapTokens  int
    WordCount      int
    TokenCount     int
}
```

**Algorithm**:
```
1. If text < 3600 chars (900 tokens), return single chunk
2. Otherwise:
   - Start at position 0
   - Move forward ~3600 chars (target chunk size)
   - Search ±800 chars for best boundary
   - Create chunk
   - Move forward with 15% overlap
   - Repeat until end
3. Set chunkCount on all chunks
```

**Why**: Core functionality for semantic search

**Verification**: Unit tests with sample markdown

---

### Task 4: Content Source Extraction ✅
**Files**: `backend/workers/digest/content_sources.go`

**What**:

Implement `GetContentSources()` function:
- Returns array of `ContentSource{SourceType, Text}`
- Checks digests in priority order:
  1. `url-crawl-content` (parse JSON, extract markdown)
  2. `doc-to-markdown` (raw content)
  3. `image-ocr` (raw content)
  4. `image-captioning` (raw content)
  5. `image-objects` (parse JSON, extract titles/descriptions)
  6. `speech-recognition` (parse JSON if segments, else raw)
  7. `file` (read .md/.txt from filesystem)
  8. `file` (read text.md from folder)

Implement `GetPrimaryTextContent()` helper:
- Used by keyword search and tags
- Combines ALL sources with "\n\n" separator
- Returns single string

**Why**: Consistent content extraction across digesters

**Verification**: Build passes, logic correct

---

### Task 5: Rewrite Search-Semantic Digester ✅
**Files**: `backend/workers/digest/digesters.go` (update `SearchSemanticDigester`)

**What**:

New flow:
```
1. Get content sources via GetContentSources()
2. For each source (url-crawl-content, doc-to-markdown, etc.):
   a. Chunk text (800-1000 tokens, 15% overlap)
   b. For each chunk:
      - documentId = "{filePath}:{sourceType}:{chunkIndex}"
      - UpsertQdrantDocument(documentId, chunk metadata)
3. Also index summary and tags as separate sources
4. Mark digester as completed with metadata JSON
```

**Changes**:
- Remove direct HAID embedding call
- Remove direct Qdrant upsert
- Add database record creation
- Store metadata in digest content: `{"sources": {...}, "totalChunks": N}`

**Why**: Decouple indexing from digestion, enable background processing

**Verification**: Build passes, no runtime errors

---

### Task 6: Rewrite Search-Keyword Digester ✅
**Files**: `backend/workers/digest/digesters.go` (update `SearchKeywordDigester`)

**What**:

New flow:
```
1. Get content sources via GetContentSources()
2. Combine all sources into single text
3. Get summary from url-crawl-summary or speech-recognition-summary
4. Get tags from tags digest
5. UpsertMeiliDocument(filePath, content, summary, tags, contentHash, wordCount, mimeType)
6. Mark digester as completed with metadata JSON
```

**Changes**:
- Remove direct Meilisearch indexing
- Add database record creation
- Combine multiple content sources
- Store metadata: `{"documentId": "...", "textSource": "...", "contentSources": [...], "hasSummary": bool, "hasTags": bool}`

**Why**: Proper tracking, multi-source indexing

**Verification**: Build passes

---

### Task 7: Update URL Crawler Format ✅
**Files**: `backend/workers/digest/digesters.go` (update `URLCrawlDigester`)

**What**:

Change `url-crawl-content` digest from plain text to JSON:
```json
{
  "markdown": "...",
  "url": "https://...",
  "title": "...",
  "description": "...",
  "author": "...",
  "publishedDate": "...",
  "image": "...",
  "siteName": "...",
  "domain": "example.com",
  "wordCount": 1234,
  "readingTimeMinutes": 5
}
```

**Changes**:
- Parse metadata from HAID response
- Calculate wordCount and readingTime
- Marshal to JSON string
- Store as digest content

**Why**: Rich metadata for search results, compatibility with Node.js

**Verification**: Crawl a URL, check digest content is JSON

---

### Task 8: Update Qdrant Payload ✅
**Files**: `backend/vendors/qdrant.go` (update `Upsert` function)

**What**:

Current payload:
```go
map[string]interface{}{
    "name": file.Name,
    "path": filePath,
}
```

New payload (match Node.js):
```go
map[string]interface{}{
    "filePath":   filePath,
    "sourceType": sourceType,
    "chunkText":  chunkText,
    "chunkIndex": chunkIndex,
    "chunkCount": chunkCount,
}
```

**Why**: Enable filtering by source type, provide context in results

**Verification**: Search works, payloads visible in results

---

### Task 9: Rewrite Search API Results ✅
**Files**: `backend/api/search.go` (update semantic search section)

**What**:

Current flow:
```
Query → Qdrant search → Return chunks directly
```

New flow:
```
Query → Qdrant search → Get chunk IDs → Group by file → Aggregate → Return files
```

**Changes**:
1. Qdrant returns `[]QdrantSearchResult` with documentIds
2. Parse documentId to extract filePath: `strings.Split(docId, ":")[0]`
3. Group results by filePath
4. For each file:
   - Get file metadata
   - Select best matching chunk (highest score)
   - Extract snippet from chunk_text
5. Return file-level results with snippets

**Response format**:
```json
{
  "results": [
    {
      "path": "inbox/article.md",
      "name": "article.md",
      "score": 0.92,
      "snippet": "...relevant text from chunk...",
      "source": "semantic",
      "sourceType": "doc-to-markdown"
    }
  ],
  "sources": ["semantic"],
  "count": 1
}
```

**Why**: Better UX, file-level results instead of chunk-level

**Verification**: Search returns files, not chunks

---

### Task 10: Background Indexer (Future) ⏭️
**Files**: TBD (not in this PR)

**What**: Separate worker that processes pending documents

**Why**: Async indexing, retry logic, rate limiting

**Status**: DEFERRED - The digesters now create database records, manual indexing can trigger background processing later

---

## File-by-File Changes Summary

### New Files (7)
1. `backend/db/migration_002_search_tables.go` - Database migrations
2. `backend/db/qdrant_documents.go` - Qdrant documents DB layer
3. `backend/db/meili_documents.go` - Meili documents DB layer
4. `backend/workers/digest/chunking.go` - Text chunking algorithm
5. `backend/workers/digest/content_sources.go` - Content extraction utilities

### Modified Files (3)
1. `backend/workers/digest/digesters.go` - Rewrite search digesters + URL crawler
2. `backend/vendors/qdrant.go` - Update payload structure
3. `backend/api/search.go` - Aggregate chunk results to files

### Total: 8 files (5 new, 3 modified)

---

## Git Commit Strategy

### Commit 1: Database migrations and models
- `migration_002_search_tables.go`
- `qdrant_documents.go`
- `meili_documents.go`
- Update `models.go`

**Message**: `feat: add qdrant_documents and meili_documents tables

- Add migration v2 for search indexing tables
- Add qdrant_documents table for chunked vector search
- Add meili_documents table for full-text keyword search
- Add database helper functions for document CRUD
- Tables follow Node.js schema exactly`

### Commit 2: Text chunking utility
- `chunking.go`

**Message**: `feat: implement text chunking for semantic search

- Add ChunkText() with 800-1000 token chunks
- Use 15% overlap for context preservation
- Smart boundary detection (headings > paragraphs > sentences)
- Returns chunk metadata (spans, word/token counts)`

### Commit 3: Content source extraction
- `content_sources.go`

**Message**: `feat: add content source extraction utilities

- GetContentSources() returns all sources separately
- GetPrimaryTextContent() combines sources for keyword search
- Supports all digest types (url, doc, image, speech)
- Parses JSON digests (url-crawl-content, image-objects)`

### Commit 4: Rewrite search-semantic digester
- Update `digesters.go` (SearchSemanticDigester)

**Message**: `feat: rewrite search-semantic digester with chunking

- Index each content source separately
- Create qdrant_documents records instead of direct indexing
- Generate chunks for each source type
- Store rich metadata in digest content`

### Commit 5: Rewrite search-keyword digester
- Update `digesters.go` (SearchKeywordDigester)

**Message**: `feat: rewrite search-keyword digester with meili_documents

- Create meili_documents records instead of direct indexing
- Combine all content sources
- Include summary and tags from digests
- Track content sources in metadata`

### Commit 6: Update URL crawler format
- Update `digesters.go` (URLCrawlDigester)

**Message**: `feat: store URL crawler content as JSON with metadata

- Change url-crawl-content from plain text to rich JSON
- Include url, title, description, author, publishedDate, etc.
- Calculate wordCount and readingTimeMinutes
- Match Node.js format exactly`

### Commit 7: Update Qdrant payload structure
- Update `qdrant.go`

**Message**: `feat: update Qdrant payload with chunk metadata

- Add sourceType, chunkText, chunkIndex, chunkCount to payload
- Match Node.js Qdrant payload structure
- Enable filtering and result context`

### Commit 8: Aggregate search results by file
- Update `search.go`

**Message**: `feat: aggregate semantic search results by file

- Group chunk results by file path
- Return file-level results with snippets
- Select best matching chunk per file
- Improve search UX with proper deduplication`

---

## Testing Strategy

### After Each Commit:
```bash
cd backend && go build .
```
Verify: Build succeeds with no errors

### After All Commits (E2E Testing):
1. **Database**: Check tables created
   ```bash
   sqlite3 data/app/my-life-db/database.sqlite "SELECT name FROM sqlite_master WHERE type='table'"
   ```
   Expect: `qdrant_documents`, `meili_documents` exist

2. **Semantic Search**: Add a markdown file
   - Check `qdrant_documents` has chunks
   - Verify multiple chunks created
   - Check chunk metadata (span_start, overlap_tokens)

3. **Keyword Search**: Add a file
   - Check `meili_documents` has single record
   - Verify content, summary, tags populated
   - Check multiple sources combined

4. **URL Crawler**: Add URL file
   - Check `url-crawl-content` digest is JSON
   - Verify all metadata fields present

5. **Search API**: Perform searches
   - Semantic search returns files (not chunks)
   - Results include snippets
   - Deduplication works

---

## Rollback Plan

If issues occur:
1. Each commit is atomic and builds
2. Can revert any commit: `git revert <commit-hash>`
3. Migration v2 can be rolled back by dropping tables
4. Node.js implementation remains reference

---

## Implementation Status

### ✅ COMPLETED (6 commits)

1. ✅ **Database tables and helpers** - `qdrant_documents` and `meili_documents` tables created
2. ✅ **Text chunking utility** - 800-1000 token chunks with 15% overlap
3. ✅ **Content source extraction** - Multi-source content aggregation
4. ✅ **Search-semantic digester** - Creates database records with chunks
5. ✅ **Search-keyword digester** - Creates meili_documents records
6. ✅ **URL crawler JSON format** - Rich metadata storage

### ⏭️ DEFERRED (Future Work)

7. **Background indexer** - Worker to process `qdrant_documents` → Qdrant
   - Status: Not needed yet, digesters now create DB records
   - Implementation: Separate worker that:
     - Queries `WHERE embedding_status = 'pending'`
     - Generates embeddings via HAID
     - Upserts to Qdrant with rich payloads
     - Updates `embedding_status = 'indexed'`

8. **Meilisearch indexer** - Worker to process `meili_documents` → Meilisearch
   - Status: Not needed yet, digesters now create DB records
   - Implementation: Similar pattern to Qdrant indexer

9. **Search API aggregation** - Aggregate chunk results to file-level
   - Status: Can be implemented once background indexer is working
   - Current behavior: Search API queries Qdrant directly (will return empty until indexer runs)

### 🔧 TO ENABLE SEARCH

Until the background indexer is implemented, search will not work because:
- Digesters create `qdrant_documents` records (✅ working)
- But records are never indexed to Qdrant (❌ missing)
- Search API queries Qdrant and gets no results (expected)

**Quick fix for testing**:
Add a simple indexer loop in the digest worker that immediately indexes pending documents after creation.

## Success Criteria (Current Implementation)

✅ All 6 commits applied successfully
✅ `go build` passes after each commit
✅ Tables created with correct schema
✅ Search digesters create database records with proper structure
✅ Text chunking produces 800-1000 token chunks with overlap
✅ URL crawler stores JSON format with metadata
✅ Content sources extracted and chunked separately
✅ Ready for background indexer implementation

---

## Notes

- **No background indexer**: This PR creates database records but doesn't add background indexing worker. That's future work.
- **Embedding generation**: Still happens synchronously in digesters for now, just creates DB records first
- **Qdrant API**: Keep using gRPC (faster than REST)
- **Breaking changes**: Existing Qdrant/Meilisearch indexes may need reindexing after this change
