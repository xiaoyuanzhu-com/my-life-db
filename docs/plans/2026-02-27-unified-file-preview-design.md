# Unified File Preview System

## Problem

Preview generation is fragmented:
- Text files get a `text_preview` (sync, core `fs` layer)
- PDFs/docs get a `screenshot_sqlar` (async, digest pipeline)
- Images have no stored preview (frontend fetches raw files)
- Videos have no preview at all

This makes cross-platform rendering inconsistent and couples preview generation to the optional digest system.

## Design

Previews become a **core feature of the `fs` package**, independent of digesters. Every file gets exactly one preview type — text or image — determined by file type.

### Preview mapping

| File type | Preview kind | Storage | Timing |
|-----------|-------------|---------|--------|
| Text/code/markdown | First ~60 lines | `text_preview` TEXT column | Sync on ingest |
| Images (JPEG, PNG, WebP, GIF, HEIC) | Thumbnail (~400px wide JPEG) | `preview_sqlar` → SQLAR | Async via preview worker |
| PDFs, Office docs | First-page screenshot | `preview_sqlar` → SQLAR | Async via preview worker |
| Videos (MP4, MOV, etc.) | Frame at ~1s | `preview_sqlar` → SQLAR | Async via preview worker |
| Audio | None | — | — |

### Architecture

```
WriteFile()
  ├─ Compute hash (sync)
  ├─ Extract text preview if text file (sync)  ← already exists
  ├─ UpsertFile to DB
  └─ notifyFileChange()
       ├─ Preview worker (NEW, in fs layer)
       │   └─ If image/doc/video → generate thumbnail → SQLAR → update preview_sqlar
       └─ Digest worker (existing, unchanged)
           └─ OCR, captioning, tags, etc.
```

Key: preview worker is owned by `fs.Service`, not the digest system. Digesters can be disabled without affecting previews.

### New component: `fs/preview.go`

Owns all image preview generation:

- **Images**: decode (stdlib for JPEG/PNG/WebP/GIF, `gen2brain/heic` for HEIC) → resize to max 400px wide → encode as JPEG 80% quality
- **Documents**: call existing `haid.GenerateDocScreenshot(filePath)` → PNG
- **Videos**: `ffmpeg -ss 1 -i <file> -frames:v 1 -f image2pipe -` → resize → JPEG

All outputs stored in SQLAR at `{path_hash}/preview/thumbnail.jpg` (or `screenshot.png` for docs).

### Preview worker

A goroutine inside `fs.Service` with a buffered channel (capacity ~100).

Triggered by `notifyFileChange()` — same event that triggers digest workers. The `fs.Service` checks the file's MIME type: if it needs an image preview, queue it.

On failure: the hourly scanner catches files missing expected previews (null `preview_sqlar` for image/doc/video MIME types).

### Schema migration

```sql
ALTER TABLE files RENAME COLUMN screenshot_sqlar TO preview_sqlar;
```

### API changes

Rename `FileRecord.ScreenshotSqlar` → `FileRecord.PreviewSqlar` (Go struct + JSON tag `preview_sqlar`).

Serving unchanged: `/sqlar/{path}` endpoint serves preview images.

Preview-ready notifications use the existing SSE system.

### Frontend changes

- Rename `screenshotSqlar` → `previewSqlar` in TypeScript types
- File card dispatcher: `previewSqlar` → render image preview, `textPreview` → render text preview
- `ImageCard`: use `previewSqlar` thumbnail in list/grid views, `/raw/{path}` for full resolution
- `PDFCard`: update field reference from `screenshotSqlar` to `previewSqlar`

### Cross-platform

All platforms consume the same API:
- Image preview → `GET /sqlar/{previewSqlar}` returns JPEG/PNG
- Text preview → render `textPreview` string

No platform-specific preview generation needed.

### Digesters removed

- `DocToScreenshotDigester` → replaced by preview worker
- `ImagePreviewDigester` → replaced by preview worker (covers all images, not just HEIC)

All other digesters (OCR, captioning, tags, search keywords, speech recognition) remain unchanged.

### Preview regeneration triggers

- New file ingested
- File content changes (hash differs on re-ingest)
- File moved/renamed → re-link SQLAR path (path_hash changes)

## Decisions

- **One preview per file**: text OR image, never both. Client handles both types.
- **Thumbnails, not full-res**: ~400px wide JPEG for fast loading and small SQLAR footprint.
- **SQLAR storage**: consistent with existing infrastructure, served via `/sqlar/` endpoint.
- **Sync for text only**: text preview is fast (read 60 lines). All image previews are async.
- **Preview is core**: lives in `fs` package, not digest pipeline. Works even with digesters disabled.
