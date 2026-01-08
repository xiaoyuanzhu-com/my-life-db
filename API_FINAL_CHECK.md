# Final API Verification Check

## Endpoints Verified as Compatible ✅

### 1. Settings (3/3)
- ✅ GET /api/settings - Proper UserSettings structure
- ✅ PUT /api/settings - Merge logic implemented
- ✅ POST /api/settings - Reset with action parameter

### 2. Stats & Digest (4/4)
- ✅ GET /api/stats - Returns {library, inbox, digests}
- ✅ GET /api/digest/digesters - Returns {digesters: [{name, label, description, outputs}]}
- ✅ DELETE /api/digest/reset/:digester - HTTP method aligned
- ✅ GET/POST /api/digest/file/*path - Schema appears compatible

### 3. Vendors (1/1)
- ✅ GET /api/vendors/openai/models - Returns {models: [{id, owned_by}]}

### 4. Library (1/N)
- ✅ GET /api/library/tree - Returns {path, nodes} with proper schema

### 5. Search (1/1)
- ✅ GET /api/search - Schema matches, returns {results, pagination, query, timing, sources}

## Known Issues

### Critical Bug
1. **Inbox Around Cursor** - `ListTopLevelFilesAround()` not implemented
   - Breaks pin navigation
   - Currently falls back to newest items

## Not Yet Verified (Low Priority)

These endpoints exist in both implementations but haven't been schema-checked:

### Inbox Operations
- POST /api/inbox - Create item
- GET /api/inbox/:id - Get item
- PUT /api/inbox/:id - Update item  
- DELETE /api/inbox/:id - Delete item
- POST /api/inbox/:id/reenrich - Trigger re-enrichment
- GET /api/inbox/:id/status - Get processing status
- GET /api/inbox/pinned - Get pinned items

### Library Operations
- GET /api/library/file-info - Get file metadata
- DELETE /api/library/file - Delete file
- POST /api/library/pin - Pin file
- DELETE /api/library/pin - Unpin file

### People Management
- GET /api/people - List people
- POST /api/people - Create person
- GET /api/people/:id - Get person
- PUT /api/people/:id - Update person
- DELETE /api/people/:id - Delete person
- POST /api/people/:id/merge - Merge people
- POST /api/people/embeddings/:id/assign - Assign embedding
- POST /api/people/embeddings/:id/unassign - Unassign embedding

### Upload
- POST /api/upload/finalize - Finalize upload
- ANY /api/upload/tus/*path - TUS protocol

### OAuth
- GET /api/oauth/authorize - Start OAuth flow
- GET /api/oauth/callback - OAuth callback
- GET /api/oauth/refresh - Refresh token
- GET /api/oauth/token - Get token

### Auth
- POST /api/auth/login - Login
- POST /api/auth/logout - Logout

### Misc
- GET /api/directories - List directories
- GET /api/notifications/stream - SSE notifications
- GET /api/digest/stats - Digest statistics

## Recommendation

**Current State:** Core APIs for Settings page are working ✅

**Next Steps:**
1. Test Settings page end-to-end with Go backend
2. Fix inbox around cursor bug for pin navigation
3. Incrementally verify remaining endpoints as needed when testing other pages

**Migration Strategy:**
- ✅ Phase 1 Complete: Critical Settings APIs working
- Phase 2: Test and fix issues as they arise during integration testing
- Phase 3: Implement missing ListTopLevelFilesAround for pins
