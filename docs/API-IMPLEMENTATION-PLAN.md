# API Standardization Implementation Plan

This document outlines the changes needed to align the current API implementation with the design principles defined in `docs/API.md`.

**Status**: Pre-release - No backward compatibility required

---

## Summary of Changes

### Response Format Changes
All endpoints will wrap responses in `{"data": ...}` and use standardized error format with codes.

### Route Changes
Some routes will be renamed to follow RESTful conventions.

### HTTP Method/Status Changes
- DELETE operations → 204 No Content
- Settings update → PATCH instead of PUT
- Settings reset → DELETE instead of POST

---

## Implementation Phases

### Phase 1: Core Infrastructure (Do First)

#### 1.1 Response Helpers (✅ DONE)
- [x] `backend/api/response.go` created with:
  - `RespondData[T]()` - Single resource
  - `RespondList[T]()` - Collections
  - `RespondCreated[T]()` - 201 with Location header
  - `RespondNoContent()` - 204 empty body
  - `RespondAccepted()` - 202 for async ops
  - Error helpers with codes

#### 1.2 Remove Example File
- [ ] Delete `backend/api/people_v2.go` (was just for demonstration)

---

### Phase 2: Route Restructuring

#### 2.1 Routes to Rename

| Current | New | Reason |
|---------|-----|--------|
| `GET /api/inbox/:id` | `GET /api/inbox/:filename` | Clarity - it's a filename, not UUID |
| `GET /api/library/file-info` | `GET /api/library/files` | Consistent resource naming |
| `DELETE /api/library/file` | `DELETE /api/library/files` | Consistent with GET |
| `POST /api/library/rename` | `PATCH /api/library/files` | RESTful update |
| `POST /api/library/move` | `PATCH /api/library/files` | RESTful update (merge with rename) |
| `POST /api/library/folder` | `POST /api/library/folders` | Plural for resource creation |
| `POST /api/library/pin` | `PUT /api/library/pins` | Idempotent pin operation |
| `DELETE /api/library/pin` | `DELETE /api/library/pins` | Consistent with PUT |
| `GET /api/digest/file/*path` | `GET /api/digest/files/*path` | Plural consistency |
| `POST /api/digest/file/*path` | `POST /api/digest/files/*path` | Plural consistency |
| `DELETE /api/digest/reset/:digester` | `POST /api/digest/digesters/:name/reset` | Resource-oriented |
| `POST /api/people/embeddings/:id/assign` | `PUT /api/people/embeddings/:id` | PUT for assignment |
| `POST /api/people/embeddings/:id/unassign` | `DELETE /api/people/embeddings/:id` | DELETE for removal |

#### 2.2 Update `routes.go`

```go
// File: backend/api/routes.go

// Inbox routes - rename :id to :filename for clarity
api.GET("/inbox/:filename", h.GetInboxItem)
api.PUT("/inbox/:filename", h.UpdateInboxItem)
api.DELETE("/inbox/:filename", h.DeleteInboxItem)
api.POST("/inbox/:filename/reenrich", h.ReenrichInboxItem)
api.GET("/inbox/:filename/status", h.GetInboxItemStatus)

// Library routes - restructure for REST
api.GET("/library/files", h.GetLibraryFileInfo)      // ?path=...
api.PATCH("/library/files", h.UpdateLibraryFile)     // rename or move
api.DELETE("/library/files", h.DeleteLibraryFile)    // ?path=...
api.POST("/library/folders", h.CreateLibraryFolder)
api.PUT("/library/pins", h.PinFile)                  // idempotent pin
api.DELETE("/library/pins", h.UnpinFile)             // ?path=...

// Digest routes - plural consistency
api.GET("/digest/files/*path", h.GetDigest)
api.POST("/digest/files/*path", h.TriggerDigest)
api.POST("/digest/digesters/:name/reset", h.ResetDigester)

// People embeddings - REST semantics
api.PUT("/people/embeddings/:id", h.AssignEmbedding)
api.DELETE("/people/embeddings/:id", h.UnassignEmbedding)

// Settings - proper HTTP methods
api.GET("/settings", h.GetSettings)
api.PATCH("/settings", h.UpdateSettings)  // Changed from PUT
api.DELETE("/settings", h.ResetSettings)  // Changed from POST
```

