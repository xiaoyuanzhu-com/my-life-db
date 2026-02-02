# API Response Standards

This document defines the unified response structure for all MyLifeDB API endpoints.

## Design Principles

1. **Use proper HTTP status codes** - Leverage HTTP semantics for caching, monitoring, and client handling
2. **Consistent JSON structure** - All responses follow predictable shapes
3. **Error codes for automation** - Machine-readable codes enable programmatic error handling
4. **Pagination metadata** - Standardized pagination for list endpoints

## Response Structure

### Success Responses

#### Single Resource (200 OK)

```json
{
  "data": {
    "id": "uuid",
    "name": "Example",
    "createdAt": "2024-01-15T10:30:00Z"
  }
}
```

#### Collection (200 OK)

```json
{
  "data": [
    { "id": "1", "name": "Item 1" },
    { "id": "2", "name": "Item 2" }
  ],
  "pagination": {
    "hasMore": true,
    "nextCursor": "cursor_abc123",
    "total": 100
  }
}
```

#### Created Resource (201 Created)

```json
{
  "data": {
    "id": "new-uuid",
    "name": "New Item",
    "createdAt": "2024-01-15T10:30:00Z"
  }
}
```

Response includes `Location` header: `/api/people/new-uuid`

#### No Content (204 No Content)

Empty body. Used for:
- Successful DELETE operations
- PUT/PATCH when no response body needed

#### Accepted (202 Accepted)

```json
{
  "data": {
    "taskId": "task-uuid",
    "status": "processing"
  }
}
```

Used for async operations (e.g., re-enrichment triggers).

### Error Responses

All errors follow this structure:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable description",
    "details": [
      {
        "field": "displayName",
        "message": "Display name is required",
        "code": "REQUIRED"
      }
    ]
  }
}
```

#### Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `BAD_REQUEST` | 400 | Malformed request syntax |
| `VALIDATION_ERROR` | 400 | Request validation failed |
| `UNAUTHORIZED` | 401 | Authentication required |
| `FORBIDDEN` | 403 | Permission denied |
| `NOT_FOUND` | 404 | Resource not found |
| `CONFLICT` | 409 | Resource conflict (e.g., duplicate) |
| `UNPROCESSABLE` | 422 | Semantic error in request |
| `TOO_MANY_REQUESTS` | 429 | Rate limit exceeded |
| `INTERNAL_ERROR` | 500 | Unexpected server error |
| `SERVICE_UNAVAILABLE` | 503 | Dependency unavailable |

## Pagination

### Cursor-Based (Preferred)

Best for real-time data where items may be added/removed.

Request:
```
GET /api/inbox?limit=20&cursor=abc123
```

Response:
```json
{
  "data": [...],
  "pagination": {
    "hasMore": true,
    "nextCursor": "def456",
    "prevCursor": "abc123"
  }
}
```

### Offset-Based

Best for search results with stable ordering.

Request:
```
GET /api/search?q=hello&limit=20&offset=40
```

Response:
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

## Implementation Guide

### Using Response Helpers

```go
import "github.com/xiaoyuanzhu-com/my-life-db/api"

// Single resource
func (h *Handlers) GetPerson(c *gin.Context) {
    person, err := db.GetPerson(id)
    if err != nil {
        api.RespondInternalError(c, "Failed to get person")
        return
    }
    if person == nil {
        api.RespondNotFound(c, "Person not found")
        return
    }
    api.RespondData(c, person)
}

// Created resource
func (h *Handlers) CreatePerson(c *gin.Context) {
    // ... validation and creation ...
    api.RespondCreated(c, person, "/api/people/"+person.ID)
}

// List with pagination
func (h *Handlers) GetPeople(c *gin.Context) {
    people, hasMore, nextCursor := db.ListPeople(limit, cursor)
    api.RespondList(c, people, &api.Pagination{
        HasMore:    hasMore,
        NextCursor: nextCursor,
    })
}

// Delete
func (h *Handlers) DeletePerson(c *gin.Context) {
    // ... deletion logic ...
    api.RespondNoContent(c)
}

// Validation error
func (h *Handlers) CreatePerson(c *gin.Context) {
    if body.DisplayName == "" {
        api.RespondValidationError(c, "Validation failed", []api.ErrorDetail{
            {Field: "displayName", Message: "Display name is required", Code: "REQUIRED"},
        })
        return
    }
}
```

## Migration Strategy

Existing endpoints use `gin.H{}` ad-hoc responses. To migrate:

1. **New endpoints**: Always use the typed helpers
2. **Existing endpoints**: Migrate when touching the code
3. **Breaking changes**: Communicate to frontend before deploying

### Before (Legacy)

```go
// Direct array
c.JSON(200, people)

// Ad-hoc success
c.JSON(200, gin.H{"success": true})

// Ad-hoc error
c.JSON(400, gin.H{"error": "Invalid request"})

// Delete with body
c.JSON(200, gin.H{"success": true})
```

### After (Standard)

```go
// Wrapped array
api.RespondList(c, people, nil)

// Data response (for mutations returning data)
api.RespondData(c, result)

// Typed error
api.RespondBadRequest(c, "Invalid request")

// Delete without body
api.RespondNoContent(c)
```

## Endpoint-Specific Patterns

### Inbox

The inbox has a custom pagination structure for bidirectional scrolling. It will be migrated to use the standard response wrapper while keeping its cursor semantics:

```json
{
  "data": [...items...],
  "pagination": {
    "hasMore": { "older": true, "newer": false },
    "cursors": { "first": "...", "last": "..." }
  }
}
```

### Search

Search uses offset-based pagination with total count:

```json
{
  "data": [...results...],
  "pagination": {
    "total": 156,
    "limit": 20,
    "offset": 0,
    "hasMore": true
  }
}
```

### Claude Sessions

Sessions use cursor-based pagination:

```json
{
  "data": [...sessions...],
  "pagination": {
    "hasMore": true,
    "nextCursor": "...",
    "totalCount": 50
  }
}
```

## Frontend Integration

TypeScript types for the API:

```typescript
// Generic response types
interface DataResponse<T> {
  data: T;
}

interface ListResponse<T> {
  data: T[];
  pagination?: Pagination;
}

interface Pagination {
  hasMore: boolean;
  nextCursor?: string;
  prevCursor?: string;
  total?: number;
  limit?: number;
  offset?: number;
}

interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: Array<{
      field?: string;
      message: string;
      code?: string;
    }>;
  };
}

// API client helper
async function apiCall<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const json = await res.json();

  if (!res.ok) {
    const error = json as ErrorResponse;
    throw new ApiError(error.error.code, error.error.message, error.error.details);
  }

  return (json as DataResponse<T>).data;
}

async function apiList<T>(url: string): Promise<{ data: T[]; pagination?: Pagination }> {
  const res = await fetch(url);
  const json = await res.json();

  if (!res.ok) {
    const error = json as ErrorResponse;
    throw new ApiError(error.error.code, error.error.message, error.error.details);
  }

  return json as ListResponse<T>;
}
```

## Checklist for New Endpoints

- [ ] Use appropriate HTTP method (GET/POST/PUT/PATCH/DELETE)
- [ ] Return proper HTTP status code
- [ ] Wrap response in `data` field using helpers
- [ ] Use `RespondNotFound` for missing resources
- [ ] Use `RespondValidationError` with details for validation failures
- [ ] Use `RespondNoContent` for DELETE operations
- [ ] Include pagination for list endpoints
- [ ] Add `Location` header for 201 Created responses
