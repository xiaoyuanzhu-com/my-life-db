# Clickable File Paths Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make file paths in Claude session detail pages clickable — clicking navigates to the library page with the file/folder focused.

**Architecture:** Unified path resolver utility detects and resolves paths against the library root (fetched once from a new backend endpoint). Tool components pass structured `file_path` through the resolver; markdown/bash text is post-processed after HTML rendering to linkify detected paths. Event delegation handles clicks on links in rendered HTML.

**Tech Stack:** Go (backend endpoint), React + TypeScript (frontend), React Router 7, marked.js (markdown)

---

### Task 1: Backend — `GET /api/library/root` endpoint

**Files:**
- Modify: `backend/api/files.go` (after line 634, after `GetDirectories`)
- Modify: `backend/api/routes.go` (line 62, after library routes)

**Step 1: Write the handler**

In `backend/api/files.go`, add after the `GetDirectories` function (after line 634):

```go
// GetLibraryRoot handles GET /api/library/root
func (h *Handlers) GetLibraryRoot(c *gin.Context) {
	cfg := config.Get()
	c.JSON(http.StatusOK, gin.H{"root": cfg.UserDataDir})
}
```

**Step 2: Register the route**

In `backend/api/routes.go`, add after line 62 (after `api.GET("/library/download", ...)`):

```go
		api.GET("/library/root", h.GetLibraryRoot)
```

**Step 3: Verify**

Run: `cd backend && go build ./...`
Expected: Compiles cleanly.

**Step 4: Commit**

```bash
git add backend/api/files.go backend/api/routes.go
git commit -m "feat: add GET /api/library/root endpoint

Returns the absolute path of the user data directory so the frontend
can resolve file paths from Claude sessions to library-relative paths."
```

---

### Task 2: Frontend — Path resolver utility

**Files:**
- Create: `frontend/app/lib/file-path-resolver.ts`

**Step 1: Create the resolver module**

```typescript
/**
 * Unified file path resolver for detecting and resolving paths
 * from Claude session messages to library-relative paths.
 */
import { api } from '~/lib/api'

let libraryRoot: string | null = null

export interface ResolvedPath {
  /** The raw string found in the text */
  original: string
  /** Fully resolved absolute path */
  absolute: string
  /** Path relative to library root, or null if not a library file */
  libraryRelative: string | null
  /** true if path ends with / or has no file extension */
  isDirectory: boolean
}

/**
 * Fetch and cache the library root path. Call once on app startup.
 * Safe to call multiple times — subsequent calls return the cached value.
 */
export async function initLibraryRoot(): Promise<string | null> {
  if (libraryRoot !== null) return libraryRoot
  try {
    const res = await api.get('/api/library/root')
    if (!res.ok) return null
    const data = await res.json()
    libraryRoot = data.root
    return libraryRoot
  } catch {
    return null
  }
}

/** Get the cached library root (null if not yet initialized). */
export function getLibraryRoot(): string | null {
  return libraryRoot
}

/**
 * Resolve a single known path string against the library root.
 * Returns libraryRelative if the path lives inside the library, null otherwise.
 */
export function resolvePath(raw: string, cwd?: string): ResolvedPath {
  if (!libraryRoot) {
    return { original: raw, absolute: raw, libraryRelative: null, isDirectory: false }
  }

  const trimmed = raw.trim()
  let absolute: string

  if (trimmed.startsWith('/')) {
    // Absolute path
    absolute = trimmed
  } else if (cwd) {
    // Relative — resolve against cwd
    // Simple join: cwd + '/' + relative (normalize .. and . segments)
    absolute = normalizePath(cwd + '/' + trimmed)
  } else {
    // Relative with no cwd — try resolving against library root
    absolute = normalizePath(libraryRoot + '/' + trimmed)
  }

  const isDirectory = trimmed.endsWith('/') || !hasFileExtension(trimmed)

  // Check if it's inside the library
  const root = libraryRoot.endsWith('/') ? libraryRoot : libraryRoot + '/'
  if (absolute.startsWith(root) || absolute === libraryRoot) {
    const relative = absolute.slice(root.length)
    return { original: raw, absolute, libraryRelative: relative, isDirectory }
  }

  return { original: raw, absolute, libraryRelative: null, isDirectory }
}

/**
 * Regex to detect file-path-like strings in text.
 *
 * Matches:
 * - Absolute paths: /home/..., /Users/..., /data/... (≥2 segments)
 * - Relative with slashes: life/retro/2026/, ./src/foo.ts, ../config/bar.json
 *
 * Skips:
 * - URLs (http://, https://, ftp://)
 * - Single-segment bare filenames (file.pdf)
 * - Very short matches (< 3 chars)
 */
const PATH_REGEX = /(?<![a-zA-Z]:\/\/|[a-zA-Z]:|["'`([\]])(?:(?:\.{0,2}\/)?(?:[a-zA-Z0-9_@.][a-zA-Z0-9_@.\-]*\/)+(?:[a-zA-Z0-9_@.\-]+(?:\.[a-zA-Z0-9]+)?)?|\/(?:[a-zA-Z0-9_@.\-]+\/)+(?:[a-zA-Z0-9_@.\-]+(?:\.[a-zA-Z0-9]+)?)?)/g

