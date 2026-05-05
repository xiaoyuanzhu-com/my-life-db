# Clickable File Paths in Session Detail

**Date:** 2026-03-03
**Status:** Approved

## Problem

Claude session detail pages reference files constantly — in tool calls (Read/Write/Edit), assistant text, and bash output. When these files live in the user's library, there's no way to click through to view them. Users must manually navigate to the library page and find the file.

## Goal

Detect file path references in session messages. If a path resolves to a file or directory inside the user's data library, render it as a clickable link that navigates to the library page with that file/directory focused.

## Design Principle

**Unified path resolver, multi-layer integration.** One shared utility handles detection and resolution. Each content source (tool blocks, markdown, bash) feeds paths through the same resolver. No existence verification — prefix matching against the library root is sufficient.

## Architecture

```
Session Message Content
  ├─ Tool block → extract file_path from params ─┐
  ├─ Markdown text → regex scan for paths ────────┤
  └─ Bash output → regex scan for paths ──────────┤
                                                   ▼
                                          Path Resolver (shared)
                                           ├─ Absolute? Check prefix
                                           ├─ Relative? Join cwd, check
                                           └─ Directory? Use ?dir=
                                                   ▼
                                         ┌─ Match? → Clickable link
                                         └─ No match? → Plain text
```

## Components

### 1. Backend: `GET /api/library/root`

New endpoint in `backend/api/files.go`. Returns the absolute library root path.

```json
{ "root": "/home/xiaoyuanzhu/my-life-db/data" }
```

Implementation: one handler, returns `config.Get().UserDataDir`.

### 2. Frontend: `lib/file-path-resolver.ts`

Unified path detection and resolution module.

**Exports:**

- `initLibraryRoot()` — Fetches root from API, caches it. Called once on app startup.
- `resolvePath(raw: string, cwd?: string) → ResolvedPath` — Resolves a single known path string.
- `extractAndResolvePaths(text: string, cwd?: string) → ResolvedPath[]` — Regex scans text for path-like strings, resolves each.

**Types:**

```typescript
interface ResolvedPath {
  original: string            // The raw string found
  absolute: string            // Fully resolved absolute path
  libraryRelative: string | null  // Path relative to library root, or null if not a library file
  isDirectory: boolean        // true if path ends with / or has no extension
}
```

**Resolution logic:**

1. If absolute path → check `startsWith(libraryRoot)` → strip prefix for `libraryRelative`
2. If relative path → join with `cwd` → then same prefix check
3. If ends with `/` or has no file extension → mark `isDirectory: true`
4. No match → `libraryRelative = null`

**Path detection regex:**

Matches:
- `/home/user/data/life/retro/2026/file.pdf` (absolute, ≥2 segments)
- `life/retro/2026/` (relative directory)
- `life/retro/2026/file.pdf` (relative file)
- `./src/components/App.tsx` (dot-relative)
- `../config/settings.json` (dot-dot-relative)

Skips:
- URLs (`http://`, `https://`, `ftp://`)
- Markdown link syntax `[text](url)`
- Single-segment bare filenames (`file.pdf` — too many false positives)

### 3. Frontend: `FileRef` component update

Existing component at `components/claude/chat/file-ref.tsx`.

**New prop:**

```typescript
interface FileRefProps {
  path: string
  libraryPath?: string | null  // Relative path to link to, or null/undefined for no link
  isDirectory?: boolean        // Controls ?dir= vs ?open= navigation
  showIcon?: boolean
  className?: string
}
```

**Behavior:**
- When `libraryPath` is set → renders as React Router `<Link to="/library?open=...">` (or `?dir=...` for directories)
- Visual: subtle underline on hover, pointer cursor, slightly different text color
- When `libraryPath` is null/undefined → current behavior (plain span, `cursor-default`)

### 4. Tool block integration

Components affected: `read-tool.tsx`, `write-tool.tsx`, `edit-tool.tsx`, `glob-tool.tsx`, `grep-tool.tsx`.

Each already displays `params.file_path`. Change:

```typescript
const resolved = resolvePath(params.file_path)
<FileRef
  path={params.file_path}
  libraryPath={resolved.libraryRelative}
  isDirectory={resolved.isDirectory}
/>
```

### 5. Library page: directory navigation support

Currently supports `?open=path` for files. Add `?dir=path` support:

- Reads `dir` query param in the existing `useEffect`
- Calls `expandParentFolders(dirPath)` to expand the tree
- Scrolls to and highlights the target folder node
- Does NOT open a file tab

### 6. Markdown text linking

Post-process rendered HTML in `MessageContent`:

1. After markdown renders to HTML string, scan for path matches using `extractAndResolvePaths()`
2. Replace matched text spans with `<a data-library-path="relative/path" class="library-file-link">original text</a>`
3. Event delegation on the message container: clicks on `.library-file-link` → `navigate()` to library

Uses `data-*` attributes + event delegation because marked.js outputs raw HTML strings (no React components inside `dangerouslySetInnerHTML`).

### 7. Bash tool output linking

Same approach as markdown text: scan command text and stdout output with `extractAndResolvePaths()`, replace matches with clickable `<a>` elements.

## Visual Treatment

- **Library paths**: subtle blue/accent text color + underline on hover, pointer cursor
- **Non-library paths**: unchanged (plain monospace)
- **Directories**: same link style as files, distinct only in navigation target (`?dir=` vs `?open=`)

## Edge Cases

- **File deleted since session**: No verification — clicking navigates to library, file simply doesn't open. Acceptable.
- **Path in code block**: Regex should still detect paths inside `<code>` elements. Links work inside code spans.
- **Ambiguous relative paths**: Resolved against session's `workingDir`. If it doesn't match library root after resolution, left as plain text.
- **Multiple sessions with different cwd**: Each message can carry its own `cwd`; resolver uses per-message context.

## What This Does NOT Do

- Link bare filenames without directory separators (e.g., `file.pdf`) — too many false positives
- Verify file existence before linking — prefix match is sufficient
- Open files in a side panel — always navigates to library page