---

### Phase 3: Handler Updates

#### 3.1 People Handlers (`people.go`)

```go
// GetPeople - wrap in data
func (h *Handlers) GetPeople(c *gin.Context) {
    // ... existing query logic ...
    RespondList(c, people, nil)
}

// CreatePerson - 201 with Location header
func (h *Handlers) CreatePerson(c *gin.Context) {
    // ... validation with RespondValidationError ...
    // ... creation logic ...
    RespondCreated(c, person, "/api/people/"+person.ID)
}

// GetPerson - wrap in data
func (h *Handlers) GetPerson(c *gin.Context) {
    // ... existing logic ...
    if err == sql.ErrNoRows {
        RespondNotFound(c, "Person not found")
        return
    }
    RespondData(c, person)
}

// UpdatePerson - return updated resource
func (h *Handlers) UpdatePerson(c *gin.Context) {
    // ... update logic ...
    RespondData(c, updatedPerson)
}

// DeletePerson - 204 No Content
func (h *Handlers) DeletePerson(c *gin.Context) {
    // ... deletion logic ...
    RespondNoContent(c)
}

// MergePeople - return meaningful data
func (h *Handlers) MergePeople(c *gin.Context) {
    // ... merge logic ...
    RespondData(c, gin.H{"mergedCount": count, "targetId": targetID})
}

// AssignEmbedding - return assignment result
func (h *Handlers) AssignEmbedding(c *gin.Context) {
    // ... assignment logic ...
    RespondData(c, gin.H{"embeddingId": id, "personId": personID})
}

// UnassignEmbedding - 204 No Content
func (h *Handlers) UnassignEmbedding(c *gin.Context) {
    // ... unassignment logic ...
    RespondNoContent(c)
}
```

#### 3.2 Inbox Handlers (`inbox.go`)

```go
// GetInbox - restructure response
func (h *Handlers) GetInbox(c *gin.Context) {
    // Build items...

    // New response structure
    type InboxListResponse struct {
        Items      []InboxItem `json:"items"` // Will be renamed to data by wrapper
        Pagination struct {
            Cursors struct {
                First *string `json:"first"`
                Last  *string `json:"last"`
            } `json:"cursors"`
            HasMore struct {
                Older bool `json:"older"`
                Newer bool `json:"newer"`
            } `json:"hasMore"`
            TargetIndex *int `json:"targetIndex,omitempty"`
        } `json:"pagination"`
    }

    // Use custom response (inbox has special pagination)
    c.JSON(http.StatusOK, gin.H{
        "data": items,
        "pagination": pagination,
    })
}

// CreateInboxItem - 201 with Location
func (h *Handlers) CreateInboxItem(c *gin.Context) {
    // ... creation logic ...
    c.Header("Location", "/api/inbox/"+filepath.Base(savedPaths[0]))
    RespondCreated(c, gin.H{"path": savedPaths[0], "paths": savedPaths}, "")
}

// GetInboxItem - wrap in data
func (h *Handlers) GetInboxItem(c *gin.Context) {
    filename := c.Param("filename") // renamed from "id"
    // ... existing logic ...
    RespondData(c, file)
}

// UpdateInboxItem - return updated metadata
func (h *Handlers) UpdateInboxItem(c *gin.Context) {
    // ... update logic ...
    RespondData(c, gin.H{"path": path, "modifiedAt": nowStr})
}

// DeleteInboxItem - 204 No Content
func (h *Handlers) DeleteInboxItem(c *gin.Context) {
    // ... deletion logic ...
    RespondNoContent(c)
}

// GetPinnedInboxItems - wrap in data
func (h *Handlers) GetPinnedInboxItems(c *gin.Context) {
    // ... existing logic ...
    RespondList(c, items, nil)
}

// ReenrichInboxItem - 202 Accepted
func (h *Handlers) ReenrichInboxItem(c *gin.Context) {
    // ... trigger logic ...
    RespondAccepted(c, gin.H{"message": "Re-enrichment triggered", "path": path})
}

// GetInboxItemStatus - wrap in data
func (h *Handlers) GetInboxItemStatus(c *gin.Context) {
    // ... existing logic ...
    RespondData(c, gin.H{"status": status, "digests": digests})
}
```

