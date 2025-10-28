# Inbox Implementation Summary

## ✅ Completed Features

### Database Schema
- **4 migrations** implemented with auto-run on app startup:
  1. Settings table (existing)
  2. Inbox table with file-based schema
  3. Library table for file indexing
  4. Metadata schemas registry for evolution tracking

### File Structure
```
MY_DATA_DIR/
├── .app/
│   └── mylifedb/
│       ├── database.sqlite          # All metadata
│       └── inbox/
│           └── {uuid}/              # Initially UUID
│               ├── text.md          # User text (if provided)
│               ├── photo.jpg        # Files (if provided)
│               └── photo 2.jpg      # Deduped files
```

### Core Implementation

**Database Operations** ([src/lib/db/inbox.ts](src/lib/db/inbox.ts)):
- `createInboxRecord()` - Insert into database
- `getInboxItemById()` - Fetch by UUID
- `listInboxItems()` - List with filters
- `updateInboxItem()` - Update partial fields
- `deleteInboxItem()` - Delete from database

**Inbox Entry Creation** ([src/lib/inbox/createInboxEntry.ts](src/lib/inbox/createInboxEntry.ts)):
- File-based approach (text.md is just another file)
- Saves to `.app/mylifedb/inbox/{uuid}/`
- Handles file deduplication (macOS-style: `photo.jpg` → `photo 2.jpg`)
- Computes SHA256 hash for each file
- Determines message type automatically
- Creates database record
- Returns `InboxItem` with full metadata

**File Deduplication** ([src/lib/fs/fileDeduplication.ts](src/lib/fs/fileDeduplication.ts)):
- `getUniqueFilename()` - Single file deduplication
- `getUniqueFilenames()` - Batch processing with duplicate handling
- Follows macOS/Linux convention: space + number suffix

**API Routes**:
- `POST /api/inbox` - Create new inbox item ([src/app/api/inbox/route.ts](src/app/api/inbox/route.ts))
- `GET /api/inbox` - List inbox items with filters
- `GET /api/inbox/[id]` - Get single inbox item
- `DELETE /api/inbox/[id]` - Delete item + files

### TypeScript Types ([src/types/index.ts](src/types/index.ts))
```typescript
interface InboxItem {
  id: string;                    // UUID (permanent)
  folderName: string;            // uuid initially, then slug
  type: MessageType;             // text, url, image, etc.
  files: InboxFile[];            // All files (including text.md)
  status: ProcessingStatus;      // pending, processing, completed, failed
  processedAt: string | null;
  error: string | null;
  aiSlug: string | null;         // For folder rename
  schemaVersion: number;         // For evolution
  createdAt: string;
  updatedAt: string;
}

interface InboxFile {
  filename: string;
  size: number;
  mimeType: string;
  type: FileType;
  hash?: string;                 // SHA256
  enrichment?: {                 // For future AI processing
    caption?: string;
    ocr?: string;
    transcription?: string;
    // ... extensible
  };
}
```

## 📋 Testing Checklist

### Manual Testing (User)

1. **Test text-only input**:
   ```bash
   curl -X POST http://localhost:3000/api/inbox \
     -F "text=This is a test note"
   ```

2. **Test file-only input**:
   ```bash
   curl -X POST http://localhost:3000/api/inbox \
     -F "files=@photo.jpg"
   ```

3. **Test text + files**:
   ```bash
   curl -X POST http://localhost:3000/api/inbox \
     -F "text=Here's a photo from my trip" \
     -F "files=@photo.jpg" \
     -F "files=@document.pdf"
   ```

4. **Test duplicate filenames**:
   ```bash
   curl -X POST http://localhost:3000/api/inbox \
     -F "files=@photo.jpg" \
     -F "files=@photo.jpg" \
     -F "files=@photo.jpg"
   # Should create: photo.jpg, photo 2.jpg, photo 3.jpg
   ```

5. **Test URL detection**:
   ```bash
   curl -X POST http://localhost:3000/api/inbox \
     -F "text=https://example.com/article"
   # Should have type: 'url'
   ```

6. **List inbox items**:
   ```bash
   curl http://localhost:3000/api/inbox
   ```

7. **Get specific item**:
   ```bash
   curl http://localhost:3000/api/inbox/{id}
   ```

8. **Delete item**:
   ```bash
   curl -X DELETE http://localhost:3000/api/inbox/{id}
   ```

9. **Verify file structure**:
   ```bash
   ls -la data/.app/mylifedb/inbox/{uuid}/
   # Should see text.md and/or uploaded files
   ```

10. **Check database**:
    ```bash
    sqlite3 data/.app/mylifedb/database.sqlite "SELECT * FROM inbox;"
    ```

### Expected Behaviors

✅ **Text input** → Creates `text.md` file
✅ **Files** → Saved with original names
✅ **Duplicates** → Auto-renamed with space suffix
✅ **URLs** → Detected and typed correctly
✅ **Database** → Record created with JSON files array
✅ **Validation** → Rejects empty requests
✅ **Error handling** → Returns 500 with error details

## 🔄 Next Steps (Future Work)

1. **Background Processing**:
   - Implement job queue for AI enrichment
   - Generate AI slug for folder rename
   - Extract metadata from files
   - Update schema version when enrichment changes

2. **URL Crawling**:
   - Add Playwright integration
   - Create `content.html`, `screenshot.png`, `main-content.md`
   - Extract metadata (title, author, date)

3. **Schema Evolution**:
   - Implement `detectSchemaVersion()` function
   - Add UI badge for outdated items
   - Add "Re-process" button

4. **Move to Library**:
   - Implement inbox → library workflow
   - Detect user's organization patterns
   - Learn from user moves

## 📦 Database Schema

### Inbox Table
```sql
CREATE TABLE inbox (
  id TEXT PRIMARY KEY,
  folder_name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  files TEXT NOT NULL,              -- JSON array
  status TEXT DEFAULT 'pending',
  processed_at TEXT,
  error TEXT,
  ai_slug TEXT,
  schema_version INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### Files JSON Schema
```json
[
  {
    "filename": "text.md",
    "size": 1234,
    "mimeType": "text/markdown",
    "type": "text",
    "hash": "sha256...",
    "enrichment": {}
  },
  {
    "filename": "photo.jpg",
    "size": 56789,
    "mimeType": "image/jpeg",
    "type": "image",
    "hash": "sha256...",
    "enrichment": {
      "caption": "A beautiful sunset",
      "ocr": "extracted text...",
      "faces": [...]
    }
  }
]
```

## 🎯 Design Principles

1. **No Vendor Lock-in**: Files stored cleanly, no proprietary formats
2. **Schema Evolution**: Version tracking enables smooth upgrades
3. **Unified Files**: Text treated same as attachments
4. **Database-only Metadata**: No `.meta.json` pollution
5. **Backward Compatible**: Old schemas won't break app
6. **Re-processable**: Can regenerate metadata from raw files

## 📁 Files Changed

- `docs/tech-design.md` - Updated schema design
- `src/lib/db/connection.ts` - Added migration runner
- `src/lib/db/migrations/*` - 4 migration files
- `src/lib/db/inbox.ts` - Database operations
- `src/lib/inbox/createInboxEntry.ts` - Entry creation logic
- `src/lib/fs/storage.ts` - Updated paths
- `src/lib/fs/fileDeduplication.ts` - Deduplication logic
- `src/types/index.ts` - New types (InboxItem, InboxFile, LibraryFile)
- `src/app/api/inbox/route.ts` - POST/GET endpoints
- `src/app/api/inbox/[id]/route.ts` - GET/DELETE endpoints

Ready for testing! 🚀