/**
 * Scan a block of text for path-like strings and resolve each one.
 * Returns only paths that resolve to library files/dirs.
 */
export function extractAndResolvePaths(text: string, cwd?: string): ResolvedPath[] {
  if (!libraryRoot) return []

  const results: ResolvedPath[] = []
  let match: RegExpExecArray | null

  // Reset regex state
  PATH_REGEX.lastIndex = 0

  while ((match = PATH_REGEX.exec(text)) !== null) {
    const raw = match[0]

    // Skip if it looks like a URL
    const before = text.slice(Math.max(0, match.index - 10), match.index)
    if (/https?:\/\/\s*$/.test(before) || /ftp:\/\/\s*$/.test(before)) continue

    // Skip very short matches
    if (raw.length < 4) continue

    const resolved = resolvePath(raw, cwd)
    if (resolved.libraryRelative !== null) {
      results.push(resolved)
    }
  }

  return results
}

/**
 * Generate the navigation URL for a resolved library path.
 */
export function libraryUrl(resolved: ResolvedPath): string {
  if (resolved.libraryRelative === null) return '#'
  const param = resolved.isDirectory ? 'dir' : 'open'
  return `/library?${param}=${encodeURIComponent(resolved.libraryRelative)}`
}

// --- Internal helpers ---

function normalizePath(path: string): string {
  const parts = path.split('/')
  const normalized: string[] = []
  for (const part of parts) {
    if (part === '.' || part === '') continue
    if (part === '..') {
      normalized.pop()
    } else {
      normalized.push(part)
    }
  }
  return '/' + normalized.join('/')
}

function hasFileExtension(path: string): boolean {
  const lastSegment = path.split('/').pop() || ''
  return /\.[a-zA-Z0-9]{1,10}$/.test(lastSegment)
}
```

**Step 2: Commit**

```bash
git add frontend/app/lib/file-path-resolver.ts
git commit -m "feat: add unified file path resolver utility

Detects file paths in text, resolves them against the library root,
and determines if they are library files. Used by tool blocks and
markdown post-processing to create clickable file links."
```

---

### Task 3: Frontend — Initialize library root on app startup

**Files:**
- Modify: `frontend/app/root.tsx` (line 55, inside `Root` component)

**Step 1: Add initialization**

Add import at top of `root.tsx`:

```typescript
import { initLibraryRoot } from '~/lib/file-path-resolver'
```

Add a `useEffect` inside the `Root` component, after the existing `useDarkMode()` call (after line 55):

```typescript
  // Initialize library root for file path resolution
  useEffect(() => {
    initLibraryRoot()
  }, [])
```

**Step 2: Commit**

```bash
git add frontend/app/root.tsx
git commit -m "feat: initialize library root path on app startup