#### 3.3 Library/Files Handlers (`files.go`)

```go
// GetLibraryTree - wrap in data
func (h *Handlers) GetLibraryTree(c *gin.Context) {
    // ... existing logic ...
    RespondData(c, tree)
}

// GetLibraryFileInfo - wrap in data
func (h *Handlers) GetLibraryFileInfo(c *gin.Context) {
    // ... existing logic ...
    RespondData(c, file)
}

// DeleteLibraryFile - 204 No Content
func (h *Handlers) DeleteLibraryFile(c *gin.Context) {
    // ... deletion logic ...
    RespondNoContent(c)
}

// UpdateLibraryFile - NEW: combines rename and move
func (h *Handlers) UpdateLibraryFile(c *gin.Context) {
    var body struct {
        Path   string  `json:"path"`   // Required: current path
        Name   *string `json:"name"`   // Optional: new name (rename)
        Parent *string `json:"parent"` // Optional: new parent (move)
    }
    // ... validation ...

    if body.Name != nil {
        // Rename operation
        newPath := // ... compute new path
        RespondData(c, gin.H{"path": newPath})
    } else if body.Parent != nil {
        // Move operation
        newPath := // ... compute new path
        RespondData(c, gin.H{"path": newPath})
    }
}

// CreateLibraryFolder - 201 with Location
func (h *Handlers) CreateLibraryFolder(c *gin.Context) {
    // ... creation logic ...
    RespondCreated(c, gin.H{"path": newPath}, "/api/library/folders?path="+url.QueryEscape(newPath))
}

// PinFile - idempotent PUT
func (h *Handlers) PinFile(c *gin.Context) {
    var body struct {
        Path string `json:"path"`
    }
    // ... always pin (idempotent) ...
    RespondData(c, gin.H{
        "path": body.Path,
        "isPinned": true,
        "pinnedAt": pinnedAt,
    })
}

// UnpinFile - 204 No Content
func (h *Handlers) UnpinFile(c *gin.Context) {
    path := c.Query("path")
    // ... unpin logic ...
    RespondNoContent(c)
}
```

#### 3.4 Settings Handlers (`settings.go`)

```go
// GetSettings - wrap in data
func (h *Handlers) GetSettings(c *gin.Context) {
    // ... existing logic ...
    RespondData(c, settings)
}

// UpdateSettings - PATCH semantics (partial update)
func (h *Handlers) UpdateSettings(c *gin.Context) {
    // ... merge logic ...
    RespondData(c, updatedSettings)
}

// ResetSettings - DELETE semantics (returns defaults)
func (h *Handlers) ResetSettings(c *gin.Context) {
    // ... reset logic ...
    RespondData(c, defaultSettings)
}
```

#### 3.5 Auth Handlers (`auth.go`)

```go
// Login - wrap in data
func (h *Handlers) Login(c *gin.Context) {
    // ... validation ...
    if !valid {
        RespondUnauthorized(c, "Invalid password")
        return
    }
    RespondData(c, gin.H{"sessionId": sessionID})
}

// Logout - 204 No Content
func (h *Handlers) Logout(c *gin.Context) {
    // ... clear cookie ...
    RespondNoContent(c)
}
```

#### 3.6 OAuth Handlers (`oauth.go`)

```go
// OAuthToken - wrap in data
func (h *Handlers) OAuthToken(c *gin.Context) {
    if authenticated {
        RespondData(c, gin.H{
            "authenticated": true,
            "username": username,
            "sub": sub,
            "email": email,
        })
    } else {
        RespondData(c, gin.H{"authenticated": false})
    }
}

// OAuthRefresh - wrap in data
func (h *Handlers) OAuthRefresh(c *gin.Context) {
    if err != nil {
        RespondUnauthorized(c, "No refresh token provided")
        return
    }
    RespondData(c, gin.H{"expiresIn": expiresIn})
}

// OAuthLogout - 204 No Content
func (h *Handlers) OAuthLogout(c *gin.Context) {
    // ... clear tokens ...
    RespondNoContent(c)
}
```

#### 3.7 Digest Handlers (`digest.go`)

