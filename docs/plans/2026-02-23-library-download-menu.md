# Library Download Menu Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a "Download" item to the library page's right-click context menu for both files and folders, with folder download as streaming zip.

**Architecture:** New `GET /api/library/download?path=X` endpoint. Files get served with `Content-Disposition: attachment`. Folders get streamed as zip via Go's `archive/zip.Writer`. Frontend adds one menu item to each context menu (tree view + grid view) using a shared `downloadItem()` helper.

**Tech Stack:** Go (Gin), React, shadcn/ui ContextMenu, lucide-react icons

---

### Task 1: Backend — Download Endpoint

**Files:**
- Modify: `backend/api/files.go` (after line 231, after `DeleteLibraryFile`)
- Modify: `backend/api/routes.go` (after line 58, in library routes group)

**Step 1: Add the handler to `files.go`**

Insert after the `DeleteLibraryFile` handler (after line 231):

```go
// DownloadLibraryPath handles GET /api/library/download
// Files: serves with Content-Disposition attachment
// Folders: streams a zip archive
func (h *Handlers) DownloadLibraryPath(c *gin.Context) {
	path := c.Query("path")
	if path == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Path is required"})
		return
	}

	// Security: prevent directory traversal
	if strings.Contains(path, "..") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid path"})
		return
	}

	cfg := config.Get()
	fullPath := filepath.Join(cfg.UserDataDir, path)

	info, err := os.Stat(fullPath)
	if os.IsNotExist(err) {
		c.JSON(http.StatusNotFound, gin.H{"error": "File not found"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to stat path"})
		return
	}

	if info.IsDir() {
		h.downloadFolder(c, fullPath, filepath.Base(path))
	} else {
		h.downloadFile(c, fullPath, filepath.Base(path))
	}
}

func (h *Handlers) downloadFile(c *gin.Context, fullPath, name string) {
	f, err := os.Open(fullPath)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to open file"})
		return
	}
	defer f.Close()

	info, _ := f.Stat()
	c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, name))
	http.ServeContent(c.Writer, c.Request, name, info.ModTime(), f)
}

func (h *Handlers) downloadFolder(c *gin.Context, fullPath, name string) {
	c.Header("Content-Type", "application/zip")
	c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.zip"`, name))

	zw := zip.NewWriter(c.Writer)
	defer zw.Close()

	err := filepath.Walk(fullPath, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		// Skip directories as entries (they're implied by file paths)
		if info.IsDir() {
			return nil
		}

		relPath, err := filepath.Rel(fullPath, path)
		if err != nil {
			return err
		}

		header, err := zip.FileInfoHeader(info)
		if err != nil {
			return err
		}
		header.Name = filepath.Join(name, relPath)
		header.Method = zip.Deflate

		w, err := zw.CreateHeader(header)
		if err != nil {
			return err
		}

		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()

		_, err = io.Copy(w, f)
		return err
	})

	if err != nil {
		log.Error().Err(err).Str("path", fullPath).Msg("failed to create zip archive")
		// Can't send JSON error since we already started streaming
	}
}
```

**Step 2: Add `"archive/zip"` to imports in `files.go`**

Add to the import block at line 3-22:

```go
import (
	"archive/zip"   // ← ADD
	"bytes"
	"compress/zlib"
	// ... rest unchanged
)
```

**Step 3: Register the route in `routes.go`**

Add after line 58 (`api.POST("/library/folder", h.CreateLibraryFolder)`):

```go
		api.GET("/library/download", h.DownloadLibraryPath)
```

**Step 4: Build and verify**

Run: `cd backend && go build ./...`
Expected: Compiles with no errors.

**Step 5: Commit**

```bash
git add backend/api/files.go backend/api/routes.go
git commit -m "feat: add library download endpoint for files and folders"
```

---

### Task 2: Frontend — Shared Download Helper

**Files:**
- Modify: `frontend/app/components/FileCard/utils.ts` (after line 182)

**Step 1: Add folder download helper**

Insert after the existing `downloadFile` function (after line 182):

```typescript
/**
 * Download a folder as a zip archive
 */