Fetches the library root from the API once so file path resolution
works throughout the app lifecycle."
```

---

### Task 4: Frontend — Make `FileRef` component clickable

**Files:**
- Modify: `frontend/app/components/claude/chat/file-ref.tsx`

**Step 1: Update the component**

Replace the `FileRefProps` interface and `FileRef` component (lines 1–29) with:

```typescript
import { FileText } from 'lucide-react'
import { Link } from 'react-router'

interface FileRefProps {
  path: string
  /** Library-relative path to link to. If set, renders as a clickable link. */
  libraryPath?: string | null
  /** Whether this is a directory (uses ?dir= instead of ?open=). */
  isDirectory?: boolean
  showIcon?: boolean
  className?: string
}

/**
 * FileRef renders a file path as a styled element.
 * Shows just the filename with the full path on hover.
 * When libraryPath is set, renders as a clickable link to the library page.
 */
export function FileRef({ path, libraryPath, isDirectory, showIcon = true, className = '' }: FileRefProps) {
  const filename = path.split('/').pop() || path

  const inner = (
    <>
      {showIcon && <FileText className="h-3 w-3 flex-shrink-0" />}
      <span className="truncate max-w-[200px]">{filename}</span>
    </>
  )

  if (libraryPath != null) {
    const param = isDirectory ? 'dir' : 'open'
    const to = `/library?${param}=${encodeURIComponent(libraryPath)}`

    return (
      <Link
        to={to}
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-mono text-[13px] cursor-pointer hover:underline ${className}`}
        style={{
          backgroundColor: 'var(--claude-bg-code-block)',
          color: 'var(--claude-accent, var(--claude-text-secondary))',
        }}
        title={path}
      >
        {inner}
      </Link>
    )
  }

  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-mono text-[13px] cursor-default ${className}`}
      style={{
        backgroundColor: 'var(--claude-bg-code-block)',
        color: 'var(--claude-text-secondary)',
      }}
      title={path}
    >
      {inner}
    </span>
  )
}
```

**Step 2: Commit**

```bash
git add frontend/app/components/claude/chat/file-ref.tsx
git commit -m "feat: make FileRef clickable when libraryPath is provided

Renders as a React Router Link when libraryPath is set, navigating
to the library page with the file opened. Otherwise renders as before."
```

---

### Task 5: Frontend — Update tool components to use resolver

**Files:**
- Modify: `frontend/app/components/claude/chat/tools/read-tool.tsx`
- Modify: `frontend/app/components/claude/chat/tools/write-tool.tsx`
- Modify: `frontend/app/components/claude/chat/tools/edit-tool.tsx`
- Modify: `frontend/app/components/claude/chat/tools/glob-tool.tsx`
- Modify: `frontend/app/components/claude/chat/tools/grep-tool.tsx`

**Step 1: Update read-tool.tsx**

Add imports at top:

```typescript
import { resolvePath } from '~/lib/file-path-resolver'
import { FileRef } from '../file-ref'
```

Replace the file path display (lines 37–38) — change from plain `<span>` to `<FileRef>`:

Replace:
```tsx
          <span className="ml-2 break-all" style={{ color: 'var(--claude-text-secondary)' }}>
            {params.file_path}
          </span>
```

With:
```tsx
          <span className="ml-2 break-all">
            <FileRef
              path={params.file_path}
              libraryPath={resolvePath(params.file_path).libraryRelative}
              isDirectory={resolvePath(params.file_path).isDirectory}
              showIcon={false}
            />
          </span>
```

Note: call `resolvePath` once and store the result in a const for efficiency. The actual code should be:

At the top of the component function, add:
```typescript
  const resolved = resolvePath(params.file_path)
```

Then use `resolved.libraryRelative` and `resolved.isDirectory`.

**Step 2: Update write-tool.tsx**

Same pattern. Add imports and resolver call. Replace lines 88–89:

Replace:
```tsx
          <span className="ml-2 break-all" style={{ color: 'var(--claude-text-secondary)' }}>
            {params.file_path}
          </span>
```

With `<FileRef>` using resolved path.

**Step 3: Update edit-tool.tsx**

Same pattern. Replace lines 38–43 (the file path span):

Replace:
```tsx
          <span className="ml-2 break-all" style={{ color: 'var(--claude-text-secondary)' }}>
            {params.file_path}
            {params.replace_all && (
              <span className="ml-2 opacity-70">(replace all)</span>
            )}
          </span>
