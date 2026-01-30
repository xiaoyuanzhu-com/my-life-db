# API Reference

## Overview

All API endpoints are prefixed with `/api`. The application uses React Router 7's file-based routing with REST conventions.

## Authentication

### POST /api/auth/login

Authenticate with password.

**Request:**
```json
{ "password": "string" }
```

**Response:**
```json
{ "success": true }
```

Sets `session` cookie on success.

**Errors:** 400 (missing password), 401 (invalid password)

---

### POST /api/auth/logout

End current session.

**Response:**
```json
{ "success": true }
```

Clears `session` cookie.

---

## Settings

### GET /api/settings

Get application settings (sanitized, secrets removed).

**Response:** `UserSettings` object

---

### PUT /api/settings

Update application settings.

**Request:** Partial `UserSettings` object

**Response:** Updated `UserSettings` object

---

### POST /api/settings

Reset settings to defaults.

**Request:**
```json
{ "action": "reset" }
```

**Response:** Default `UserSettings` object

---

## Stats

### GET /api/stats

Get application-wide statistics.

**Response:**
```json
{
  "library": { "fileCount": 0, "totalSize": 0 },
  "inbox": { "itemCount": 0 },
  "digests": { "totalFiles": 0, "digestedFiles": 0, "pendingDigests": 0 }
}
```

---

## Inbox

### GET /api/inbox

List inbox items with cursor-based pagination.

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `limit` | number | Items per page (default: 30) |
| `before` | string | Cursor for older items |
| `after` | string | Cursor for newer items |
| `around` | string | Cursor to center page on specific item |

**Response:**
```json
{
  "items": [InboxItem],
  "cursors": { "first": "string|null", "last": "string|null" },
  "hasMore": { "older": true, "newer": false },
  "targetIndex": 0  // Only for 'around' queries
}
```

---

### POST /api/inbox

Create new inbox item(s) via form data.

**Request:** `multipart/form-data`
| Field | Type | Description |
|-------|------|-------------|
| `text` | string | Optional text content |
| `files` | File[] | Optional file uploads |

**Response:**
```json
{ "path": "inbox/filename.md", "paths": ["inbox/file1.md", "inbox/file2.jpg"] }
```

**Status:** 201 Created

---

### GET /api/inbox/:id

Get single inbox item with enrichment status.

**Response:**
```json
{
  "path": "inbox/filename",
  "name": "filename",
  "isFolder": false,
  "files": [],
  "createdAt": "ISO timestamp",
  "updatedAt": "ISO timestamp",
  "enrichment": { /* digest status */ },
  "primaryText": "string|null",
  "digest": { "summary": "...", "tags": [...], "screenshot": "base64|null" }
}
```

---

### PUT /api/inbox/:id

Update markdown file content.

**Request:**
```json
{ "text": "new content" }
```

**Response:** Updated file record

**Note:** Only `.md` files can be edited.

---

### DELETE /api/inbox/:id

Delete inbox item (file or folder).

**Response:**
```json
{ "success": true }
```

---

### GET /api/inbox/:id/status

Get enrichment/digest status for inbox item.

**Response:** Digest status view object

---

### POST /api/inbox/:id/reenrich

Re-run all digesters for inbox item.

**Response:**
```json
{ "success": true, "message": "Digest processing complete." }
```

---

### GET /api/inbox/pinned

List pinned inbox items.

**Response:**
```json
{
  "items": [{
    "path": "inbox/file",
    "name": "file",
    "pinnedAt": "ISO timestamp",
    "displayText": "display name",
    "cursor": "cursor string"
  }]
}
```

---

## Upload (TUS Resumable)

### POST/PATCH/HEAD/DELETE /api/upload/tus

TUS protocol endpoint for resumable file uploads.

**Supported TUS Extensions:** `creation`, `termination`

**Headers:**
| Header | Description |
|--------|-------------|
| `Upload-Length` | Total file size |
| `Upload-Metadata` | Base64-encoded filename |
| `Idempotency-Key` | UUID to prevent duplicates |
| `Upload-Offset` | Resume offset (PATCH) |

See [send.md](send.md) for detailed TUS flow.

---

### POST /api/upload/finalize

Finalize TUS uploads and move to inbox.

**Request:**
```json
{
  "uploads": [{
    "uploadId": "tus-id",
    "filename": "photo.jpg",
    "size": 12345,
    "type": "image/jpeg"
  }],
  "text": "optional text content"
}
```

