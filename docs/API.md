# MyLifeDB API Documentation

This document describes the REST API endpoints for the MyLifeDB backend. Mobile app developers should use this as a reference for implementing iOS and Android clients.

**Base URL**: `http://{host}:{port}` (default: `http://localhost:12345`)

---

## API Design Principles

### 1. HTTP Semantics First

We use proper HTTP status codes and methods. The HTTP layer carries meaningful information:

| Method | Purpose | Idempotent |
|--------|---------|------------|
| `GET` | Retrieve resources | Yes |
| `POST` | Create resources / trigger actions | No |
| `PUT` | Full update (replace) | Yes |
| `PATCH` | Partial update | Yes |
| `DELETE` | Remove resources | Yes |

| Status | Meaning | When to Use |
|--------|---------|-------------|
| `200` | OK | Successful GET, PUT, PATCH |
| `201` | Created | Successful POST that creates a resource |
| `204` | No Content | Successful DELETE |
| `400` | Bad Request | Validation errors, malformed request |
| `401` | Unauthorized | Authentication required |
| `403` | Forbidden | Permission denied |
| `404` | Not Found | Resource doesn't exist |
| `409` | Conflict | Resource already exists |
| `500` | Internal Error | Server-side failure |
| `503` | Service Unavailable | External dependency down |

### 2. Unified Response Structure

**All responses follow a consistent structure:**

```json
// Success: Single resource
{
  "data": { "id": "...", "name": "..." }
}

// Success: Collection
{
  "data": [{ "id": "..." }, { "id": "..." }],
  "pagination": { "hasMore": true, "nextCursor": "..." }
}

// Success: No content
HTTP 204 (empty body)

// Error: All errors
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Display name is required",
    "details": [{ "field": "displayName", "message": "required" }]
  }
}
```

### 3. No API Versioning

We do NOT use URL versioning (`/api/v1/`). Instead:

- **Additive changes only**: Add new fields and endpoints without removing existing ones
- **Deprecation period**: Mark fields as deprecated before removal
- **Frontend-first migration**: Update frontend to handle both old/new formats before backend changes

This keeps URLs simple and avoids maintenance burden of multiple versions.

### 4. Naming Conventions

| Context | Convention | Example |
|---------|------------|---------|
| URL paths | kebab-case, plural nouns | `/api/inbox-items`, `/api/people` |
| JSON fields | camelCase | `displayName`, `createdAt`, `hasMore` |
| Query params | camelCase | `?folderOnly=true`, `?pageSize=20` |
| Error codes | SCREAMING_SNAKE_CASE | `VALIDATION_ERROR`, `NOT_FOUND` |

**Exceptions:**
- OAuth responses use snake_case per OAuth 2.0 spec (`access_token`, `refresh_token`)
- Claude Code preserves Claude's original format
- External vendor responses use their native formats

### 5. Resource-Oriented Design

URLs represent resources (nouns), not actions (verbs):

```
# Good: Resources
GET    /api/people          # List people
POST   /api/people          # Create person
GET    /api/people/:id      # Get person
PUT    /api/people/:id      # Update person
DELETE /api/people/:id      # Delete person

# Avoid: Actions in URLs (but acceptable for non-CRUD operations)
POST   /api/people/:id/merge   # OK - complex action
POST   /api/inbox/:id/reenrich # OK - trigger processing
```

### 6. Consistent Pagination

**Cursor-based pagination** (preferred for real-time data):
```json
{
  "data": [...],
  "pagination": {
    "hasMore": true,
    "nextCursor": "eyJpZCI6MTIzfQ==",
    "prevCursor": "eyJpZCI6MTAwfQ=="
  }
}
```

**Offset-based pagination** (for search results):
```json
{
  "data": [...],
  "pagination": {
    "total": 156,
    "limit": 20,
    "offset": 40,
    "hasMore": true
  }
}
```

### 7. Error Codes

All errors include a machine-readable code for programmatic handling:

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `BAD_REQUEST` | 400 | Malformed request syntax |
| `VALIDATION_ERROR` | 400 | Field validation failed |
| `UNAUTHORIZED` | 401 | Authentication required |
| `FORBIDDEN` | 403 | Permission denied |
| `NOT_FOUND` | 404 | Resource not found |
| `CONFLICT` | 409 | Resource conflict |
| `INTERNAL_ERROR` | 500 | Unexpected server error |
| `SERVICE_UNAVAILABLE` | 503 | Dependency unavailable |

### 8. Idempotency

