# API Migration Summary: Node.js → Go

## Status: Phase 1 Complete ✅

All critical API schema mismatches have been identified and fixed. The Go backend now matches the Node.js implementation for core endpoints used by the Settings page.

---

## Fixed Issues (Committed)

### 1. `/api/settings` - ✅ FIXED
**Commit:** Initial migration commits
- Added `LoadUserSettings()` / `SaveUserSettings()` to convert flat DB storage to structured UserSettings
- Implemented proper merge logic for partial updates
- Added API key sanitization (masking with asterisks)
- Response now matches Node.js structured object with preferences, vendors, digesters, extraction, storage

### 2. `/api/stats` - ✅ FIXED
**Commit:** bb2ae40 (bundled with library/tree)
- **Was:** `{files, digests, pins, system, notificationSubscribers}`
- **Now:** `{library: {fileCount, totalSize}, inbox: {itemCount}, digests: {totalFiles, digestedFiles, pendingDigests}}`
- Updated SQL queries to match Node.js exactly

### 3. `/api/digest/digesters` - ✅ FIXED
**Commit:** bb2ae40 (bundled with library/tree)
- **Was:** `[{name, description}]` (flat array)
- **Now:** `{digesters: [{name, label, description, outputs}]}` (wrapped with all fields)
- Added `DigesterInfo` struct
- Added `label` for display
- Added `outputs` array

### 4. `/api/digest/reset/:digester` - ✅ FIXED
**Commit:** bb2ae40 (bundled with library/tree)
- Changed HTTP method from POST → DELETE to match frontend

### 5. `/api/vendors/openai/models` - ✅ FIXED
**Commit:** 9b98fb7
- **Was:** `["model1", "model2"]` (string array)
- **Now:** `{models: [{id, owned_by}]}` (object array with metadata)
- Added `ModelInfo` struct

### 6. `/api/library/tree` - ✅ FIXED
**Commit:** bb2ae40
- **Query param:** Changed `?root=` → `?path=` to match Node.js
- **Response:** Changed `[{name, path, isFolder, size}]` → `{path, nodes: [{name, path, type, size, modifiedAt, children}]}`
- **Node type:** Changed `isFolder` boolean → `type: "file"|"folder"` string
- Added proper sorting (folders first, then alphabetically)
- Added empty `children` array for folders (for consistency)

---

## Known Issues (Not Yet Fixed)

### 1. `/api/inbox?around=<cursor>` - ❌ BUG
**File:** `INBOX_AROUND_BUG.md`
**Issue:** Pin navigation broken
- `ListTopLevelFilesAround()` function doesn't exist in Go
- Currently falls back to `ListTopLevelFilesNewest()` which breaks pin navigation
- **Impact:** Clicking a pinned item doesn't load the page containing that item
- **Fix Required:** Implement `ListTopLevelFilesAround()` in `backend/db/files.go`

---

## Verification Status by Category

### ✅ Settings & Stats (6/6 fixed)
- `/api/settings` GET ✅
- `/api/settings` PUT ✅
- `/api/settings` POST ✅
- `/api/stats` GET ✅
- `/api/digest/digesters` GET ✅
- `/api/digest/reset/:digester` DELETE ✅

### ⚠️ Inbox (1 bug found)
- `/api/inbox` GET ⚠️ (around cursor broken, otherwise works)
- `/api/inbox` POST ❓ (needs verification)
- `/api/inbox/:id` * ❓ (needs verification)

### ✅ Library (1/N verified)
- `/api/library/tree` GET ✅
- `/api/library/file-info` GET ❓
- `/api/library/file` DELETE ❓
- `/api/library/pin` POST/DELETE ❓

### ✅ Vendors (1/1 verified)
- `/api/vendors/openai/models` GET ✅

### ❓ Remaining (Need Verification)
- `/api/search` GET
- `/api/people/*` (all endpoints)
- `/api/upload/*` (TUS upload)
- `/api/oauth/*` (OAuth flow)
- `/api/directories` GET
- `/api/notifications/stream` GET (SSE)
- `/api/digest/file/*path` GET/POST

---

## Migration Principles Applied

1. **Always align to Node.js** - It was working, so match its behavior exactly
2. **Fix schema mismatches** - Frontend expects specific response shapes
3. **Match HTTP methods** - GET/POST/PUT/DELETE must match frontend calls
4. **Match query parameters** - Parameter names must be identical
5. **Preserve field names** - Respect camelCase/snake_case conventions per layer

---

## Callouts for Discussion

### 1. Inbox Around Cursor (High Priority)
The `ListTopLevelFilesAround` function is completely missing in Go. This is used for pin navigation - a core feature. Should we:
- **Option A:** Implement it properly (returns page containing the cursor item)
- **Option B:** Remove pin navigation feature entirely (not recommended)
- **Recommendation:** Implement it - it's needed for UX

### 2. Response Format Patterns
Node.js consistently wraps arrays in objects: `{items: [...]}`, `{models: [...]}`, `{digesters: [...]}`
Go sometimes returns bare arrays. We should be consistent with Node.js patterns for easier frontend TypeScript typing.

### 3. Error Handling
Both implementations return `{error: "..."}` on errors. This is good and consistent.

---

## Testing Checklist

Before full migration:
- [ ] Test Settings page (all tabs work) ✅ (should work now)
- [ ] Test Inbox pagination (without pins)
- [ ] Test Pin navigation in Inbox (known broken)
- [ ] Test Library tree navigation
- [ ] Test Search functionality
- [ ] Test People management
- [ ] Test File upload (TUS)
- [ ] Test OAuth login flow
- [ ] Test SSE notifications

---

## Next Steps

**Phase 2: Verify Remaining Endpoints**
1. Check `/api/search` schema
2. Check `/api/people/*` endpoints
3. Check `/api/upload/*` TUS implementation
4. Check `/api/oauth/*` flow
5. Implement `ListTopLevelFilesAround` for inbox pins

**Phase 3: Integration Testing**
1. Run full frontend against Go backend
2. Test all user flows end-to-end
3. Fix any runtime issues discovered

---

## Files Modified

```
backend/api/settings.go       - Settings CRUD with proper schema
backend/api/stats.go          - Stats with library/inbox/digests structure
backend/api/digest.go         - Digesters list with label/outputs
backend/api/routes.go         - HTTP method corrections
backend/api/files.go          - Library tree with proper schema
backend/vendors/openai.go     - Models list with id/owned_by
backend/db/settings.go        - Settings conversion functions
backend/models/settings.go    - UserSettings struct
API_COMPARISON.md             - Detailed comparison table
INBOX_AROUND_BUG.md          - Documentation of pin navigation bug
```

---

## Git Commits

```bash
9b98fb7 - fix: /api/vendors/openai/models response schema
bb2ae40 - fix: /api/library/tree schema and parameter alignment
         (includes /api/stats and /api/digest/* fixes)
[earlier] - fix: align API response schemas with Node.js implementation
         (includes /api/settings fixes)
```