**Response:**
```json
{ "success": true, "path": "inbox/...", "paths": ["inbox/..."] }
```

---

## Digest

### GET /api/digest/:path

Get digest status for any file path.

**Response:**
```json
{ "status": { /* digest status view */ } }
```

---

### POST /api/digest/:path

Trigger digest processing for file.

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `digester` | string | Optional specific digester to run |

**Response:**
```json
{ "success": true, "message": "Digest processing complete." }
```

---

### GET /api/digest/digesters

List all registered digesters.

**Response:**
```json
{ "digesters": [{ "type": "...", "name": "...", ... }] }
```

---

### GET /api/digest/stats

Get digest statistics by type and status.

**Response:** Digest stats object with counts per digester type

---

### DELETE /api/digest/reset/:digester

Delete all digests for a specific digester type and re-create.

**Response:**
```json
{
  "message": "Successfully deleted N digest(s)",
  "count": 0,
  "digester": "summary",
  "embeddingsDeleted": 0
}
```

**Note:** Also clears related search indexes (Meilisearch/Qdrant) for search digesters.

---

## Search

### GET /api/search

Search files using keyword and/or semantic search.

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `q` | string | Search query (required, min 2 chars) |
| `limit` | number | Max results (default: 20, max: 100) |
| `offset` | number | Pagination offset |
| `type` | string | MIME type filter prefix |
| `path` | string | Path prefix filter |
| `types` | string | Search types: `keyword`, `semantic`, or `keyword,semantic` (default) |

**Response:**
```json
{
  "results": [{
    "path": "...",
    "name": "...",
    "score": 1.0,
    "snippet": "...",
    "highlights": { "content": "...", "summary": "...", "tags": "..." },
    "matchContext": { "source": "keyword|semantic", "snippet": "...", "terms": [...] }
  }],
  "pagination": { "total": 100, "limit": 20, "offset": 0, "hasMore": true },
  "query": "search terms",
  "timing": { "totalMs": 50, "searchMs": 30, "enrichMs": 20 },
  "sources": ["keyword", "semantic"]
}
```

---

## Library

### GET /api/library/tree

Get directory tree for file browser with optional recursion.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `path` | string | `""` | Relative path to list |
| `depth` | integer | `1` | Recursion depth. `1`=direct children, `2`=two levels, `0`=unlimited |
| `limit` | integer | unlimited | Maximum nodes to return |
| `fields` | string | all | Comma-separated fields: `path`, `type`, `size`, `modifiedAt` |
| `folder_only` | boolean | `false` | If `true`, return folders only |

**Response:**
```json
{
  "path": "notes",
  "children": [{
    "path": "notes/file.md",
    "type": "file",
    "size": 1234,
    "modifiedAt": "ISO timestamp"
  }, {
    "path": "notes/subfolder",
    "type": "folder",
    "children": []
  }]
}
```

**Examples:**
```bash
# Direct children only (default)
GET /api/library/tree?path=notes

# Two levels deep
GET /api/library/tree?path=notes&depth=2

# Unlimited depth, max 1000 nodes
GET /api/library/tree?path=notes&depth=0&limit=1000

# Only path and type fields
GET /api/library/tree?path=notes&fields=path,type
```

---

### GET /api/library/file-info

Get detailed file info with digests.

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | File path (required) |

**Response:**
```json
{
  "file": { /* FileRecord */ },
  "digests": [{ /* Digest objects */ }]
}
```

---

### DELETE /api/library/file

Delete a file or folder.

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | File path (required) |

**Response:**
```json
{ "success": true, "result": { /* deletion stats */ } }
```

**Note:** Cannot delete `app/` folder.

---

### POST /api/library/pin

Toggle pin state for a file.

**Request:**
```json
{ "path": "inbox/file.md" }
```

**Response:**
```json
{ "isPinned": true }
```

---

## Directories

### GET /api/directories

List directories.

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `parent` | string | Parent path (default: "library") |
| `path` | string | Get single directory by path |

**Response:**
```json
{ "directories": [...], "total": 5 }
```

---

### POST /api/directories

Create a new directory.

**Request:**
```json
{
  "name": "new-folder",
  "description": "optional",
  "parentPath": "library"
}
```

**Response:** Created directory object (201)

---

## Tasks (Background Jobs)

### GET /api/tasks

List tasks with optional filtering.

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `status` | string | Filter by status |
| `type` | string | Filter by task type |
| `limit` | number | Max results (default: 50) |
| `offset` | number | Pagination offset |
| `stats` | boolean | Include queue stats |

