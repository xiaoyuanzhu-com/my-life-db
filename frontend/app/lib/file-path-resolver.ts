/**
 * Unified file path resolver for detecting and resolving paths
 * from Claude session messages to library-relative paths.
 */
import { api } from '~/lib/api'

let libraryRoot: string | null = null
let sessionCwd: string | null = null

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

/** Set the session working directory for resolving relative paths. */
export function setSessionCwd(cwd: string | null) {
  sessionCwd = cwd
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
    absolute = normalizePath(cwd + '/' + trimmed)
  } else {
    // Relative with no cwd — can't determine if it's in the library
    return { original: raw, absolute: trimmed, libraryRelative: null, isDirectory: false }
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
const PATH_REGEX = /(?<![a-zA-Z]:\/\/|[a-zA-Z]:|["'`([])\b(?:(?:\.{0,2}\/)?(?:[a-zA-Z0-9_@.][a-zA-Z0-9_@.-]*\/)+(?:[a-zA-Z0-9_@.-]+(?:\.[a-zA-Z0-9]+)?)?|\/(?:[a-zA-Z0-9_@.-]+\/)+(?:[a-zA-Z0-9_@.-]+(?:\.[a-zA-Z0-9]+)?)?)/g

/**
 * Scan a block of text for path-like strings and resolve each one.
 * Returns only paths that resolve to library files/dirs.
 */
export function extractAndResolvePaths(text: string, cwd?: string): ResolvedPath[] {
  if (!libraryRoot) return []

  const results: ResolvedPath[] = []

  // Reset regex state
  PATH_REGEX.lastIndex = 0

  let match: RegExpExecArray | null
  while ((match = PATH_REGEX.exec(text)) !== null) {
    const raw = match[0]

    // Skip if match is inside a URL — look back to the last whitespace to catch
    // URLs where the match starts far from the "://" (e.g. matching a suffix of
    // "https://github.com/user/repo/pull/new/feature/branch-name")
    const wordStart = text.lastIndexOf(' ', match.index - 1)
    const preceding = text.slice(Math.max(0, wordStart + 1), match.index)
    if (/\w:\/\//.test(preceding)) continue

    // Skip very short matches
    if (raw.length < 4) continue

    // For relative paths, only link if the last segment has a file extension.
    // This avoids false positives like "text/layout", "origin/feature/branch",
    // "wider/shorter", etc. Absolute paths (starting with /) are always checked.
    if (!raw.startsWith('/') && !hasFileExtension(raw)) continue

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

/**
 * Post-process an HTML string to wrap detected library paths in clickable links.
 * Used for markdown-rendered content and bash output.
 *
 * Two passes:
 * 1. Fix markdown-generated <a href="relative-path"> — resolve against session cwd,
 *    convert to library links if in library, otherwise strip href to prevent wrong navigation.
 * 2. Scan text content between tags for file-path-like strings and linkify matches.
 */
export function linkifyLibraryPaths(html: string, cwd?: string): string {
  if (!libraryRoot) return html

  const effectiveCwd = cwd ?? sessionCwd ?? undefined

  // First pass: fix markdown-generated <a href="relative-path">text</a>.
  // Marked creates links like <a href="docs/plans/file.md"> which the browser resolves
  // relative to the current page URL (wrong). Resolve against session cwd instead.
  let processed = html.replace(
    /<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g,
    (_match, href: string, content: string) => {
      // Skip URLs, anchors, mailto, etc.
      if (/^(?:https?:|ftp:|mailto:|#|data:)/.test(href)) return _match
      // Skip if already a library-file-link
      if (_match.includes('library-file-link')) return _match

      // Try resolving against session cwd first, then library root as fallback.
      // Markdown links are intentional file references — worth checking both.
      const resolved = resolvePath(href, effectiveCwd)
      if (resolved.libraryRelative !== null) {
        return `<a href="${libraryUrl(resolved)}" class="library-file-link">${content}</a>`
      }
      if (libraryRoot) {
        const resolvedFromLib = resolvePath(href, libraryRoot)
        if (resolvedFromLib.libraryRelative !== null) {
          return `<a href="${libraryUrl(resolvedFromLib)}" class="library-file-link">${content}</a>`
        }
      }
      // Not a library path — unwrap the <a> entirely to avoid styled dead links
      return content
    }
  )

  // Second pass: linkify paths detected in text content between HTML tags.
  // Use alternation to skip <a>...</a> content — text inside existing links
  // must not be re-linkified (e.g. URL text like "https://github.com/.../feature/x").
  processed = processed.replace(/(<a\s[^>]*>[\s\S]*?<\/a>)|(>)([^<]+)(<)/g, (_full, anchorTag: string, open: string, textContent: string, close: string) => {
    // If this matched an <a>...</a> block, leave it untouched
    if (anchorTag) return _full
    if (!textContent.trim()) return _full

    const paths = extractAndResolvePaths(textContent, effectiveCwd)
    if (paths.length === 0) return _full

    let result = textContent
    // Process in reverse order of appearance to preserve string indices
    const sortedPaths = [...paths].sort((a, b) => {
      const idxA = textContent.indexOf(a.original)
      const idxB = textContent.indexOf(b.original)
      return idxB - idxA
    })

    for (const resolved of sortedPaths) {
      const idx = result.indexOf(resolved.original)
      if (idx === -1) continue
      const link = `<a href="${libraryUrl(resolved)}" class="library-file-link">${resolved.original}</a>`
      result = result.slice(0, idx) + link + result.slice(idx + resolved.original.length)
    }

    return open + result + close
  })

  return processed
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
