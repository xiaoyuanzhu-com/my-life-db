# Archive Upload & Extract — Design

## Problem

Uploading many files (e.g., a folder with hundreds of photos or documents) is slow because each file is uploaded individually. Users often already have archives (zip, tar.gz, etc.) and want to upload them directly, with the server extracting contents into the library.

## Solution

Detect archive files during the existing upload finalization step. When an archive is detected, extract its contents into the destination folder instead of saving the archive file itself. Each extracted file goes through `fs.WriteFile()` for metadata computation, DB registration, and digest processing.

## Supported Formats

| Format | Extensions | Go support |
|--------|-----------|------------|
| ZIP | `.zip` | `mholt/archives` |
| TAR | `.tar` | `mholt/archives` |
| TAR+GZIP | `.tar.gz`, `.tgz` | `mholt/archives` |
| TAR+BZIP2 | `.tar.bz2`, `.tbz2` | `mholt/archives` |
| TAR+XZ | `.tar.xz`, `.txz` | `mholt/archives` |
| TAR+ZSTD | `.tar.zst` | `mholt/archives` |
| 7-Zip | `.7z` | `mholt/archives` |
| RAR | `.rar` | `mholt/archives` |

All formats handled by a single library: [`mholt/archives`](https://github.com/mholt/archives).

## Extraction Behavior

- Contents extracted as-is into the destination folder (same as `unzip` / `tar -xf` on Linux)
- Directory structure inside the archive is preserved
- Each extracted file processed through `fs.WriteFile()` (metadata, DB record, digest)
- Archive file itself is deleted after successful extraction

## Backend Changes

### New file: `backend/api/archive.go`

```go
// isArchiveFile checks if a filename has a supported archive extension.
func isArchiveFile(filename string) bool

// extractArchive extracts an archive into destDir, processing each file
// through fs.WriteFile(). Returns list of created relative paths.
func (h *Handlers) extractArchive(ctx context.Context, archivePath, destRelDir string) ([]string, error)
```

### Modified: `FinalizeUpload` (upload.go)

After moving the TUS upload to its final location, check `isArchiveFile(filename)`:
- If archive: call `extractArchive()`, return all created paths, delete the archive
- If not archive: existing behavior unchanged

### Modified: `SimpleUpload` (upload.go)

Same check after writing the file:
- If archive: extract, return paths, delete
- If not: existing behavior

### Security

- **Zip-slip prevention**: reject entries with `..` in path or absolute paths
- **Junk filtering**: skip `__MACOSX/`, `.DS_Store`, `Thumbs.db`
- **No nested extraction**: archives inside archives are kept as regular files
- **No password support**: fail with clear error if archive is encrypted

### New dependency

```
github.com/mholt/archives
```

## Frontend Changes

**None.** The existing upload buttons, TUS queue, and progress UI work unchanged. A zip file is just another file upload — the server handles extraction transparently.

## Response Format

Same structure as today. The `paths` array contains all extracted file paths instead of just the archive path:

```json
{
  "success": true,
  "path": "notes/project/readme.md",
  "paths": ["notes/project/readme.md", "notes/project/src/main.go", ...],
  "results": [
    {"path": "notes/project/readme.md", "status": "created"},
    {"path": "notes/project/src/main.go", "status": "created"}
  ]
}
```

## Out of Scope

- Per-file extraction progress reporting (just upload progress)
- "Upload as archive without extracting" toggle
- Nested archive extraction (archive-in-archive stays as file)
- Password-protected archive support
- Deduplication of extracted files (can add later using existing hash-based dedup)