```go
// GetDigesters - wrap in data
func (h *Handlers) GetDigesters(c *gin.Context) {
    // ... existing logic ...
    RespondList(c, digesters, nil)
}

// GetDigestStats - wrap in data
func (h *Handlers) GetDigestStats(c *gin.Context) {
    // ... existing logic ...
    RespondData(c, stats)
}

// GetDigest - wrap in data
func (h *Handlers) GetDigest(c *gin.Context) {
    // ... existing logic ...
    RespondData(c, gin.H{
        "path": path,
        "status": status,
        "digests": digests,
    })
}

// TriggerDigest - 202 Accepted
func (h *Handlers) TriggerDigest(c *gin.Context) {
    // ... trigger logic ...
    RespondAccepted(c, gin.H{
        "message": "Digest processing triggered",
        "path": path,
    })
}

// ResetDigester - wrap in data
func (h *Handlers) ResetDigester(c *gin.Context) {
    name := c.Param("name") // renamed from "digester"
    // ... reset logic ...
    RespondData(c, gin.H{"affected": affected})
}
```

#### 3.8 Search Handlers (`search.go`)

```go
// Search - restructure response
func (h *Handlers) Search(c *gin.Context) {
    // ... search logic ...

    c.JSON(http.StatusOK, gin.H{
        "data": results,
        "pagination": gin.H{
            "total": total,
            "limit": limit,
            "offset": offset,
            "hasMore": hasMore,
        },
        "meta": gin.H{
            "query": query,
            "timing": timing,
            "sources": sources,
        },
    })
}
```

#### 3.9 AI Handlers (`ai.go`)

```go
// Summarize - wrap in data, fix request field name
func (h *Handlers) Summarize(c *gin.Context) {
    var body struct {
        Text      string `json:"text"`
        MaxTokens int    `json:"maxTokens"` // Changed from max_tokens
    }
    // ... summarization logic ...

    if openaiErr != nil {
        RespondServiceUnavailable(c, "OpenAI API key not configured")
        return
    }

    RespondData(c, gin.H{"summary": summary})
}
```

#### 3.10 Stats Handlers (`stats.go`)

```go
// GetStats - wrap in data
func (h *Handlers) GetStats(c *gin.Context) {
    // ... existing logic ...
    RespondData(c, stats)
}
```

#### 3.11 Upload Handlers (`upload.go`)

```go
// FinalizeUpload - wrap in data
func (h *Handlers) FinalizeUpload(c *gin.Context) {
    // ... existing logic ...
    RespondData(c, gin.H{
        "path": paths[0],
        "paths": paths,
    })
}
```

#### 3.12 Vendors Handlers (`vendors.go`)

```go
// GetOpenAIModels - wrap in data
func (h *Handlers) GetOpenAIModels(c *gin.Context) {
    if !configured {
        RespondServiceUnavailable(c, "OpenAI is not configured")
        return
    }
    // ... existing logic ...
    RespondList(c, models, nil)
}
```

#### 3.13 Directories Handler

```go
// GetDirectories - wrap in data
func (h *Handlers) GetDirectories(c *gin.Context) {
    // ... existing logic ...
    RespondList(c, dirs, nil)
}
```

#### 3.14 Claude Handlers (`claude.go`)

