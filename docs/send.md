# Local-First Send Workflow

## Design Principles

1. **Personal use**: Single user, optimize for common cases
2. **Robust**: Handle network failures, app restarts, and server downtime gracefully with auto-recovery
3. **Performance-first**: Avoid complex coordination unless critical
4. **Pragmatic**: Accept rare edge cases if cost is high
5. **Never lose data**: As soon as user hits "Send", content is saved and will eventually reach server

## Mental Model

1. **Send = Saved** - Hitting "Send" immediately saves content locally
2. **Visible Immediately** - Item appears in inbox feed with sync status
3. **Background Sync** - Upload happens in background with auto-retry
4. **Always Recoverable** - Network failures, app restarts, server downtime don't lose data

## Data Model

### IndexedDB Schema

Database: `mylife-inbox-queue`
Store: `pending-items`

```typescript
interface PendingInboxItem {
  // Identity
  id: string;                    // UUID (client-generated, also idempotency key)
  createdAt: string;            // ISO timestamp, used for ordering

  // Content (one of these must be present)
  text?: string;                // Text-only item (saved as inbox/{id}.md)
  file?: {                      // Single file item
    name: string;
    type: string;
    size: number;
    blob: Blob;                 // Actual file data
  };

  // Sync state
  status: 'pending' | 'uploading' | 'uploaded' | 'failed';
  uploadProgress: number;       // 0-100
  errorMessage?: string;

  // Retry metadata
  retryCount: number;
  nextRetryAt?: string;         // ISO timestamp for next retry
  lastAttemptAt?: string;

  // Multi-tab lock
  uploadingBy?: string;         // Tab ID currently uploading
  uploadingAt?: string;         // Lock timestamp (for stale detection)

  // TUS resumable upload tracking
  tusUploadUrl?: string;        // TUS upload URL for resume
  tusUploadOffset?: number;     // Bytes successfully uploaded

  // Server reference (once uploaded)
  serverPath?: string;          // e.g., 'inbox/photo.jpg' or 'inbox/{id}.md'
  uploadedAt?: string;
  serverVerified?: boolean;     // Saw item in GET /api/inbox?
  verificationAttempts?: number;
}
```

### Upload Queue Manager

```typescript
class UploadQueueManager {
  private queue: PendingInboxItem[] = [];
  private activeUploads = new Map<string, AbortController>();

  async init(): Promise<void>;          // Load from IndexedDB, start processing
  async enqueue(item: PendingInboxItem): Promise<void>;
  async processQueue(): Promise<void>;
  private async uploadItem(item: PendingInboxItem): Promise<void>;
  private async scheduleRetry(item: PendingInboxItem): Promise<void>;
  async cancelUpload(id: string): Promise<void>;
  async retryFailed(): Promise<void>;
}
```

## State Flow

```mermaid
flowchart TB
    Start([User clicks Send]) --> Save[1. Save to IndexedDB<br/>status: pending<br/>- Generate UUID<br/>- Store text + file blobs<br/>- Timestamp: now]
    Save --> UI[2. Add to UI<br/>- Render at bottom<br/>- Show ⏳ Pending badge<br/>- Enable offline access]
    UI --> Enqueue[3. Enqueue for upload<br/>- Add to UploadQueueManager<br/>- Trigger processQueue]
    Enqueue --> NetworkCheck{Network OK?}

    NetworkCheck -->|Yes| Upload[Upload Started<br/>status: uploading]
    NetworkCheck -->|No| Failed[Mark failed<br/>Schedule retry]

    Upload --> Progress[Show Progress<br/>📤 45%<br/>Update UI in real-time]
    Progress --> UploadCheck{Upload<br/>Success?}

    UploadCheck -->|No| Retry[Schedule Retry<br/>- Exponential backoff<br/>- Update nextRetryAt<br/>- Show ⚠️ badge]
    UploadCheck -->|Yes| Complete[4. Upload Complete<br/>status: uploaded<br/>- Store serverPath<br/>- Show ✓ Synced badge<br/>- Keep in IndexedDB 24h]

    Failed --> RetryTriggers[Auto-retry triggers:<br/>- Network change<br/>- Page focus<br/>- Timer exp backoff]
    Retry --> RetryTriggers
    RetryTriggers --> RetryCheck{Retry count<br/>< MAX?}
    RetryCheck -->|Yes| NetworkCheck
    RetryCheck -->|No| PermanentFail[Permanent Failure<br/>Show error panel<br/>Manual retry only]

    Complete --> Cleanup[Cleanup after 24h<br/>Remove from IndexedDB]

    style Start fill:#e1f5ff
    style Save fill:#fff4e6
    style UI fill:#fff4e6
    style Enqueue fill:#fff4e6
    style Upload fill:#e3f2fd
    style Progress fill:#e3f2fd
    style Complete fill:#e8f5e9
    style Failed fill:#ffebee
    style Retry fill:#fff3e0
    style PermanentFail fill:#ffcdd2
    style Cleanup fill:#f1f8e9
```