- `PUT` and `DELETE` operations are idempotent (same result if called multiple times)
- `DELETE` on non-existent resource returns `404`, not error
- Toggle operations use explicit state: `PUT /pin` to pin, `DELETE /pin` to unpin

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
16. [Speech Recognition (ASR)](#speech-recognition-asr)
17. [Claude Code Integration](#claude-code-integration)
18. [Data Models](#data-models)

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
  "data": {
    "sessionId": "string"
  }
}
```

**Response (401 Unauthorized):**
```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Invalid password"
  }
}
```

**Notes:**
- Sets an HTTP-only `session` cookie valid for 30 days
- First login with no password set will create the password

#### Logout

```http
POST /api/auth/logout
```

**Response:** `204 No Content`

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
  "data": {
    "authenticated": true,
    "username": "string",
    "sub": "string",
    "email": "string"
  }
}
```

**Response (200 OK - Not Authenticated):**
```json
{
  "data": {
    "authenticated": false
  }
}
```

#### Refresh Token

```http
POST /api/oauth/refresh
```

**Response (200 OK):**
```json
{
  "data": {
    "expiresIn": 3600
  }
}
```

**Response (401 Unauthorized):**
```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "No refresh token provided"
  }
}
```

#### OAuth Logout

```http
POST /api/oauth/logout
```