export function downloadFolder(path: string, folderName: string): void {
  const link = document.createElement('a');
  link.href = `/api/library/download?path=${encodeURIComponent(path)}`;
  link.download = `${folderName}.zip`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
```

**Step 2: Commit**

```bash
git add frontend/app/components/FileCard/utils.ts
git commit -m "feat: add downloadFolder utility function"
```

---

### Task 3: Frontend — Add Download to Tree View Context Menu

**Files:**
- Modify: `frontend/app/components/library/file-tree.tsx` (lines 2, 252, 444-458)

**Step 1: Add `Download` icon to import (line 2)**

Change:
```typescript
import { ChevronRight, ChevronDown, Folder, Pencil, Trash2, FolderPlus, Copy, Loader2, CircleAlert } from 'lucide-react';
```
To:
```typescript
import { ChevronRight, ChevronDown, Folder, Pencil, Trash2, FolderPlus, Copy, Loader2, CircleAlert, Download } from 'lucide-react';
```

**Step 2: Import download utilities**

Add after line 6 (`import { useLibraryNotifications } from ...`):

```typescript
import { downloadFile, downloadFolder } from '~/components/FileCard/utils';
```

**Step 3: Add handleDownload function**

Insert after `handleCopyPath` (after line 252):

```typescript
  const handleDownload = () => {
    const name = getNodeName(node);
    if (node.type === 'folder') {
      downloadFolder(fullPath, name);
    } else {
      downloadFile(fullPath, name);
    }
  };
```

**Step 4: Add Download menu item to context menu**

Change lines 444-458 from:
```tsx
        <ContextMenuContent>
          <ContextMenuItem onClick={startRename}>
            <Pencil className="w-4 h-4 mr-2" />
            Rename
          </ContextMenuItem>
          <ContextMenuItem onClick={handleCopyPath}>
            <Copy className="w-4 h-4 mr-2" />
            Copy Path
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => setShowDeleteDialog(true)} variant="destructive">
            <Trash2 className="w-4 h-4 mr-2" />
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
```
To:
```tsx
        <ContextMenuContent>
          <ContextMenuItem onClick={handleDownload}>
            <Download className="w-4 h-4 mr-2" />
            Download
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={startRename}>
            <Pencil className="w-4 h-4 mr-2" />
            Rename
          </ContextMenuItem>
          <ContextMenuItem onClick={handleCopyPath}>
            <Copy className="w-4 h-4 mr-2" />
            Copy Path
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => setShowDeleteDialog(true)} variant="destructive">
            <Trash2 className="w-4 h-4 mr-2" />
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
```

**Step 5: Commit**

```bash
git add frontend/app/components/library/file-tree.tsx
git commit -m "feat: add Download to tree view context menu"
```

---

### Task 4: Frontend — Add Download to Grid View Context Menu

**Files:**
- Modify: `frontend/app/components/library/grid-item.tsx` (lines 2, 129, 219-234)

**Step 1: Add `Download` icon to import (line 2)**

Change:
```typescript
import { FolderClosed, Pencil, Trash2, Copy, Loader2, CircleAlert } from 'lucide-react';
```
To:
```typescript
import { FolderClosed, Pencil, Trash2, Copy, Loader2, CircleAlert, Download } from 'lucide-react';
```

**Step 2: Import download utilities**

Add after line 4 (`import { api } from '~/lib/api';`):

```typescript
import { downloadFile, downloadFolder } from '~/components/FileCard/utils';
```

**Step 3: Add handleDownload function**

Insert after `handleCopyPath` (after line 129):

```typescript
  const handleDownload = () => {
    if (isFolder) {
      downloadFolder(fullPath, name);
    } else {
      downloadFile(fullPath, name);
    }
  };
```

**Step 4: Add Download menu item to context menu**

Change lines 220-234 from:
```tsx
        <ContextMenuContent>
          <ContextMenuItem onClick={startRename}>
            <Pencil className="w-4 h-4 mr-2" />
            Rename
          </ContextMenuItem>
          <ContextMenuItem onClick={handleCopyPath}>
            <Copy className="w-4 h-4 mr-2" />
            Copy Path
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => setShowDeleteDialog(true)} variant="destructive">
            <Trash2 className="w-4 h-4 mr-2" />
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
```
To:
```tsx
        <ContextMenuContent>
          <ContextMenuItem onClick={handleDownload}>
            <Download className="w-4 h-4 mr-2" />
            Download
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={startRename}>
            <Pencil className="w-4 h-4 mr-2" />
            Rename
          </ContextMenuItem>
          <ContextMenuItem onClick={handleCopyPath}>
            <Copy className="w-4 h-4 mr-2" />
            Copy Path
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => setShowDeleteDialog(true)} variant="destructive">
            <Trash2 className="w-4 h-4 mr-2" />
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
```

**Step 5: Commit**

```bash
git add frontend/app/components/library/grid-item.tsx
git commit -m "feat: add Download to grid view context menu"
```

---

### Task 5: Build Verification

**Step 1: Build backend**

Run: `cd backend && go build ./...`
Expected: Compiles successfully.

**Step 2: Build frontend**

Run: `cd frontend && npm run build`
Expected: Builds successfully with no TypeScript errors.

**Step 3: Manual smoke test**

1. Right-click a file in tree view → Download appears, downloads the file
2. Right-click a folder in tree view → Download appears, downloads a .zip
3. Right-click a file in grid view → same behavior
4. Right-click a folder in grid view → same behavior