```

With:
```tsx
          <span className="ml-2 break-all">
            <FileRef
              path={params.file_path}
              libraryPath={resolved.libraryRelative}
              isDirectory={resolved.isDirectory}
              showIcon={false}
            />
            {params.replace_all && (
              <span className="ml-2 opacity-70" style={{ color: 'var(--claude-text-secondary)' }}>(replace all)</span>
            )}
          </span>
```

**Step 4: Update glob-tool.tsx**

Add imports. For `params.path` (line 25), resolve and make clickable if it's a library directory:

Replace:
```tsx
            {params.path && <span className="opacity-70 ml-2">in {params.path}</span>}
```

With:
```tsx
            {params.path && (
              <span className="opacity-70 ml-2">
                in <FileRef path={params.path} libraryPath={resolvePath(params.path).libraryRelative} isDirectory={true} showIcon={false} />
              </span>
            )}
```

**Step 5: Update grep-tool.tsx**

Same as glob-tool — make `params.path` clickable when present. The path/glob fields at lines 26-27.

**Step 6: Verify**

Run: `cd frontend && npx tsc --noEmit`
Expected: No type errors.

**Step 7: Commit**

```bash
git add frontend/app/components/claude/chat/tools/read-tool.tsx \
       frontend/app/components/claude/chat/tools/write-tool.tsx \
       frontend/app/components/claude/chat/tools/edit-tool.tsx \
       frontend/app/components/claude/chat/tools/glob-tool.tsx \
       frontend/app/components/claude/chat/tools/grep-tool.tsx
git commit -m "feat: make file paths in tool blocks clickable

Read, Write, Edit, Glob, and Grep tool displays now use the path
resolver to detect library files and render them as clickable FileRef
components that navigate to the library page."
```

---

### Task 6: Frontend — Library page `?dir=` query param support

**Files:**
- Modify: `frontend/app/routes/library.tsx` (lines 120-140, the `?open=` useEffect)

**Step 1: Add `?dir=` handling**

Extend the existing `useEffect` that handles `?open=` (lines 120-140). Add handling for `dir` param alongside the existing `open` param:

Replace the entire useEffect (lines 120-140):

```typescript
  useEffect(() => {
    const openParams = searchParams.getAll("open");
    const dirParam = searchParams.get("dir");
    if (openParams.length === 0 && !dirParam) return;

    // Handle file opens
    openParams.forEach((filePath) => {
      if (!filePath) return;
      const fileName = filePath.split("/").pop() || filePath;

      setTabs((prev) => {
        const existingTabIndex = prev.findIndex((t) => t.path === filePath);
        if (existingTabIndex !== -1) {
          return prev.map((t, i) => ({ ...t, isActive: i === existingTabIndex }));
        }
        return [...prev.map((t) => ({ ...t, isActive: false })), { path: filePath, name: fileName, isDirty: false, isActive: true }];
      });

      expandParentFolders(filePath);
    });

    // Handle directory navigation — expand to folder without opening a file tab
    if (dirParam) {
      expandParentFolders(dirParam + '/placeholder');
      // Also expand the directory itself
      setExpandedFolders((prev) => {
        const next = new Set(prev);
        // Add the directory with ./ prefix to match the file tree's path format
        const normalizedDir = dirParam.startsWith('./') ? dirParam : './' + dirParam;
        next.add(normalizedDir);
        return next;
      });
    }

    navigate("/library", { replace: true });
  }, [searchParams, navigate]);
```

**Step 2: Verify**

Open the app, navigate to `/library?dir=life/retro/2026`.
Expected: The file tree expands to show the `life/retro/2026` folder.

**Step 3: Commit**

```bash
git add frontend/app/routes/library.tsx
git commit -m "feat: support ?dir= query param in library page