**Response:**
```json
{
  "tasks": [{ "id": "...", "type": "...", "status": "...", ... }],
  "total": 100,
  "limit": 50,
  "offset": 0,
  "stats": { /* optional */ }
}
```

---

### POST /api/tasks

Create a new task.

**Request:**
```json
{
  "type": "task-type",
  "input": { /* task-specific data */ },
  "run_after": "ISO timestamp (optional)"
}
```

**Response:** Created task object (201)

---

### GET /api/tasks/:id

Get single task by ID.

**Response:** Task object

---

### DELETE /api/tasks/:id

Delete a task.

**Response:**
```json
{ "success": true }
```

---

### GET /api/tasks/stats

Get task queue statistics.

**Response:**
```json
{
  "pending": 10,
  "completed": 100,
  "failed": 2,
  "pending_by_type": { "digest": 5, "search": 5 },
  "has_ready_tasks": true
}
```

---

### GET /api/tasks/status

Get combined queue and worker status.

**Response:**
```json
{
  "queue": { "pending": 10, "pending_by_type": {...}, "has_ready_tasks": true },
  "worker": { "running": true, "paused": false, "active_tasks": 2 }
}
```

---

### GET /api/tasks/worker/status

Get worker status only.

**Response:**
```json
{ "running": true, "paused": false }
```

---

### POST /api/tasks/worker/pause

Pause the task worker.

**Response:**
```json
{ "success": true, "status": { "running": true, "paused": true } }
```

---

### POST /api/tasks/worker/resume

Resume the task worker.

**Response:**
```json
{ "success": true, "status": { "running": true, "paused": false } }
```

---

## People (Speaker/Face Recognition)

### GET /api/people

List people with embedding counts.

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `pending` | boolean | Only unidentified |
| `identified` | boolean | Only identified |
| `limit` | number | Max results (default: 100) |
| `offset` | number | Pagination offset |

**Response:**
```json
{
  "people": [{ "id": "...", "displayName": "...", "voiceCount": 5, "faceCount": 3 }],
  "total": 50,
  "limit": 100,
  "offset": 0
}
```

---

### POST /api/people

Create a new person.

**Request:**
```json
{ "displayName": "John Doe" }
```

**Response:** Created person object (201)

---

### GET /api/people/:id

Get person with clusters and embeddings.

**Response:**
```json
{
  "id": "...",
  "displayName": "...",
  "clusters": { "voice": [...], "face": [...] },
  "embeddings": { "voice": [...], "face": [...] }
}
```

---

### PUT /api/people/:id

Update person.

**Request:**
```json
{ "displayName": "New Name" }
```

**Response:** Updated person object

---

### DELETE /api/people/:id

Delete person (unassigns all embeddings).

**Response:**
```json
{ "success": true }
```

---

### POST /api/people/:id/merge

Merge another person into this one.

**Request:**
```json
{ "sourceId": "person-to-merge" }
```

**Response:** Merged person object

---

### POST /api/people/embeddings/:id/assign

Assign an embedding to a person.

**Request:**
```json
{ "peopleId": "person-id" }
```

**Response:**
```json
{
  "embedding": { /* without vector */ },
  "cluster": { /* without centroid */ }
}
```

---

### POST /api/people/embeddings/:id/unassign

Unassign an embedding from its person/cluster.

**Response:**
```json
{ "embedding": { /* updated embedding */ } }
```

---

## Notifications

### GET /api/notifications/stream

Server-Sent Events stream for real-time updates.

**Events:**
| Type | Description |
|------|-------------|
| `connected` | Initial connection confirmation |
| `inbox-changed` | Inbox content changed (add/update/delete) |
| `pin-changed` | Pin state changed |

**Headers:**
```
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
```

Heartbeat sent every 30 seconds.

---

## Vendors

### GET /api/vendors/openai/models

List available OpenAI models (requires configured API key).

**Response:**
```json
{
  "models": [{ "id": "gpt-4", "owned_by": "openai" }]
}
```

**Errors:** 400 (API key not configured)

---

## Error Response Format

All endpoints return errors in this format:

```json
{
  "error": "Human-readable error message",
  "code": "ERROR_CODE",  // Optional
  "details": "..."       // Optional additional info
}
```

Common HTTP status codes:
- `400` - Bad Request (invalid input)
- `401` - Unauthorized
- `403` - Forbidden
- `404` - Not Found
- `405` - Method Not Allowed
- `500` - Internal Server Error
- `503` - Service Unavailable (search not configured)