```go
// ListClaudeSessions - wrap in data
func (h *Handlers) ListClaudeSessions(c *gin.Context) {
    // ... existing logic ...
    RespondList(c, sessions, nil)
}

// ListAllClaudeSessions - wrap with pagination
func (h *Handlers) ListAllClaudeSessions(c *gin.Context) {
    // ... existing logic ...
    c.JSON(http.StatusOK, gin.H{
        "data": sessions,
        "pagination": gin.H{
            "hasMore": hasMore,
            "nextCursor": nextCursor,
            "totalCount": totalCount,
        },
    })
}

// CreateClaudeSession - 201 Created
func (h *Handlers) CreateClaudeSession(c *gin.Context) {
    // ... existing logic ...
    RespondCreated(c, session, "/api/claude/sessions/"+session.ID)
}

// GetClaudeSession - wrap in data
func (h *Handlers) GetClaudeSession(c *gin.Context) {
    // ... existing logic ...
    RespondData(c, session)
}

// GetClaudeSessionMessages - wrap in data
func (h *Handlers) GetClaudeSessionMessages(c *gin.Context) {
    // ... existing logic ...
    RespondData(c, gin.H{
        "sessionId": sessionID,
        "mode": mode,
        "count": len(messages),
        "messages": messages,
    })
}

// SendClaudeMessage - 202 Accepted
func (h *Handlers) SendClaudeMessage(c *gin.Context) {
    // ... existing logic ...
    RespondAccepted(c, gin.H{
        "sessionId": sessionID,
        "status": "sent",
    })
}

// UpdateClaudeSession - wrap in data
func (h *Handlers) UpdateClaudeSession(c *gin.Context) {
    // ... existing logic ...
    RespondData(c, gin.H{
        "id": id,
        "title": newTitle,
    })
}

// DeactivateClaudeSession - 204 No Content
func (h *Handlers) DeactivateClaudeSession(c *gin.Context) {
    // ... existing logic ...
    RespondNoContent(c)
}

// DeleteClaudeSession - 204 No Content
func (h *Handlers) DeleteClaudeSession(c *gin.Context) {
    // ... existing logic ...
    RespondNoContent(c)
}
```

---

### Phase 4: Frontend Updates

After backend changes, update frontend API calls:

#### 4.1 Response Unwrapping

```typescript
// Before
const people = await fetch('/api/people').then(r => r.json())

// After
const { data: people } = await fetch('/api/people').then(r => r.json())
```

#### 4.2 Error Handling

```typescript
// Before
if (!res.ok) {
  const { error } = await res.json()
  throw new Error(error)
}

// After
if (!res.ok) {
  const { error } = await res.json()
  throw new ApiError(error.code, error.message, error.details)
}
```

#### 4.3 Route Updates

Update all fetch calls to use new routes:
- `/api/inbox/:id` → `/api/inbox/:filename`
- `/api/library/file-info` → `/api/library/files`
- `/api/library/pin` (POST) → `/api/library/pins` (PUT)
- etc.

---

### Phase 5: Testing & Validation

#### 5.1 Manual Testing Checklist

- [ ] All CRUD operations work for each resource
- [ ] Error responses have correct structure
- [ ] 204 responses have no body
- [ ] 201 responses include Location header
- [ ] Pagination works correctly
- [ ] Frontend displays data correctly

#### 5.2 Build & Lint

```bash
cd backend && go build . && go vet ./...
cd frontend && npm run build && npm run lint && npm run typecheck
```

---

## File Change Summary

| File | Changes |
|------|---------|
| `backend/api/routes.go` | Route restructuring |
| `backend/api/response.go` | Already created |
| `backend/api/people.go` | Use response helpers |
| `backend/api/inbox.go` | Use response helpers, rename param |
| `backend/api/files.go` | Combine rename/move, use response helpers |
| `backend/api/settings.go` | Change methods, use response helpers |
| `backend/api/auth.go` | Use response helpers |
| `backend/api/oauth.go` | Use response helpers |
| `backend/api/digest.go` | Use response helpers |
| `backend/api/search.go` | Restructure response |
| `backend/api/ai.go` | Use response helpers |
| `backend/api/stats.go` | Use response helpers |
| `backend/api/upload.go` | Use response helpers |
| `backend/api/vendors.go` | Use response helpers |
| `backend/api/claude.go` | Use response helpers |
| `backend/api/people_v2.go` | Delete (example file) |
| `frontend/**/*.ts(x)` | Unwrap `data` field, update routes |

---

## Estimated Effort

| Phase | Time |
|-------|------|
| Phase 1: Infrastructure | ✅ Done |
| Phase 2: Route restructuring | 30 min |
| Phase 3: Handler updates | 2-3 hours |
| Phase 4: Frontend updates | 1-2 hours |
| Phase 5: Testing | 1 hour |
| **Total** | **~5-6 hours** |

---

## Notes

1. **No backward compatibility** - This is a clean implementation since we're pre-release
2. **WebSocket endpoints unchanged** - Claude/ASR WebSocket protocols remain the same
3. **Raw/SQLAR endpoints unchanged** - File serving endpoints don't need wrapping
4. **SSE unchanged** - Notification stream format remains the same