Navigating to /library?dir=path expands the file tree to that
directory without opening a file tab. Used by clickable file path
links in session detail pages."
```

---

### Task 7: Frontend — Linkify paths in assistant markdown text

**Files:**
- Modify: `frontend/app/components/claude/chat/message-block.tsx` (around lines 509-556, the event delegation useEffect)

**Step 1: Create a linkify HTML post-processor**

Add a new exported function in `frontend/app/lib/file-path-resolver.ts`:

```typescript
/**
 * Post-process an HTML string to wrap detected library paths in clickable links.
 * Used for markdown-rendered content and bash output where we get HTML strings.
 *
 * Adds <a data-library-path="..." data-is-dir="true|false" class="library-file-link">
 * around detected path text. Does NOT process content inside <a>, <code>, or <pre> tags
 * to avoid double-linking or breaking code blocks.
 */
export function linkifyLibraryPaths(html: string, cwd?: string): string {
  if (!libraryRoot) return html

  // Split HTML into tags and text segments to avoid modifying tag attributes
  // Simple approach: only replace in text nodes (outside of < >)
  return html.replace(/(>[^<]*<)/g, (segment) => {
    // segment is ">...text...<" — the text between tags
    const textContent = segment.slice(1, -1) // strip > and <
    if (!textContent.trim()) return segment

    const paths = extractAndResolvePaths(textContent, cwd)
    if (paths.length === 0) return segment

    let result = textContent
    // Process in reverse order to preserve string indices
    const sortedPaths = [...paths].sort((a, b) => {
      const idxA = textContent.indexOf(a.original)
      const idxB = textContent.indexOf(b.original)
      return idxB - idxA
    })

    for (const resolved of sortedPaths) {
      const idx = result.indexOf(resolved.original)
      if (idx === -1) continue
      const link = `<a data-library-path="${encodeURIComponent(resolved.libraryRelative!)}" data-is-dir="${resolved.isDirectory}" class="library-file-link">${resolved.original}</a>`
      result = result.slice(0, idx) + link + result.slice(idx + resolved.original.length)
    }

    return '>' + result + '<'
  })
}
```

**Step 2: Apply linkification in MessageContent**

In `message-block.tsx`, import the new function:

```typescript
import { linkifyLibraryPaths } from '~/lib/file-path-resolver'
```

In the `MessageContent` component, after `parseMarkdownSync` and `parseMarkdown` produce HTML, apply linkification. Modify the `syncHtml` computation (line 463) and the async parse (line 491):

For sync (line 463), change:
```typescript
const syncHtml = useMemo(() => parseMarkdownSync(content), [content])
```
to:
```typescript
const syncHtml = useMemo(() => linkifyLibraryPaths(parseMarkdownSync(content)), [content])
```

For async (line 491), change:
```typescript
parseMarkdown(contentForParse).then((parsed) => {
  if (!cancelled) setAsyncState({ content: contentForParse, html: parsed })
})
```
to:
```typescript
parseMarkdown(contentForParse).then((parsed) => {
  if (!cancelled) setAsyncState({ content: contentForParse, html: linkifyLibraryPaths(parsed) })
})
```

**Step 3: Add click handler via event delegation**

In the existing event delegation `useEffect` (around line 510), add a handler for `.library-file-link` clicks. This useEffect already handles clicks for preview expand buttons.

Add at the top of message-block.tsx:
```typescript
import { useNavigate } from 'react-router'
```

Pass `navigate` into MessageContent or use it via a ref. Since MessageContent is a memo'd component that uses `dangerouslySetInnerHTML`, the cleanest approach is adding the navigate handler in the existing event delegation.

In the `handleClick` function (line 532), add before the expand button check:

```typescript
      // Library file link click
      const libraryLink = (e.target as HTMLElement).closest('.library-file-link') as HTMLAnchorElement | null
      if (libraryLink) {
        e.preventDefault()
        e.stopPropagation()
        const libraryPath = decodeURIComponent(libraryLink.dataset.libraryPath || '')
        const isDir = libraryLink.dataset.isDir === 'true'
        if (libraryPath) {
          const param = isDir ? 'dir' : 'open'
          // Use window.location for navigation since we're in a memo'd component
          window.location.href = `/library?${param}=${encodeURIComponent(libraryPath)}`
        }
        return
      }