## Upload States & UI

| Status | Badge | Description | Actions |
|--------|-------|-------------|---------|
| `pending` | ⏳ Pending | Saved locally, not yet started | Cancel, View |
| `uploading` | 📤 45% | Upload in progress with percentage | Cancel, View |
| `uploaded` | ✓ Synced | Successfully uploaded to server | View, Delete |
| `failed` | ⚠️ Retry in 30s | Upload failed, auto-retry scheduled | Retry Now, Cancel, View |

## Send Button Behavior

**Before Click:**
- Enabled if text OR files present
- Text: "Send"

**After Click:**

1. **Immediate** (< 50ms):
   - Save to IndexedDB (all file sizes)
   - Generate optimistic item
   - Add to inbox feed UI
   - Clear input fields
   - Show success feedback

2. **Background** (async):
   - Enqueue for upload
   - Start TUS upload if network available

**User Experience:**
- Button never blocks
- Input clears immediately
- Item appears in feed instantly
- All files (any size) use same queue + TUS flow
- No warnings, no confirmations - it just works

## Upload Queue Processing

**Priority Order:**
1. Failed items with `nextRetryAt` in the past (oldest first)
2. Pending items (oldest first)

**Concurrency:**
- Max 2 concurrent uploads
- Each upload independent (one failure doesn't block others)

**Retry Strategy:**
- Exponential backoff: 5s, 10s, 20s, 40s, 60s (max)
- Jitter: ±10% to prevent thundering herd
- Max retries: 15 (~15 minutes total)
- Optimized for personal homelab server

**Retry Triggers:**
1. Timer-based (persisted in IndexedDB)
2. Network change (`online` event)
3. Page focus (`visibilitychange`)
4. Manual retry (user clicks "Retry Now")

## Edge Cases

| Category | Scenario | Behavior | Priority |
|----------|----------|----------|----------|
| **Network** | Offline when sending | Save locally, auto-retry when online | Critical |
| | Server returns 500 | Retry with exponential backoff (up to 60s) | Critical |
| | Upload timeout (3min) | Abort, retry with backoff | Critical |
| | Network switches | Resume from checkpoint (TUS) | High |
| **App Lifecycle** | Page refresh during upload | Resume from IndexedDB on reload | Critical |
| | App closed during upload | Resume when app reopens | Critical |
| | Browser crash | Item safe in IndexedDB, resumes on restart | Critical |
| | Reopened after days offline | All pending items resume automatically | Critical |
| **Upload Integrity** | Upload succeeds but client doesn't know | Idempotency key prevents duplicates | Critical |
| | Upload succeeds but finalize fails | Retry finalize only, reuse TUS upload IDs | High |
| | Server confirms but doesn't persist | 24h verification window before cleanup | High |
| | Upload stuck at 99% (5min) | Timeout, mark failed, allow retry | Medium |
| **Storage** | Very large file (>500MB) | Same flow, may hit IndexedDB quota | Low |
| | Disk quota exceeded | Yield error, cannot save to cache | High |
| | IndexedDB unavailable | Block send, show error (robustness requires persistence) | High |
| **User Actions** | Double-click send | Debounce submit, prevent duplicates | High |
| | Delete item while uploading | Cancel upload, remove from IndexedDB | High |
| | Edit pending/uploading item | Cancel upload, update, re-enqueue | Medium |
| **Server Behavior** | Server rejects (400) | Permanent failure, allow edit/cancel | High |
| | Max retries exceeded | Mark failed, manual retry only | Medium |
| **Multi-Tab** | Multiple tabs open | Simple lock via IndexedDB | High |
| | Tab crashes mid-upload | Other tabs detect stale lock (2min), take over | High |
| **Security** | Sensitive data in IndexedDB | Accept risk (personal device, disk encryption) | Low |
| | User logs out | Clear queue, delete IndexedDB records | Medium |

## TUS Resumable Upload Protocol

**Why TUS:**
- Robust network failure recovery (aligns with "Robust" design principle)
- Resume uploads after network switches, app restarts, tab crashes
- Efficient bandwidth usage (don't re-upload already transmitted bytes)

**Server Endpoints:**
```
POST   /api/upload/tus            # Create TUS upload
PATCH  /api/upload/tus/:id        # Resume/continue upload
HEAD   /api/upload/tus/:id        # Check upload status
POST   /api/upload/finalize       # Finalize after upload complete
```

**Supported TUS Extensions:**
- `creation` - Create uploads via POST
- `termination` - Delete abandoned uploads

**Upload Storage:**
- Temporary storage: `data/app/my-life-db/uploads/{uploadId}`
- Cleanup: TUS files deleted after successful finalization
- Stale uploads: Manual cleanup recommended (no automatic expiration)

**Upload Flow:**

**Initial Upload (first attempt):**
1. Client: `POST /api/upload/tus`
   - Headers: `Upload-Length: {fileSize}`, `Upload-Metadata: filename {base64Name}`, `Idempotency-Key: {itemId}`
   - Body: empty
2. Server: `201 Created`
   - Headers: `Location: /api/upload/tus/{uploadId}`, `Tus-Resumable: 1.0.0`
3. Client: Store `tusUploadUrl` in IndexedDB
4. Client: `PATCH /api/upload/tus/{uploadId}`
   - Headers: `Upload-Offset: 0`, `Content-Type: application/offset+octet-stream`
   - Body: file chunks
5. Server: Progress responses with `Upload-Offset: {bytesReceived}`
6. Client: Update `tusUploadOffset` in IndexedDB on each progress event
7. On completion: Call finalize endpoint

**Resume Upload (after interruption):**
1. Client loads item from IndexedDB, finds `tusUploadUrl` and `tusUploadOffset`
2. Client: `HEAD {tusUploadUrl}`
   - Verify server still has upload
3. Server: `200 OK`
   - Headers: `Upload-Offset: {serverOffset}`, `Upload-Length: {totalSize}`
4. Client: Resume from `serverOffset` using `PATCH` (skip already uploaded bytes)

**Fallback (TUS upload expired/lost):**
1. If `HEAD` returns 404/410: Clear `tusUploadUrl`, start fresh TUS upload
2. If server doesn't support TUS: Fall back to standard multipart upload

**Progress Tracking:**
```typescript
// Update IndexedDB on every PATCH progress event
await db.put('pending-items', {
  ...item,
  tusUploadOffset: bytesUploaded,
  uploadProgress: Math.floor((bytesUploaded / totalSize) * 100)
});
```

**Upload Expiration:**
- No automatic expiration currently implemented
- Incomplete uploads accumulate in `uploads/` directory
- Client handles missing uploads gracefully (start fresh if HEAD returns 404)
- **Risk:** Repeated failures could fill disk over time
- **Mitigation:** Personal use = bounded failures; manual cleanup if needed
- **Future consideration:** Background job to delete uploads >7 days old

**Multiple Files from User:**
- User selects 3 files → creates 3 separate `PendingInboxItem` entries
- Each file is independent (separate UUID, separate upload, separate retry)
- No coordination needed between files
- If one fails, others continue uploading

**Finalize Endpoint:**

Request to `POST /api/upload/finalize`:
```typescript
{
  text?: string;              // Text content (for text-only items)
  upload?: {                  // File upload (for file items)
    uploadId: string;         // TUS upload ID (from Location header)
    filename: string;         // Original filename
    size: number;             // File size in bytes
    type: string;             // MIME type
  };
}
```

Response (201 Created):
```typescript
{
  success: true;
  path: string;               // Created path (e.g., 'inbox/photo.jpg' or 'inbox/{id}.md')
}
```

**Idempotency:**
- MUST support `Idempotency-Key` header (IANA-registered standard, same UUID as item.id)
- Scope: per-endpoint (`/api/upload/tus`, `/api/upload/finalize`)
- TTL: 7 days (keys expire after this window)
- Server checks key before processing:
  - If key seen + original succeeded: return `200` with cached response (original path)
  - If key seen + original still processing: return `409 Conflict`
  - If key seen + different payload: return `409 Conflict` with error message
  - If key new: process normally, cache result (status + body)
- Key format: UUID v4, max 200 characters
- Prevents duplicates on network retry

**Finalize Behavior:**
1. Reads completed TUS upload from `uploads/{uploadId}`
2. Calls `saveToInbox()` to move file to inbox/
3. Deletes TUS temporary file
4. Triggers digest processing for created path
5. Returns path of created inbox item

## Multi-Tab Lock Mechanism

**Tab ID:** Generated on page load (`tab_{timestamp}_{random}`)
**Lock timeout:** 2 minutes

**Lock acquisition:**
1. Reload item from IndexedDB (get latest state)
2. Check if locked by another tab
3. If locked, check age (stale if >2min)
4. If stale or unlocked, acquire lock
5. Verify we got it (handle race conditions)

**Benefits:**
- Normal case: First tab wins, others skip
- Tab crash: Auto-recovery after 2min
- Race conditions: IndexedDB transactions prevent duplicates
- No complexity: No leader election, no messaging
- Fallback: Server idempotency catches edge cases

**Performance:** One extra IndexedDB read per upload (~1-5ms)

## Upload Verification

After successful upload:
1. Check if `serverPath` appears in GET `/api/inbox` response
2. Mark `serverVerified: true` if found
3. After 3 failed verification attempts: Keep indefinitely, show warning
4. Only delete from IndexedDB after 24h + `serverVerified: true`

## App Initialization

On every page load:
1. Load all pending items from IndexedDB
2. Filter items that need upload (pending + failed with retries left)
3. Sort by priority (ready retries first, then oldest)
4. Enqueue and start processing immediately

## Inbox Feed Integration

**Hybrid data source:**
```typescript
// Merge server items + local pending items
const allItems = [
  ...serverItems,
  ...pendingItems.map(toInboxItem)
].sort((a, b) => createdAt comparison);
```

**Visual differentiation:**
- Pending items: Subtle dimming + badge
- Click: Open preview from local blob (no server fetch)
- Context menu: "Cancel upload", "Retry now", "View locally"

**Scroll behavior:**
- New pending items auto-scroll to bottom
- Upload complete: Item stays in position, badge changes in-place

## IndexedDB Cleanup

**Strategy:**
1. Uploaded items: Delete after 24h (if `serverVerified`)
2. Failed items (max retries): Keep indefinitely, user dismisses
3. Pending items: Keep indefinitely until uploaded

**Frequency:** On app start + periodically

**Quota Handling:**
- Request persistent storage on first use (prevents browser eviction)
- If save fails due to quota: Show error "Cannot save - storage quota exceeded"
- User must manually delete failed items to free space
- No automatic cleanup, no export flow - user controls their data

## Error Recovery UI

**Failed items panel:**
- Collapsible banner: "⚠️ 3 items failed to upload"
- Expand: Show list with errors and actions
- Bulk actions: "Retry all", "Dismiss all"

**Per-item actions:**
- Retry Now (reset count, immediate upload)
- Edit (modify before retry)
- Cancel (remove from queue)
- View Details (error log, retry history)

## Implementation Phases

**Phase 1: Basic Local-First**
- IndexedDB save on send
- Optimistic UI rendering
- Basic upload with retry

**Phase 2: Robust Retry**
- Exponential backoff
- Network/focus triggers
- Failed items UI

**Phase 3: Advanced Features**
- Edit before retry
- Bulk operations
- Upload analytics

## Monitoring

**Console logging:**
```
[UploadQueue] Enqueued: {id}
[UploadQueue] Uploading: {id}, {progress}%
[UploadQueue] Success: {id}
[UploadQueue] Failed: {id}, {error}
[UploadQueue] Retry scheduled: {id}, next at {time}
```

**Metrics (localStorage):**
- Total attempts, successes, failures
- Average retries
- Success rate
