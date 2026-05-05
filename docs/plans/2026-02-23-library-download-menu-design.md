# Library Download Menu

## Problem

The library page's right-click context menu on files and folders has no download option. Download only exists in the file viewer (unknown types) and FileCard (Inbox/Home).

## Design

### Backend

New endpoint: `GET /api/library/download?path=X`

- **Files:** Sets `Content-Disposition: attachment` and serves via `http.ServeContent()` — reuses existing raw file serving logic but forces download.
- **Folders:** Walks the directory, streams a zip archive using Go's `archive/zip.Writer` directly to the response. Headers: `Content-Type: application/zip`, `Content-Disposition: attachment; filename="<folder-name>.zip"`.
- Same path security checks as existing endpoints (no `..` traversal).

### Frontend

Add "Download" to the context menu in both `file-tree.tsx` and `grid-item.tsx`:

```
├─ Download        ← NEW
├─ ───────
├─ Rename
├─ Copy Path
├─ ───────
├─ Delete
```

- **Files:** Uses existing `downloadFile()` utility → `/raw/{path}`.
- **Folders:** Triggers download via `/api/library/download?path=X` using the same `<a>` download pattern.

### Approach

On-the-fly streaming zip — no temp files, no disk space concerns. Go's `archive/zip` writes directly to the HTTP response writer.

### Scope

One new backend endpoint. Two context menu additions (tree view + grid view). No new UI components, no state management, no database changes.
