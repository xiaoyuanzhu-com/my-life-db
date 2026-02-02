# MyLifeDB API Documentation

This document describes the REST API endpoints for the MyLifeDB backend. Mobile app developers should use this as a reference for implementing iOS and Android clients.

**Base URL**: `http://{host}:{port}` (default: `http://localhost:12345`)

**Content-Type**: All requests and responses use `application/json` unless otherwise specified.

---

## Table of Contents

1. [Authentication](#authentication)
2. [Inbox](#inbox)
3. [Library (File Management)](#library-file-management)
4. [Search](#search)
5. [Digest (Content Processing)](#digest-content-processing)
6. [People (Face/Voice Recognition)](#people-facevoice-recognition)
7. [Settings](#settings)
8. [Statistics](#statistics)
9. [AI](#ai)
10. [File Upload (TUS Protocol)](#file-upload-tus-protocol)
11. [Raw Files](#raw-files)
12. [SQLAR Files](#sqlar-files)
13. [Notifications (SSE)](#notifications-sse)
14. [Vendors](#vendors)
15. [Directories](#directories)
16. [Claude Code Integration](#claude-code-integration)
17. [Data Models](#data-models)

---

## Authentication

MyLifeDB supports three authentication modes configured via the `MLD_AUTH_MODE` environment variable:

- `none` - No authentication required (default)
- `password` - Simple password authentication
- `oauth` - OIDC/OAuth 2.0 authentication

### Password Authentication

#### Login

```http
POST /api/auth/login
```

**Request Body:**
```json
{
  "password": "string"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "sessionId": "string"
}
```

**Response (401 Unauthorized):**
```json
{
  "success": false,
  "error": "Invalid password"
}
```

**Notes:**
- Sets an HTTP-only `session` cookie valid for 30 days
- First login with no password set will create the password

#### Logout

```http
POST /api/auth/logout
```

**Response (200 OK):**
```json
{
  "success": true
}
```

### OAuth/OIDC Authentication

#### Start OAuth Flow

```http
GET /api/oauth/authorize
```

**Response:** Redirects to the configured OIDC provider's authorization endpoint.

#### OAuth Callback

```http
GET /api/oauth/callback
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `code` | string | Authorization code from OIDC provider |

**Response:** Redirects to `/` on success, or `/?error={error_code}` on failure.

#### Check Token Status

```http
GET /api/oauth/token
```

**Response (200 OK - Authenticated):**
```json
{
  "authenticated": true,
  "username": "string",
  "sub": "string",
  "email": "string"
}
```

**Response (200 OK - Not Authenticated):**
```json
{
  "authenticated": false
}
```

#### Refresh Token

```http
POST /api/oauth/refresh
```

**Response (200 OK):**
```json
{
  "success": true,
  "expiresIn": 3600
}
```

**Response (401 Unauthorized):**
```json
{
  "error": "No refresh token provided"
}
```

#### OAuth Logout

```http
POST /api/oauth/logout
```

**Response (200 OK):**
```json
{
  "success": true
}
```

---

## Inbox

The inbox is a special folder for unprocessed files. Items in inbox are typically processed by digesters and may be moved to the library.

### List Inbox Items

```http
GET /api/inbox
```

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | integer | 30 | Number of items to return (max 100) |
| `before` | string | - | Cursor for pagination (get items before this cursor) |
| `after` | string | - | Cursor for pagination (get items after this cursor) |
| `around` | string | - | Cursor to center the results around (for pin navigation) |

**Response (200 OK):**
```json
{
  "items": [
    {
      "path": "inbox/file.md",
      "name": "file.md",
      "isFolder": false,
      "size": 1024,
      "mimeType": "text/markdown",
      "hash": "sha256:abc123...",
      "modifiedAt": "2024-01-15T10:30:00Z",
      "createdAt": "2024-01-15T10:30:00Z",
      "digests": [],
      "textPreview": "First 500 characters of content...",
      "screenshotSqlar": "screenshots/abc123.png",
      "isPinned": false
    }
  ],
  "cursors": {
    "first": "2024-01-15T10:30:00Z:inbox/file.md",
    "last": "2024-01-14T08:00:00Z:inbox/other.md"
  },
  "hasMore": {
    "older": true,
    "newer": false
  },
  "targetIndex": 5
}
```

### Create Inbox Item

```http
POST /api/inbox
Content-Type: multipart/form-data
```

**Form Fields:**
| Field | Type | Description |
|-------|------|-------------|
| `text` | string | Text content to save as markdown file |
| `files` | file[] | Files to upload |

**Note:** At least one of `text` or `files` must be provided.

**Response (201 Created):**
```json
{
  "path": "inbox/uuid.md",
  "paths": ["inbox/uuid.md", "inbox/photo.jpg"]
}
```

### Get Inbox Item

```http
GET /api/inbox/:id
```

**Path Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Filename in inbox (e.g., "file.md") |

**Response (200 OK):**
```json
{
  "path": "inbox/file.md",
  "name": "file.md",
  "isFolder": false,
  "size": 1024,
  "mimeType": "text/markdown",
  "hash": "sha256:abc123...",
  "modifiedAt": "2024-01-15T10:30:00Z",
  "createdAt": "2024-01-15T10:30:00Z",
  "textPreview": "Preview text...",
  "screenshotSqlar": "screenshots/abc123.png",
  "digests": [
    {
      "id": "uuid",
      "filePath": "inbox/file.md",
      "digester": "tags",
      "status": "completed",
      "content": "{\"tags\": [\"work\", \"notes\"]}",
      "createdAt": "2024-01-15T10:30:00Z",
      "updatedAt": "2024-01-15T10:35:00Z"
    }
  ]
}
```

### Update Inbox Item

```http
PUT /api/inbox/:id
```

**Request Body:**
```json
{
  "content": "Updated file content..."
}
```

**Response (200 OK):**
```json
{
  "success": "true"
}
```

### Delete Inbox Item

```http
DELETE /api/inbox/:id
```

**Response (200 OK):**
```json
{
  "success": "true"
}
```

### Get Pinned Inbox Items

```http
GET /api/inbox/pinned
```

**Response (200 OK):**
```json
{
  "items": [
    {
      "path": "inbox/important.md",
      "name": "important.md",
      "pinnedAt": "2024-01-15T10:30:00Z",
      "displayText": "First line of content or filename",
      "cursor": "2024-01-15T10:30:00Z:inbox/important.md"
    }
  ]
}
```

### Re-enrich Inbox Item

Triggers re-processing of all digesters for an item.

```http
POST /api/inbox/:id/reenrich
```

**Response (200 OK):**
```json
{
  "success": "true",
  "message": "Re-enrichment triggered"
}
```

### Get Inbox Item Status

```http
GET /api/inbox/:id/status
```

**Response (200 OK):**
```json
{
  "status": "processing",
  "digests": [
    {
      "id": "uuid",
      "digester": "tags",
      "status": "completed"
    },
    {
      "id": "uuid2",
      "digester": "image-captioning",
      "status": "running"
    }
  ]
}
```

**Status Values:**
- `done` - All digests completed
- `processing` - At least one digest is running
- `pending` - Digests are queued (todo) or failed

---

## Library (File Management)

### Get Library Tree

Returns a hierarchical tree of files and folders.

```http
GET /api/library/tree
```

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `path` | string | "" | Directory path (relative to data root or absolute) |
| `depth` | integer | 1 | Recursion depth (0 = unlimited) |
| `limit` | integer | 0 | Max nodes to return (0 = unlimited) |
| `fields` | string | "path,type,size,modifiedAt" | Comma-separated fields to include |
| `folderOnly` | boolean | false | Return folders only |

**Response (200 OK):**
```json
{
  "basePath": "/path/to/data",
  "path": "notes",
  "children": [
    {
      "path": "work",
      "type": "folder",
      "children": [
        {
          "path": "meeting.md",
          "type": "file",
          "size": 2048,
          "modifiedAt": "2024-01-15T10:30:00Z"
        }
      ]
    },
    {
      "path": "personal.md",
      "type": "file",
      "size": 512,
      "modifiedAt": "2024-01-14T08:00:00Z"
    }
  ]
}
```

### Get File Info

```http
GET /api/library/file-info
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | **Required.** Relative path to file |

**Response (200 OK):**
```json
{
  "path": "notes/meeting.md",
  "name": "meeting.md",
  "isFolder": false,
  "size": 2048,
  "mimeType": "text/markdown",
  "hash": "sha256:abc123...",
  "modifiedAt": "2024-01-15T10:30:00Z",
  "createdAt": "2024-01-10T14:00:00Z",
  "textPreview": "Meeting notes from...",
  "digests": []
}
```

### Delete File

```http
DELETE /api/library/file
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | **Required.** Relative path to file or folder |

**Response (200 OK):**
```json
{
  "success": "true"
}
```

### Rename File

```http
POST /api/library/rename
```

**Request Body:**
```json
{
  "path": "notes/old-name.md",
  "newName": "new-name.md"
}
```

**Response (200 OK):**
```json
{
  "newPath": "notes/new-name.md"
}
```

**Response (409 Conflict):**
```json
{
  "error": "A file with this name already exists"
}
```

### Move File

```http
POST /api/library/move
```

**Request Body:**
```json
{
  "path": "inbox/file.md",
  "targetPath": "notes/work"
}
```

**Note:** Empty `targetPath` moves to data root.

**Response (200 OK):**
```json
{
  "newPath": "notes/work/file.md"
}
```

### Create Folder

```http
POST /api/library/folder
```

**Request Body:**
```json
{
  "path": "notes",
  "name": "new-folder"
}
```

**Response (200 OK):**
```json
{
  "path": "notes/new-folder"
}
```

### Pin File (Toggle)

Toggles the pin state of a file.

```http
POST /api/library/pin
```

**Request Body:**
```json
{
  "path": "inbox/important.md"
}
```

**Response (200 OK):**
```json
{
  "isPinned": true
}
```

### Unpin File

```http
DELETE /api/library/pin
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | **Required.** Path to file |

**Response (200 OK):**
```json
{
  "success": "true"
}
```

---

## Search

### Search Files

Supports keyword search (Meilisearch), semantic search (Qdrant/embeddings), or fallback database search.

```http
GET /api/search
```

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `q` | string | **Required** | Search query (min 2 characters) |
| `limit` | integer | 20 | Number of results (max 100) |
| `offset` | integer | 0 | Pagination offset |
| `type` | string | - | Filter by MIME type |
| `path` | string | - | Filter by path prefix |
| `types` | string | "keyword,semantic" | Search types to use (comma-separated) |

**Response (200 OK):**
```json
{
  "results": [
    {
      "path": "notes/meeting.md",
      "name": "meeting.md",
      "isFolder": false,
      "size": 2048,
      "mimeType": "text/markdown",
      "modifiedAt": "2024-01-15T10:30:00Z",
      "createdAt": "2024-01-10T14:00:00Z",
      "digests": [],
      "score": 0.95,
      "snippet": "...relevant excerpt with <em>highlighted</em> terms...",
      "textPreview": "Full text preview...",
      "screenshotSqlar": "screenshots/abc123.png",
      "highlights": {
        "content": "...with <em>search term</em>..."
      },
      "matchContext": {
        "source": "digest",
        "snippet": "Matched text...",
        "terms": ["search", "term"],
        "digest": {
          "type": "content",
          "label": "Document content"
        }
      },
      "matchedObject": {
        "title": "laptop",
        "bbox": [100, 200, 300, 400],
        "rle": {
          "size": [480, 640],
          "counts": [...]
        }
      }
    }
  ],
  "pagination": {
    "total": 42,
    "limit": 20,
    "offset": 0,
    "hasMore": true
  },
  "query": "meeting notes",
  "timing": {
    "totalMs": 45,
    "searchMs": 30,
    "enrichMs": 15
  },
  "sources": ["keyword", "semantic"]
}
```

**Search Types:**
- `keyword` - Full-text search via Meilisearch
- `semantic` - Vector similarity search via Qdrant
- `database` - Fallback SQLite LIKE search

---

## Digest (Content Processing)

Digesters extract metadata, generate summaries, and enrich files automatically.

### List Available Digesters

```http
GET /api/digest/digesters
```

**Response (200 OK):**
```json
{
  "digesters": [
    {
      "name": "tags",
      "label": "Tags",
      "description": "Generate tags using AI",
      "outputs": ["tags"]
    },
    {
      "name": "url-crawler",
      "label": "URL Crawler",
      "description": "Crawl and extract content from URLs",
      "outputs": ["url-crawler"]
    },
    {
      "name": "image-captioning",
      "label": "Image Captioning",
      "description": "Generate image captions",
      "outputs": ["image-captioning"]
    },
    {
      "name": "speech-recognition",
      "label": "Speech Recognition",
      "description": "Transcribe audio/video",
      "outputs": ["speech-recognition"]
    }
  ]
}
```

**Available Digesters:**
| Name | Description |
|------|-------------|
| `tags` | Generate tags using AI |
| `url-crawler` | Crawl and extract content from URLs |
| `url-crawl-summary` | Summarize crawled URL content |
| `doc-to-markdown` | Convert documents to markdown |
| `doc-to-screenshot` | Generate document screenshots |
| `image-captioning` | Generate image captions |
| `image-ocr` | Extract text from images (OCR) |
| `image-objects` | Detect objects in images |
| `speech-recognition` | Transcribe audio/video |
| `speech-recognition-cleanup` | Clean up transcripts |
| `speech-recognition-summary` | Summarize transcripts |
| `speaker-embedding` | Extract speaker voice embeddings |
| `search-keyword` | Index for keyword search |
| `search-semantic` | Index for semantic search |

### Get Digest Stats

```http
GET /api/digest/stats
```

**Response (200 OK):**
```json
{
  "byDigester": {
    "tags": {"todo": 5, "running": 1, "done": 100, "failed": 2, "skipped": 10},
    "image-captioning": {"todo": 0, "running": 0, "done": 50, "failed": 0, "skipped": 5}
  },
  "byStatus": {
    "todo": 5,
    "running": 1,
    "done": 150,
    "failed": 2,
    "skipped": 15
  },
  "total": 173
}
```

### Get File Digests

```http
GET /api/digest/file/*path
```

**Example:** `GET /api/digest/file/inbox/photo.jpg`

**Response (200 OK):**
```json
{
  "path": "inbox/photo.jpg",
  "status": "processing",
  "digests": [
    {
      "id": "uuid",
      "filePath": "inbox/photo.jpg",
      "digester": "image-captioning",
      "status": "completed",
      "content": "{\"caption\": \"A sunset over the ocean\"}",
      "createdAt": "2024-01-15T10:30:00Z",
      "updatedAt": "2024-01-15T10:35:00Z"
    }
  ]
}
```

### Trigger Digest Processing

```http
POST /api/digest/file/*path
```

**Request Body (optional):**
```json
{
  "digester": "image-captioning",
  "force": true
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Digest processing triggered",
  "path": "inbox/photo.jpg"
}
```

### Reset Digester

Resets all digests of a specific type to "todo" status.

```http
DELETE /api/digest/reset/:digester
```

**Response (200 OK):**
```json
{
  "success": true,
  "affected": 42
}
```

---

## People (Face/Voice Recognition)

### List People

```http
GET /api/people
```

**Response (200 OK):**
```json
[
  {
    "id": "uuid",
    "displayName": "John Doe",
    "createdAt": "2024-01-15T10:30:00Z",
    "updatedAt": "2024-01-15T10:30:00Z"
  }
]
```

### Create Person

```http
POST /api/people
```

**Request Body:**
```json
{
  "displayName": "John Doe"
}
```

**Response (201 Created):**
```json
{
  "id": "uuid",
  "displayName": "John Doe",
  "createdAt": "2024-01-15T10:30:00Z",
  "updatedAt": "2024-01-15T10:30:00Z"
}
```

### Get Person

```http
GET /api/people/:id
```

**Response (200 OK):**
```json
{
  "id": "uuid",
  "displayName": "John Doe",
  "createdAt": "2024-01-15T10:30:00Z",
  "updatedAt": "2024-01-15T10:30:00Z",
  "clusters": [
    {
      "id": "cluster-uuid",
      "peopleId": "uuid",
      "clusterType": "face",
      "sampleCount": 15,
      "createdAt": "2024-01-15T10:30:00Z",
      "updatedAt": "2024-01-16T14:00:00Z"
    }
  ]
}
```

### Update Person

```http
PUT /api/people/:id
```

**Request Body:**
```json
{
  "displayName": "John Smith"
}
```

**Response (200 OK):**
```json
{
  "success": "true"
}
```

### Delete Person

```http
DELETE /api/people/:id
```

**Response (200 OK):**
```json
{
  "success": "true"
}
```

### Merge People

Merges all clusters from source person into target person.

```http
POST /api/people/:id/merge
```

**Path Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Target person ID |

**Request Body:**
```json
{
  "sourceId": "source-person-uuid"
}
```

**Response (200 OK):**
```json
{
  "success": "true"
}
```

### Assign Embedding to Person

```http
POST /api/people/embeddings/:id/assign
```

**Request Body:**
```json
{
  "personId": "person-uuid"
}
```

**Response (200 OK):**
```json
{
  "success": "true"
}
```

### Unassign Embedding

```http
POST /api/people/embeddings/:id/unassign
```

**Response (200 OK):**
```json
{
  "success": "true"
}
```

---

## Settings

### Get Settings

```http
GET /api/settings
```

**Response (200 OK):**
```json
{
  "preferences": {
    "theme": "auto",
    "defaultView": "inbox",
    "weeklyDigest": false,
    "digestDay": 0,
    "logLevel": "info",
    "userEmail": "user@example.com",
    "languages": ["en", "zh"]
  },
  "vendors": {
    "openai": {
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "********",
      "model": "gpt-4o-mini"
    },
    "homelabAi": {
      "baseUrl": "http://localhost:8080",
      "chromeCdpUrl": "http://localhost:9222"
    },
    "aliyun": {
      "apiKey": "********",
      "region": "beijing",
      "asrProvider": "fun-asr-realtime"
    },
    "meilisearch": {
      "host": "http://localhost:7700"
    },
    "qdrant": {
      "host": "http://localhost:6333"
    }
  },
  "digesters": {
    "tags": true,
    "image-captioning": true,
    "speech-recognition": false
  },
  "extraction": {
    "autoEnrich": true,
    "includeEntities": true,
    "includeSentiment": false,
    "includeActionItems": true,
    "includeRelatedEntries": false,
    "minConfidence": 0.7
  },
  "storage": {
    "dataPath": "/data",
    "backupPath": "/backups",
    "autoBackup": true,
    "maxFileSize": 104857600
  }
}
```

**Note:** API keys are masked with asterisks in responses.

### Update Settings

```http
PUT /api/settings
```

**Request Body:** Partial settings object (only include fields to update)

```json
{
  "preferences": {
    "theme": "dark"
  },
  "digesters": {
    "speech-recognition": true
  }
}
```

**Response (200 OK):** Returns the complete updated settings object.

**Note:** Masked API keys (`********`) are ignored and won't update the stored value.

### Reset Settings

```http
POST /api/settings
```

**Request Body:**
```json
{
  "action": "reset"
}
```

**Response (200 OK):** Returns the default settings object.

---

## Statistics

### Get Application Stats

```http
GET /api/stats
```

**Response (200 OK):**
```json
{
  "library": {
    "fileCount": 1234,
    "totalSize": 5368709120
  },
  "inbox": {
    "itemCount": 42
  },
  "digests": {
    "totalFiles": 1276,
    "digestedFiles": 1200,
    "pendingDigests": 76
  }
}
```

---

## AI

### Summarize Text

Generates an AI summary of the provided text.

```http
POST /api/ai/summarize
```

**Request Body:**
```json
{
  "text": "Long transcript or document text...",
  "max_tokens": 300
}
```

**Response (200 OK):**
```json
{
  "summary": "• Key point 1\n• Key point 2\n• Action items..."
}
```

**Response (503 Service Unavailable):**
```json
{
  "error": "OpenAI API key not configured. Please set OPENAI_API_KEY environment variable."
}
```

---

## File Upload (TUS Protocol)

MyLifeDB uses the [TUS protocol](https://tus.io/) for resumable file uploads.

### TUS Endpoints

```http
POST /api/upload/tus/
HEAD /api/upload/tus/:id
PATCH /api/upload/tus/:id
DELETE /api/upload/tus/:id
OPTIONS /api/upload/tus/
```

**Configuration:**
- Max file size: 10GB
- Base path: `/api/upload/tus/`

### Finalize Upload

After TUS upload completes, finalize to move files to destination.

```http
POST /api/upload/finalize
```

**Request Body:**
```json
{
  "uploads": [
    {
      "uploadId": "tus-upload-id",
      "filename": "document.pdf",
      "size": 1048576,
      "type": "application/pdf"
    }
  ],
  "destination": "inbox",
  "text": "Optional text note to create"
}
```

**Destination Options:**
- `null` or omitted: defaults to `"inbox"`
- `""` (empty string): data root
- `"path/to/folder"`: specific folder

**Response (200 OK):**
```json
{
  "success": true,
  "path": "inbox/document.pdf",
  "paths": ["inbox/document.pdf"]
}
```

---

## Raw Files

Direct file access for reading and writing.

### Get Raw File

```http
GET /raw/*path
```

**Example:** `GET /raw/inbox/photo.jpg`

**Response:** File contents with appropriate `Content-Type` header.

### Save Raw File

```http
PUT /raw/*path
```

**Request Body:** Raw file content

**Response (200 OK):**
```json
{
  "success": "true"
}
```

---

## SQLAR Files

Serve files from SQLite Archive (for thumbnails, screenshots, etc.).

### Get SQLAR File

```http
GET /sqlar/*path
```

**Example:** `GET /sqlar/screenshots/abc123.png`

**Response:** Decompressed file contents with appropriate `Content-Type` header.

**Note:** SQLAR files are zlib-compressed in the database and decompressed on-the-fly.

---

## Notifications (SSE)

Real-time notifications via Server-Sent Events.

### Subscribe to Notifications

```http
GET /api/notifications/stream
```

**Headers:**
```
Accept: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

**Event Format:**
```
data: {"type":"inbox-changed","timestamp":"2024-01-15T10:30:00Z"}

data: {"type":"library-changed","path":"notes/file.md","action":"create","timestamp":"2024-01-15T10:31:00Z"}

data: {"type":"pin-changed","path":"inbox/important.md","timestamp":"2024-01-15T10:32:00Z"}

: heartbeat
```

**Event Types:**
| Type | Description | Additional Fields |
|------|-------------|-------------------|
| `connected` | Initial connection established | - |
| `inbox-changed` | Inbox content changed | - |
| `library-changed` | Library content changed | `path`, `action` |
| `pin-changed` | Pin state changed | `path` |
| `digest-update` | Digest processing update | `path`, `digester`, `status` |

**Heartbeat:** Sent every 30 seconds as `: heartbeat\n\n`

---

## Vendors

### List OpenAI Models

```http
GET /api/vendors/openai/models
```

**Response (200 OK):**
```json
{
  "models": [
    {"id": "gpt-4o", "name": "GPT-4o"},
    {"id": "gpt-4o-mini", "name": "GPT-4o Mini"}
  ]
}
```

**Response (503 Service Unavailable):**
```json
{
  "error": "OpenAI is not configured"
}
```

---

## Directories

### List Top-Level Directories

```http
GET /api/directories
```

**Response (200 OK):**
```json
["inbox", "notes", "journal", "photos"]
```

**Note:** Excludes hidden directories (starting with `.`) and the `app` directory.

---

## Claude Code Integration

Claude Code is an AI-powered coding assistant that runs as a session-based agent. The mobile app can create sessions, send messages, and receive real-time responses via WebSocket.

### Overview

- **Sessions**: Persistent conversations with Claude AI
- **Modes**: `ui` (structured JSON messaging) or `cli` (terminal I/O)
- **Permission Modes**: `default`, `acceptEdits`, `plan`, `bypassPermissions`
- **Real-time**: WebSocket for bidirectional communication

### List Active Sessions

Returns sessions currently managed by the server (active/running).

```http
GET /api/claude/sessions
```

**Response (200 OK):**
```json
{
  "sessions": [
    {
      "id": "04361723-fde4-4be9-8e44-e2b0f9b524c4",
      "title": "Refactoring auth system",
      "workingDir": "/path/to/project",
      "createdAt": "2024-01-15T10:30:00Z",
      "lastActivity": "2024-01-15T11:45:00Z",
      "mode": "ui",
      "status": "active",
      "processId": 12345,
      "clients": 2,
      "git": {
        "isRepo": true,
        "branch": "main"
      }
    }
  ]
}
```

### List All Sessions (with Pagination)

Returns both active and historical sessions from the session index.

```http
GET /api/claude/sessions/all
```

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | integer | 20 | Number of sessions (max 100) |
| `cursor` | string | - | Pagination cursor from previous response |
| `status` | string | "all" | Filter: `"all"`, `"active"`, `"archived"` |

**Response (200 OK):**
```json
{
  "sessions": [
    {
      "id": "04361723-fde4-4be9-8e44-e2b0f9b524c4",
      "title": "Refactoring auth system",
      "workingDir": "/path/to/project",
      "createdAt": "2024-01-15T10:30:00Z",
      "lastActivity": "2024-01-15T11:45:00Z",
      "messageCount": 42,
      "isSidechain": false,
      "isActive": true,
      "status": "active",
      "git": {
        "isRepo": true,
        "branch": "main"
      }
    }
  ],
  "pagination": {
    "hasMore": true,
    "nextCursor": "2024-01-14T08:00:00Z",
    "totalCount": 156
  }
}
```

### Create Session

Creates a new Claude Code session or resumes an existing one.

```http
POST /api/claude/sessions
```

**Request Body:**
```json
{
  "workingDir": "/path/to/project",
  "title": "Feature implementation",
  "resumeSessionId": "existing-session-uuid",
  "mode": "ui",
  "permissionMode": "default"
}
```

**Fields:**
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `workingDir` | string | User data dir | Working directory for the session |
| `title` | string | - | Optional session title |
| `resumeSessionId` | string | - | Resume from existing session ID |
| `mode` | string | `"ui"` | `"ui"` (structured JSON) or `"cli"` (terminal) |
| `permissionMode` | string | `"default"` | Permission mode (see below) |

**Permission Modes:**
| Mode | Description |
|------|-------------|
| `default` | Ask user for permissions |
| `acceptEdits` | Auto-approve file edits |
| `plan` | Read-only mode (research/planning) |
| `bypassPermissions` | Skip all permission checks |

**Response (200 OK):**
```json
{
  "id": "04361723-fde4-4be9-8e44-e2b0f9b524c4",
  "title": "Feature implementation",
  "workingDir": "/path/to/project",
  "createdAt": "2024-01-15T10:30:00Z",
  "mode": "ui",
  "status": "active"
}
```

### Get Session

```http
GET /api/claude/sessions/:id
```

**Response (200 OK):**
```json
{
  "id": "04361723-fde4-4be9-8e44-e2b0f9b524c4",
  "title": "Refactoring auth system",
  "workingDir": "/path/to/project",
  "createdAt": "2024-01-15T10:30:00Z",
  "lastActivity": "2024-01-15T11:45:00Z",
  "mode": "ui",
  "status": "active",
  "messageCount": 42
}
```

### Get Session Messages

Returns all cached messages for a session.

```http
GET /api/claude/sessions/:id/messages
```

**Response (200 OK):**
```json
{
  "sessionId": "04361723-fde4-4be9-8e44-e2b0f9b524c4",
  "mode": "ui",
  "count": 42,
  "messages": [
    {
      "type": "user",
      "uuid": "c0a21d6f-3652-4f86-a36b-b98d75a15298",
      "timestamp": "2024-01-15T10:30:00Z",
      "message": {
        "role": "user",
        "content": [{"type": "text", "text": "Help me refactor the auth system"}]
      }
    },
    {
      "type": "assistant",
      "uuid": "a953b709-f2f8-46e3-8c99-4f9b01f8e6d5",
      "parentUuid": "c0a21d6f-3652-4f86-a36b-b98d75a15298",
      "timestamp": "2024-01-15T10:30:05Z",
      "message": {
        "role": "assistant",
        "model": "claude-sonnet-4-5-20250929",
        "content": [{"type": "text", "text": "I'll help you refactor..."}],
        "usage": {"input_tokens": 245, "output_tokens": 150}
      }
    }
  ]
}
```

### Send Message (HTTP)

Send a message to a session via HTTP (alternative to WebSocket).

```http
POST /api/claude/sessions/:id/messages
```

**Request Body:**
```json
{
  "content": "What files are in this directory?"
}
```

**Response (200 OK):**
```json
{
  "sessionId": "04361723-fde4-4be9-8e44-e2b0f9b524c4",
  "status": "sent"
}
```

**Note:** This only sends the message. Use WebSocket to receive the response.

### Update Session

Update session metadata (title).

```http
PATCH /api/claude/sessions/:id
```

**Request Body:**
```json
{
  "title": "New session title"
}
```

**Response (200 OK):**
```json
{
  "success": true
}
```

### Deactivate Session

Archives a session without deleting history. The session can be resumed later.

```http
POST /api/claude/sessions/:id/deactivate
```

**Response (200 OK):**
```json
{
  "success": true
}
```

### Delete Session

Permanently deletes a session and its history.

```http
DELETE /api/claude/sessions/:id
```

**Response (200 OK):**
```json
{
  "success": true
}
```

---

### WebSocket Protocol

For real-time bidirectional communication, use the WebSocket endpoints.

#### Subscribe WebSocket (Recommended)

Real-time structured message streaming. Preferred for mobile apps.

```
ws://{host}:{port}/api/claude/sessions/:id/subscribe
```

**Connection Flow:**
1. Connect to WebSocket endpoint
2. Server sends all cached messages (history)
3. Send user messages via WebSocket
4. Receive Claude responses in real-time
5. Server sends heartbeat pings every 30 seconds

#### Terminal WebSocket

Raw terminal I/O for CLI mode sessions.

```
ws://{host}:{port}/api/claude/sessions/:id/ws
```

---

### WebSocket Message Types

#### Client → Server

**User Message:**
```json
{
  "type": "user_message",
  "content": "What files are in this directory?"
}
```

**Control Request (Interrupt):**
```json
{
  "type": "control_request",
  "request_id": "req_123",
  "request": {
    "subtype": "interrupt"
  }
}
```

**Control Request (Set Permission Mode):**
```json
{
  "type": "control_request",
  "request_id": "req_124",
  "request": {
    "subtype": "set_permission_mode",
    "mode": "acceptEdits"
  }
}
```

**Control Response (Permission Decision):**
```json
{
  "type": "control_response",
  "request_id": "req_125",
  "response": {
    "subtype": "can_use_tool",
    "response": {
      "behavior": "allow",
      "message": ""
    }
  },
  "always_allow": false,
  "tool_name": "Bash"
}
```

**Behavior Values:**
- `"allow"` - Permit the tool to execute
- `"deny"` - Block the tool (requires `message` with reason)

#### Server → Client

**User Message (from history or synthetic):**
```json
{
  "type": "user",
  "uuid": "c0a21d6f-3652-4f86-a36b-b98d75a15298",
  "parentUuid": null,
  "timestamp": "2024-01-15T10:30:00Z",
  "sessionId": "04361723-fde4-4be9-8e44-e2b0f9b524c4",
  "message": {
    "role": "user",
    "content": [{"type": "text", "text": "What files are here?"}]
  }
}
```

**Assistant Text Response:**
```json
{
  "type": "assistant",
  "uuid": "a953b709-f2f8-46e3-8c99-4f9b01f8e6d5",
  "parentUuid": "c0a21d6f-3652-4f86-a36b-b98d75a15298",
  "timestamp": "2024-01-15T10:30:05Z",
  "message": {
    "role": "assistant",
    "model": "claude-sonnet-4-5-20250929",
    "content": [{"type": "text", "text": "I'll check the directory..."}],
    "usage": {
      "input_tokens": 245,
      "output_tokens": 12
    }
  }
}
```

**Assistant Tool Call:**
```json
{
  "type": "assistant",
  "uuid": "75819da3-58d5-4d30-a167-a1449fd87738",
  "parentUuid": "a953b709-f2f8-46e3-8c99-4f9b01f8e6d5",
  "timestamp": "2024-01-15T10:30:06Z",
  "message": {
    "role": "assistant",
    "content": [
      {
        "type": "tool_use",
        "id": "toolu_014EkHUXLk8xUUUqjocQNd8g",
        "name": "Bash",
        "input": {"command": "ls -la"}
      }
    ]
  }
}
```

**Tool Result:**
```json
{
  "type": "user",
  "uuid": "8f3c5d2a-1234-5678-9abc-def012345678",
  "parentUuid": "75819da3-58d5-4d30-a167-a1449fd87738",
  "timestamp": "2024-01-15T10:30:07Z",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_014EkHUXLk8xUUUqjocQNd8g",
        "content": "total 48\ndrwxr-xr-x  12 user  staff  384 Jan 15 10:30 ."
      }
    ]
  },
  "toolUseResult": {
    "toolUseId": "toolu_014EkHUXLk8xUUUqjocQNd8g",
    "isError": false
  }
}
```

**Permission Request (from Claude):**
```json
{
  "type": "control_request",
  "request_id": "req_125",
  "request": {
    "subtype": "can_use_tool",
    "tool_name": "Bash",
    "input": {"command": "rm -rf node_modules"}
  }
}
```

**Progress Message:**
```json
{
  "type": "progress",
  "uuid": "26978643-ffbd-4e71-8fe2-16f258a3ce06",
  "timestamp": "2024-01-15T10:30:08Z",
  "data": {
    "type": "hook_progress",
    "hookEvent": "PreToolUse",
    "hookName": "PreToolUse:Read"
  },
  "toolUseID": "toolu_01X5nzhSfiEL5MQ8DUeeFZhY"
}
```

**Thinking Block (Extended Thinking):**
```json
{
  "type": "assistant",
  "uuid": "b812dc15-5444-460a-bae4-2111a7f2c2f8",
  "timestamp": "2024-01-15T10:30:10Z",
  "message": {
    "role": "assistant",
    "model": "claude-opus-4-5-20251101",
    "content": [
      {
        "type": "thinking",
        "thinking": "Let me analyze the directory structure...",
        "signature": "EsQCCkYICxgCKkAw8Q1KeDQe..."
      }
    ]
  }
}
```

**Todo Update:**
```json
{
  "type": "todo_update",
  "data": {
    "todos": [
      {"content": "Create file", "activeForm": "Creating file", "status": "completed"},
      {"content": "Update imports", "activeForm": "Updating imports", "status": "in_progress"},
      {"content": "Run tests", "activeForm": "Running tests", "status": "pending"}
    ]
  }
}
```

**Queue Operation (Session State):**
```json
{
  "type": "queue-operation",
  "operation": "dequeue",
  "timestamp": "2024-01-15T10:31:00Z",
  "sessionId": "04361723-fde4-4be9-8e44-e2b0f9b524c4"
}
```

**Error:**
```json
{
  "type": "error",
  "error": "Failed to send message to session"
}
```

---

### Content Block Types

Messages can contain different content blocks in `message.content`:

**Text Block:**
```typescript
{
  type: "text",
  text: string
}
```

**Thinking Block (Claude Opus extended reasoning):**
```typescript
{
  type: "thinking",
  thinking: string,
  signature?: string
}
```

**Tool Use Block:**
```typescript
{
  type: "tool_use",
  id: string,          // e.g., "toolu_014EkHUXLk8xUUUqjocQNd8g"
  name: string,        // e.g., "Read", "Bash", "Edit", "Write"
  input: object        // Tool-specific parameters
}
```

**Tool Result Block:**
```typescript
{
  type: "tool_result",
  tool_use_id: string,
  content: string | ContentBlock[],
  is_error?: boolean
}
```

---

### Available Tools

Claude Code can use these tools during sessions:

| Tool | Description | Requires Permission |
|------|-------------|-------------------|
| `Read` | Read file contents | No (can be restricted) |
| `Write` | Create/overwrite files | Yes |
| `Edit` | Make targeted edits | Yes |
| `Bash` | Execute shell commands | Yes (most restricted) |
| `Glob` | Find files by pattern | No |
| `Grep` | Search file contents | No |
| `WebFetch` | Fetch from URLs | Yes |
| `WebSearch` | Search the web | Yes |
| `Task` | Spawn subagents | No |
| `TodoWrite` | Create task lists | No |
| `AskUserQuestion` | Gather requirements | No |
| `NotebookEdit` | Edit Jupyter notebooks | Yes |

---

### Detecting Working State

To show a "working" indicator in the UI, track these signals:

**Claude is working when:**
- Last message is `type: "user"` (sent, waiting for response)
- `type: "progress"` messages are being received
- Last assistant message has `tool_use` content blocks

**Claude is idle when:**
- `type: "queue-operation"` with `operation: "dequeue"` received
- Last assistant message has `stop_reason: "end_turn"`
- Last message timestamp is stale (> 60 seconds old)

---

### Message Threading

Messages form a tree structure using `uuid` and `parentUuid`:

```
User Message (uuid: A, parentUuid: null)
  └─ Assistant Response (uuid: B, parentUuid: A)
      └─ Tool Call (uuid: C, parentUuid: B)
          └─ Tool Result (uuid: D, parentUuid: C)
              └─ Final Response (uuid: E, parentUuid: D)
```

---

### Mobile Implementation Notes for Claude Code

1. **WebSocket Connection**:
   - Connect to `/api/claude/sessions/:id/subscribe`
   - Handle reconnection with exponential backoff
   - Messages are deduplicated by `uuid`

2. **Permission Handling**:
   - Listen for `control_request` messages with `subtype: "can_use_tool"`
   - Show permission dialog to user
   - Respond with `control_response` message

3. **Session Resume**:
   - Use `resumeSessionId` when creating session to continue previous conversation
   - All history is sent on WebSocket connect

4. **Offline Handling**:
   - Sessions persist on server
   - Reconnect and receive missed messages via initial history load

5. **Tool Results Display**:
   - Match `tool_result.tool_use_id` with `tool_use.id`
   - Render tool outputs appropriately (code, file contents, errors)

---

## Data Models

### FileRecord

```typescript
interface FileRecord {
  path: string;           // Relative path from data root
  name: string;           // Filename
  isFolder: boolean;
  size?: number;          // Bytes (null for folders)
  mimeType?: string;      // MIME type
  hash?: string;          // SHA-256 hash
  modifiedAt: string;     // ISO 8601 timestamp
  createdAt: string;      // ISO 8601 timestamp
  textPreview?: string;   // First ~500 chars of text content
  screenshotSqlar?: string; // Path to screenshot in SQLAR
}
```

### Digest

```typescript
interface Digest {
  id: string;             // UUID
  filePath: string;       // Path to source file
  digester: string;       // Digester name (e.g., "tags")
  status: "todo" | "running" | "done" | "failed" | "skipped";
  content?: string;       // JSON string with digest results
  sqlarName?: string;     // Path to artifact in SQLAR
  error?: string;         // Error message if failed
  attempts: number;       // Number of processing attempts
  createdAt: string;      // ISO 8601 timestamp
  updatedAt: string;      // ISO 8601 timestamp
}
```

### Person

```typescript
interface Person {
  id: string;             // UUID
  displayName: string;
  createdAt: string;      // ISO 8601 timestamp
  updatedAt: string;      // ISO 8601 timestamp
  clusters?: PersonCluster[];
}

interface PersonCluster {
  id: string;             // UUID
  peopleId?: string;      // Associated person (null if unassigned)
  clusterType: "face" | "voice";
  sampleCount: number;    // Number of samples in cluster
  createdAt: string;
  updatedAt: string;
}
```

### UserSettings

```typescript
interface UserSettings {
  preferences: {
    theme: "auto" | "light" | "dark";
    defaultView: string;
    weeklyDigest: boolean;
    digestDay: number;    // 0-6 (Sunday-Saturday)
    logLevel?: string;
    userEmail?: string;
    languages?: string[]; // ISO language codes
  };
  vendors?: {
    openai?: {
      baseUrl?: string;
      apiKey?: string;    // Masked in responses
      model?: string;
    };
    homelabAi?: {
      baseUrl?: string;
      chromeCdpUrl?: string;
    };
    aliyun?: {
      apiKey?: string;    // Masked in responses
      region?: string;
      asrProvider?: string;
      ossAccessKeyId?: string;
      ossAccessKeySecret?: string;
      ossRegion?: string;
      ossBucket?: string;
    };
    meilisearch?: {
      host?: string;
    };
    qdrant?: {
      host?: string;
    };
  };
  digesters?: Record<string, boolean>;
  extraction: {
    autoEnrich: boolean;
    includeEntities: boolean;
    includeSentiment: boolean;
    includeActionItems: boolean;
    includeRelatedEntries: boolean;
    minConfidence: number;
  };
  storage: {
    dataPath: string;
    backupPath?: string;
    autoBackup: boolean;
    maxFileSize: number;  // Bytes
  };
}
```

---

## Error Responses

All endpoints return errors in a consistent format:

```json
{
  "error": "Human-readable error message",
  "code": "ERROR_CODE"
}
```

### Common HTTP Status Codes

| Status | Description |
|--------|-------------|
| 200 | Success |
| 201 | Created |
| 400 | Bad Request - Invalid parameters |
| 401 | Unauthorized - Authentication required |
| 404 | Not Found - Resource doesn't exist |
| 409 | Conflict - Resource already exists |
| 500 | Internal Server Error |
| 503 | Service Unavailable - External service not configured |

---

## Rate Limiting

Currently, there is no rate limiting implemented. Mobile clients should implement their own throttling for network efficiency.

---

## Versioning

The API does not currently use versioning. Breaking changes will be documented in release notes.

---

## Mobile Implementation Notes

### Authentication
1. Check `GET /api/oauth/token` on app launch to verify session
2. Implement OAuth flow using system browser or in-app WebView
3. Store tokens securely in Keychain (iOS) / EncryptedSharedPreferences (Android)
4. Implement automatic token refresh before expiry

### File Uploads
1. Use TUS protocol for large files (resumable uploads)
2. For small files, use `POST /api/inbox` with multipart/form-data
3. Always finalize TUS uploads with `POST /api/upload/finalize`

### Real-time Updates
1. Connect to SSE endpoint `/api/notifications/stream`
2. Handle reconnection with exponential backoff
3. Use heartbeats to detect connection health

### Offline Support
1. Cache file metadata locally
2. Queue uploads for when connectivity returns
3. Sync changes on reconnection

### Image Handling
1. Use `/raw/*path` for full-resolution images
2. Check `screenshotSqlar` for thumbnails
3. Consider lazy loading for large galleries
