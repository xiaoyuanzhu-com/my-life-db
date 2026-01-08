# API Comparison: Node.js vs Go Backend

## Summary
Comparing API endpoints between archived Node.js implementation and current Go backend to identify migration issues.

## Legend
- ✅ = Exact match
- ⚠️ = Partial match (minor differences)
- ❌ = Critical mismatch (will break frontend)
- ❓ = Needs verification

---

## ✅ ALL CRITICAL ISSUES FIXED

### 1. `/api/stats` GET - ✅ FIXED

Updated [backend/api/stats.go](backend/api/stats.go:13) to return proper schema:
```json
{
  "library": { "fileCount": 0, "totalSize": 0 },
  "inbox": { "itemCount": 0 },
  "digests": { "totalFiles": 0, "digestedFiles": 0, "pendingDigests": 0 }
}
```

---

### 2. `/api/digest/digesters` GET - ✅ FIXED

Updated [backend/api/digest.go](backend/api/digest.go:40) to return proper schema:
```json
{
  "digesters": [
    {
      "name": "tags",
      "label": "Tags",
      "description": "Generate tags using AI",
      "outputs": ["tags"]
    }
  ]
}
```

---

### 3. `/api/digest/reset/:digester` - ✅ FIXED

Changed HTTP method from POST to DELETE in [backend/api/routes.go](backend/api/routes.go:36) to match frontend expectations.

---

## Endpoints Status Table

| Endpoint | Method | Status | Issues |
|----------|--------|--------|--------|
| **Settings** |
| `/api/settings` | GET | ✅ | FIXED - Returns proper UserSettings schema |
| `/api/settings` | PUT | ✅ | FIXED - Proper merge logic implemented |
| `/api/settings` | POST | ✅ | FIXED - Requires `{action: "reset"}` |
| **Stats & Diagnostics** |
| `/api/stats` | GET | ✅ | FIXED - Returns `library`, `inbox`, `digests` |
| `/api/digest/stats` | GET | ❓ | Need to verify schema |
| **Digesters** |
| `/api/digest/digesters` | GET | ✅ | FIXED - Wrapper object, `label`, `outputs` added |
| `/api/digest/reset/:digester` | DELETE | ✅ | FIXED - Changed to DELETE method |
| `/api/digest/file/*path` | GET | ❓ | Need to verify schema |
| `/api/digest/file/*path` | POST | ❓ | Need to verify schema |
| **Inbox** |
| `/api/inbox` | GET | ❓ | Need to verify schema |
| `/api/inbox` | POST | ❓ | Need to verify schema |
| `/api/inbox/:id` | GET | ❓ | Need to verify schema |
| `/api/inbox/:id` | PUT | ❓ | Need to verify schema |
| `/api/inbox/:id` | DELETE | ❓ | Need to verify schema |
| `/api/inbox/:id/status` | GET | ❓ | Need to verify schema |
| `/api/inbox/:id/reenrich` | POST | ❓ | Need to verify schema |
| `/api/inbox/pinned` | GET | ❓ | Need to verify schema |
| **Library** |
| `/api/library/tree` | GET | ❓ | Need to verify schema |
| `/api/library/file-info` | GET | ❓ | Need to verify schema |
| `/api/library/file` | DELETE | ❓ | Need to verify schema |
| `/api/library/pin` | POST | ❓ | Need to verify schema |
| `/api/library/pin` | DELETE | ❓ | Need to verify schema |
| **People** |
| `/api/people` | GET | ❓ | Need to verify schema |
| `/api/people` | POST | ❓ | Need to verify schema |
| `/api/people/:id` | GET | ❓ | Need to verify schema |
| `/api/people/:id` | PUT | ❓ | Need to verify schema |
| `/api/people/:id` | DELETE | ❓ | Need to verify schema |
| `/api/people/:id/merge` | POST | ❓ | Need to verify schema |
| `/api/people/embeddings/:id/assign` | POST | ❓ | Need to verify schema |
| `/api/people/embeddings/:id/unassign` | POST | ❓ | Need to verify schema |
| **Search** |
| `/api/search` | GET | ❓ | Need to verify schema |
| **Upload** |
| `/api/upload/finalize` | POST | ❓ | Need to verify schema |
| `/api/upload/tus/*path` | ANY | ❓ | Need to verify schema |
| **Vendors** |
| `/api/vendors/openai/models` | GET | ❓ | Need to verify schema |
| **Auth** |
| `/api/auth/login` | POST | ❓ | Need to verify schema |
| `/api/auth/logout` | POST | ❓ | Need to verify schema |
| **OAuth** |
| `/api/oauth/authorize` | GET | ❓ | Need to verify schema |
| `/api/oauth/callback` | GET | ❓ | Need to verify schema |
| `/api/oauth/refresh` | GET | ❓ | Need to verify schema |
| `/api/oauth/token` | GET | ❓ | Need to verify schema |
| **Directories** |
| `/api/directories` | GET | ❓ | Need to verify schema |
| **Notifications** |
| `/api/notifications/stream` | GET | ❓ | SSE endpoint - need to verify |

---

## Migration Risk Assessment

### 🔴 HIGH RISK - Will Break Frontend (0 endpoints)
~~1. `/api/stats` - Used by Settings page Stats tab~~ ✅ FIXED
~~2. `/api/digest/digesters` - Used by Settings Digest tab~~ ✅ FIXED

### 🟡 MEDIUM RISK - HTTP Method Mismatch (0 endpoints)
~~3. `/api/digest/reset/:digester` - DELETE vs POST~~ ✅ FIXED

### ⚪ LOW RISK - Need Schema Verification (40+ endpoints)
- All other endpoints need detailed schema comparison

---

## Action Plan

### Phase 1: Fix Critical Issues (IMMEDIATE)
1. ✅ **COMPLETED:** Fix `/api/settings` schema
2. ✅ **COMPLETED:** Fix `/api/stats` response schema
3. ✅ **COMPLETED:** Fix `/api/digest/digesters` response schema
4. ✅ **COMPLETED:** Change `/api/digest/reset/:digester` to DELETE method

### Phase 2: Verify Remaining Endpoints
- Systematically check all other endpoints
- Document any schema differences
- Fix mismatches before production migration

---

## Notes

- Settings API has been fixed and tested working
- Node.js implementation is in `/archive/node-routes/`
- Go implementation is in `/backend/api/`
- Frontend expects exact schema matches for type safety