**Response:** `204 No Content`

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
  "data": [
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
  "pagination": {
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
  "data": {
    "path": "inbox/uuid.md",
    "paths": ["inbox/uuid.md", "inbox/photo.jpg"]
  }
}
```

**Headers:** `Location: /api/inbox/uuid.md`

### Get Inbox Item

```http
GET /api/inbox/:filename
```

**Path Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `filename` | string | Filename in inbox (e.g., "file.md") |

**Response (200 OK):**
```json
{
  "data": {
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
        "status": "done",
        "content": "{\"tags\": [\"work\", \"notes\"]}",
        "createdAt": "2024-01-15T10:30:00Z",
        "updatedAt": "2024-01-15T10:35:00Z"
      }
    ]
  }
}
```

### Update Inbox Item

```http
PUT /api/inbox/:filename
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
  "data": {
    "path": "inbox/file.md",
    "modifiedAt": "2024-01-15T12:00:00Z"
  }
}
```

### Delete Inbox Item

```http
DELETE /api/inbox/:filename
```

**Response:** `204 No Content`

### Get Pinned Inbox Items

```http
GET /api/inbox/pinned
```

**Response (200 OK):**
```json
{
  "data": [
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
POST /api/inbox/:filename/reenrich
```

**Response (202 Accepted):**
```json
{
  "data": {
    "message": "Re-enrichment triggered",
    "path": "inbox/file.md"
  }
}
```

### Get Inbox Item Status

```http
GET /api/inbox/:filename/status
```

**Response (200 OK):**
```json
{
  "data": {
    "status": "processing",
    "digests": [
      {
        "id": "uuid",
        "digester": "tags",
        "status": "done"
      },
      {
        "id": "uuid2",
        "digester": "image-captioning",
        "status": "running"
      }
    ]
  }
}
```

**Overall Status Values:**
- `done` - All digests completed successfully
- `processing` - At least one digest is currently running
- `pending` - Digests are queued (`todo`) or have failed

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
  "data": {
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
      }
    ]
  }
}
```

### Get File Info

```http
GET /api/library/files
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | **Required.** Relative path to file |

**Response (200 OK):**
```json
{
  "data": {
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
}
```

### Delete File

```http
DELETE /api/library/files
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | **Required.** Relative path to file or folder |

**Response:** `204 No Content`

### Rename File

```http
PATCH /api/library/files
```

**Request Body:**
```json
{
  "path": "notes/old-name.md",
  "name": "new-name.md"
}
```

**Response (200 OK):**
```json
{
  "data": {
    "path": "notes/new-name.md"
  }
}
```

**Response (409 Conflict):**
```json
{
  "error": {
    "code": "CONFLICT",
    "message": "A file with this name already exists"
  }
}
```

### Move File

```http
PATCH /api/library/files
```

**Request Body:**
```json
{
  "path": "inbox/file.md",
  "parent": "notes/work"
}
```

**Note:** Empty `parent` moves to data root.

**Response (200 OK):**
```json
{
  "data": {
    "path": "notes/work/file.md"
  }
}
```

### Create Folder

```http
POST /api/library/folders
```

**Request Body:**
```json
{
  "path": "notes",
  "name": "new-folder"
}
```

**Response (201 Created):**
```json
{
  "data": {
    "path": "notes/new-folder"
  }
}
```

**Headers:** `Location: /api/library/folders?path=notes/new-folder`

### Pin File

```http
PUT /api/library/pins
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
  "data": {
    "path": "inbox/important.md",
    "isPinned": true,
    "pinnedAt": "2024-01-15T10:30:00Z"
  }
}
```

### Unpin File

```http
DELETE /api/library/pins
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | **Required.** Path to file |

**Response:** `204 No Content`

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
  "data": [
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
      }
    }
  ],
  "pagination": {
    "total": 42,
    "limit": 20,
    "offset": 0,
    "hasMore": true
  },
  "meta": {
    "query": "meeting notes",
    "timing": {
      "totalMs": 45,
      "searchMs": 30,
      "enrichMs": 15
    },
    "sources": ["keyword", "semantic"]
  }
}
```

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
  "data": [
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
    }
  ]
}
```

### Get Digest Stats

```http
GET /api/digest/stats
```

**Response (200 OK):**
```json
{
  "data": {
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
}
```

### Get File Digests

```http
GET /api/digest/files/*path
```

**Example:** `GET /api/digest/files/inbox/photo.jpg`

**Response (200 OK):**
```json
{
  "data": {
    "path": "inbox/photo.jpg",
    "status": "processing",
    "digests": [
      {
        "id": "uuid",
        "filePath": "inbox/photo.jpg",
        "digester": "image-captioning",
        "status": "done",
        "content": "{\"caption\": \"A sunset over the ocean\"}",
        "createdAt": "2024-01-15T10:30:00Z",
        "updatedAt": "2024-01-15T10:35:00Z"
      }
    ]
  }
}
```

### Trigger Digest Processing

```http
POST /api/digest/files/*path
```

**Request Body (optional):**
```json
{
  "digester": "image-captioning",
  "force": true
}
```

**Response (202 Accepted):**
```json
{
  "data": {
    "message": "Digest processing triggered",
    "path": "inbox/photo.jpg"
  }
}
```

### Reset Digester

Resets all digests of a specific type to "todo" status.

```http
POST /api/digest/digesters/:name/reset
```

**Response (200 OK):**
```json
{
  "data": {
    "affected": 42
  }
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
{
  "data": [
    {
      "id": "uuid",
      "displayName": "John Doe",
      "createdAt": "2024-01-15T10:30:00Z",
      "updatedAt": "2024-01-15T10:30:00Z"
    }
  ]
}
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
  "data": {
    "id": "uuid",
    "displayName": "John Doe",
    "createdAt": "2024-01-15T10:30:00Z",
    "updatedAt": "2024-01-15T10:30:00Z"
  }
}
```

**Headers:** `Location: /api/people/uuid`

### Get Person

```http
GET /api/people/:id
```

**Response (200 OK):**
```json
{
  "data": {
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
  "data": {
    "id": "uuid",
    "displayName": "John Smith",
    "updatedAt": "2024-01-15T12:00:00Z"
  }
}
```

### Delete Person

```http
DELETE /api/people/:id
```

**Response:** `204 No Content`

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
  "data": {
    "mergedCount": 3,
    "targetId": "uuid"
  }
}
```

### Assign Embedding to Person

```http
PUT /api/people/embeddings/:embeddingId
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
  "data": {
    "embeddingId": "embedding-uuid",
    "personId": "person-uuid"
  }
}
```

### Unassign Embedding

```http
DELETE /api/people/embeddings/:embeddingId
```

**Response:** `204 No Content`

---

## Settings

### Get Settings

```http
GET /api/settings
```

**Response (200 OK):**
```json
{
  "data": {
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
      }
    },
    "digesters": {
      "tags": true,
      "image-captioning": true
    },
    "extraction": {
      "autoEnrich": true,
      "minConfidence": 0.7
    },
    "storage": {
      "dataPath": "/data",
      "autoBackup": true,
      "maxFileSize": 104857600
    }
  }
}
```

**Note:** API keys are masked with asterisks in responses.

### Update Settings

```http
PATCH /api/settings
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

**Response (200 OK):** Returns the complete updated settings object in `data` field.

**Note:** Masked API keys (`********`) are ignored and won't update the stored value.

### Reset Settings

```http
DELETE /api/settings
```

**Response (200 OK):** Returns the default settings object in `data` field.

---

## Statistics

### Get Application Stats

```http
GET /api/stats
```

**Response (200 OK):**
```json
{
  "data": {
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
  "maxTokens": 300
}
```

**Response (200 OK):**
```json
{
  "data": {
    "summary": "• Key point 1\n• Key point 2\n• Action items..."
  }
}
```

**Response (503 Service Unavailable):**
```json
{
  "error": {
    "code": "SERVICE_UNAVAILABLE",
    "message": "OpenAI API key not configured"
  }
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

**Response (200 OK):**
```json
{
  "data": {
    "path": "inbox/document.pdf",
    "paths": ["inbox/document.pdf"]
  }
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

**Response:** `204 No Content`

---

## SQLAR Files

Serve files from SQLite Archive (for thumbnails, screenshots, etc.).

### Get SQLAR File

```http
GET /sqlar/*path
```

**Example:** `GET /sqlar/screenshots/abc123.png`

**Response:** Decompressed file contents with appropriate `Content-Type` header.

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

---

## Vendors

### List OpenAI Models

```http
GET /api/vendors/openai/models
```

**Response (200 OK):**
```json
{
  "data": [
    {"id": "gpt-4o", "name": "GPT-4o"},
    {"id": "gpt-4o-mini", "name": "GPT-4o Mini"}
  ]
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
{
  "data": ["inbox", "notes", "journal", "photos"]
}
```

---

## Speech Recognition (ASR)

### Non-Realtime ASR

```http
POST /api/asr
```

**Option 1: Multipart File Upload**
```http
Content-Type: multipart/form-data
```

| Field | Type | Description |
|-------|------|-------------|
| `audio` | file | **Required.** Audio file to transcribe |
| `diarization` | string | `"true"` to enable speaker diarization |

**Option 2: JSON Request**
```json
{
  "filePath": "/path/to/audio.wav",
  "diarization": true
}
```

**Response (200 OK):**
```json
{
  "data": {
    "text": "Full transcription text...",
    "segments": [
      {
        "text": "Hello, how are you?",
        "beginTime": 0,
        "endTime": 2500,
        "speakerId": "speaker_1"
      }
    ]
  }
}
```

### Real-time ASR (WebSocket)

```
ws://{host}:{port}/api/asr/realtime
```

See detailed WebSocket protocol documentation in the original section.

---

## Claude Code Integration

Claude Code is an AI-powered coding assistant that runs as a session-based agent.

### List Active Sessions

```http
GET /api/claude/sessions
```

**Response (200 OK):**
```json
{
  "data": [
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

```http
GET /api/claude/sessions/all
```

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | integer | 20 | Number of sessions (max 100) |
| `cursor` | string | - | Pagination cursor |
| `status` | string | "all" | Filter: `"all"`, `"active"`, `"archived"` |

**Response (200 OK):**
```json
{
  "data": [...sessions...],
  "pagination": {
    "hasMore": true,
    "nextCursor": "2024-01-14T08:00:00Z",
    "totalCount": 156
  }
}
```

### Create Session

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

**Response (201 Created):**
```json
{
  "data": {
    "id": "04361723-fde4-4be9-8e44-e2b0f9b524c4",
    "title": "Feature implementation",
    "workingDir": "/path/to/project",
    "createdAt": "2024-01-15T10:30:00Z",
    "mode": "ui",
    "status": "active"
  }
}
```

### Get Session

```http
GET /api/claude/sessions/:id
```

**Response (200 OK):**
```json
{
  "data": {
    "id": "...",
    "title": "...",
    ...
  }
}
```

### Get Session Messages

```http
GET /api/claude/sessions/:id/messages
```

**Response (200 OK):**
```json
{
  "data": {
    "sessionId": "04361723-fde4-4be9-8e44-e2b0f9b524c4",
    "mode": "ui",
    "count": 42,
    "messages": [...]
  }
}
```

### Send Message

```http
POST /api/claude/sessions/:id/messages
```

**Request Body:**
```json
{
  "content": "What files are in this directory?"
}
```

**Response (202 Accepted):**
```json
{
  "data": {
    "sessionId": "04361723-fde4-4be9-8e44-e2b0f9b524c4",
    "status": "sent"
  }
}
```

### Update Session

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
  "data": {
    "id": "...",
    "title": "New session title"
  }
}
```

### Deactivate Session

```http
POST /api/claude/sessions/:id/deactivate
```

**Response:** `204 No Content`

### Delete Session

```http
DELETE /api/claude/sessions/:id
```

**Response:** `204 No Content`

### WebSocket Protocol

See the original WebSocket documentation section for detailed message types and protocol.

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
  digester: string;       // Digester name
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
```

### UserSettings

```typescript
interface UserSettings {
  preferences: {
    theme: "auto" | "light" | "dark";
    defaultView: string;
    weeklyDigest: boolean;
    digestDay: number;
    logLevel?: string;
    userEmail?: string;
    languages?: string[];
  };
  vendors?: { ... };
  digesters?: Record<string, boolean>;
  extraction: { ... };
  storage: { ... };
}
```

---

## Mobile Implementation Notes

### Authentication
1. Check `GET /api/oauth/token` on app launch
2. Implement OAuth flow using system browser
3. Store tokens securely in Keychain/EncryptedSharedPreferences
4. Implement automatic token refresh

### File Uploads
1. Use TUS protocol for large files (resumable)
2. For small files, use `POST /api/inbox` with multipart
3. Always finalize TUS uploads

### Real-time Updates
1. Connect to SSE `/api/notifications/stream`
2. Handle reconnection with exponential backoff
3. Use heartbeats to detect connection health

### Offline Support
1. Cache file metadata locally
2. Queue uploads for when connectivity returns
3. Sync changes on reconnection