```

Note: Using `window.location.href` here since we're inside event delegation on a memo'd component and don't have direct access to React Router's `navigate`. If the project prefers client-side routing, we can lift a navigate ref from the parent. But `window.location.href` works and is simpler — the library page loads fresh with the query param.

**Step 4: Add CSS for library file links**

In `frontend/app/globals.css` (or wherever `.prose-claude` styles are defined), add:

```css
.library-file-link {
  color: var(--claude-accent, var(--claude-text-secondary));
  text-decoration: none;
  cursor: pointer;
  border-bottom: 1px dotted currentColor;
}
.library-file-link:hover {
  text-decoration: underline;
}
```

**Step 5: Verify**

Load a session with assistant messages containing paths like `life/retro/2026/`. The path text should appear with subtle underline styling and be clickable.

**Step 6: Commit**

```bash
git add frontend/app/lib/file-path-resolver.ts \
       frontend/app/components/claude/chat/message-block.tsx \
       frontend/app/globals.css
git commit -m "feat: linkify library paths in assistant markdown text

Post-processes rendered markdown HTML to detect path-like strings
that resolve to library files/directories. Wraps them in clickable
links with event delegation for navigation."
```

---

### Task 8: Frontend — Linkify paths in bash tool output

**Files:**
- Modify: `frontend/app/components/claude/chat/tools/bash-tool.tsx`

**Step 1: Apply linkification to bash output**

Import the resolver:

```typescript
import { linkifyLibraryPaths, extractAndResolvePaths, libraryUrl } from '~/lib/file-path-resolver'
```

The bash tool displays command text (line 79) and output/error text (line 114). The output is inside a `<div>` with `whitespace-pre-wrap`.

For the expanded output section (line 114), change from plain text to linkified HTML:

Replace:
```tsx
            {errorText || outputText}
```

With:
```tsx
            <span dangerouslySetInnerHTML={{
              __html: linkifyLibraryPaths(
                escapeHtmlSimple(errorText || outputText)
              )
            }} />
```

Add a simple HTML escape helper at the top of the file (or import from a shared utility):

```typescript
function escapeHtmlSimple(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
```

Also add a click handler to the output container. Wrap the expanded output `<div>` (line 106-115) with an `onClick`:

```typescript
            onClick={(e) => {
              const link = (e.target as HTMLElement).closest('.library-file-link') as HTMLAnchorElement | null
              if (link) {
                e.preventDefault()
                const libraryPath = decodeURIComponent(link.dataset.libraryPath || '')
                const isDir = link.dataset.isDir === 'true'
                if (libraryPath) {
                  const param = isDir ? 'dir' : 'open'
                  window.location.href = `/library?${param}=${encodeURIComponent(libraryPath)}`
                }
              }
            }}
```

**Step 2: Verify**

Load a session with bash commands that reference library files. Output should show clickable paths.

**Step 3: Commit**

```bash
git add frontend/app/components/claude/chat/tools/bash-tool.tsx
git commit -m "feat: linkify library paths in bash tool output

Bash command output text is scanned for library file paths and
rendered as clickable links."
```

---

### Task 9: Manual testing and polish

**Step 1: Full integration test**

Open the app and navigate to a Claude session that has:
1. Read/Write/Edit tool calls → file paths should be clickable blue links
2. Assistant text mentioning paths like `life/retro/2026/` → should be clickable
3. Bash output with file paths → should be clickable
4. Click each type → should navigate to library with file/folder focused

**Step 2: Edge case testing**

- Path that no longer exists → clicking navigates to library, nothing opens (acceptable)
- Absolute path outside library (e.g., `/usr/bin/env`) → should NOT be linked
- URLs in markdown (e.g., `https://example.com/path/to/file`) → should NOT be linked
- Paths inside code blocks → may or may not be linked, either is acceptable
- Session with no library paths → nothing changes, no errors

**Step 3: Fix any issues found during testing**

Address edge cases, regex false positives/negatives, or styling issues.

**Step 4: Final commit**

```bash
git add -A
git commit -m "fix: polish clickable file paths edge cases"
```
