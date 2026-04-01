/**
 * FileTagPopover — triggered when user types "@" at the start of a token
 * in the composer. Fetches file tree from /api/library/tree and shows
 * fuzzy-matched results for quick file path insertion.
 *
 * Performance: fetches up to 1000 files initially. If the directory has more,
 * switches to server-side search with debounced queries as the user types.
 */
import { useState, useEffect, useCallback, useRef, useMemo } from "react"
import { useComposerRuntime, useComposer } from "@assistant-ui/react"
import { File, Folder } from "lucide-react"
import { cn } from "~/lib/utils"
import { api } from "~/lib/api"

// ── Types ──────────────────────────────────────────────────────────────────

interface FileItem {
  path: string
  type: "file" | "folder"
}

interface FileNode {
  path: string
  type: "file" | "folder"
  children?: FileNode[]
}

interface FileTagPopoverProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  workingDir?: string
}

const FILE_LIMIT = 1000
const DEBOUNCE_MS = 200

// ── Helpers ────────────────────────────────────────────────────────────────

function flattenTree(nodes: FileNode[], prefix = ""): FileItem[] {
  const result: FileItem[] = []
  for (const node of nodes) {
    const fullPath = prefix ? `${prefix}/${node.path}` : node.path
    result.push({ path: fullPath, type: node.type })
    if (node.children) {
      result.push(...flattenTree(node.children, fullPath))
    }
  }
  return result
}

/**
 * Fuzzy match: checks if all characters in pattern appear in order in str.
 * Returns a score (higher is better match) or -1 if no match.
 */
function fuzzyMatch(pattern: string, str: string): number {
  const lowerPattern = pattern.toLowerCase()
  const lowerStr = str.toLowerCase()

  let patternIdx = 0
  let score = 0
  let lastMatchIdx = -1

  for (let i = 0; i < lowerStr.length && patternIdx < lowerPattern.length; i++) {
    if (lowerStr[i] === lowerPattern[patternIdx]) {
      if (lastMatchIdx === i - 1) {
        score += 2
      } else {
        score += 1
      }
      if (i === 0 || lowerStr[i - 1] === "/" || lowerStr[i - 1] === ".") {
        score += 3
      }
      lastMatchIdx = i
      patternIdx++
    }
  }

  if (patternIdx < lowerPattern.length) return -1

  if (lowerStr.includes(lowerPattern)) score += 10

  const lastSlash = lowerStr.lastIndexOf("/")
  const filename = lastSlash >= 0 ? lowerStr.slice(lastSlash + 1) : lowerStr
  if (filename.includes(lowerPattern)) score += 15

  score -= str.length * 0.1
  return score
}

function filterFiles(files: FileItem[], query: string): FileItem[] {
  if (!query) return files.slice(0, 50)

  return files
    .map((file) => ({ file, score: fuzzyMatch(query, file.path) }))
    .filter(({ score }) => score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 50)
    .map(({ file }) => file)
}

// ── Component ──────────────────────────────────────────────────────────────

export function FileTagPopover({ textareaRef, workingDir }: FileTagPopoverProps) {
  const composerRuntime = useComposerRuntime()
  const text = useComposer((s) => s.text)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [allFiles, setAllFiles] = useState<FileItem[]>([])
  const [serverFiles, setServerFiles] = useState<FileItem[] | null>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [loading, setLoading] = useState(false)
  const [fetched, setFetched] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)
  const fetchedDirRef = useRef<string | undefined>(undefined)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const abortRef = useRef<AbortController>(undefined)

  // Detect @ trigger
  useEffect(() => {
    const match = text.match(/@(\S*)$/)
    if (match) {
      setOpen(true)
      setQuery(match[1] ?? "")
      setSelectedIndex(0)
    } else {
      setOpen(false)
      setQuery("")
    }
  }, [text])

  // Fetch file tree when popover opens (with limit)
  useEffect(() => {
    if (!open) return
    if (fetched && fetchedDirRef.current === workingDir) return

    const fetchFiles = async () => {
      setLoading(true)
      try {
        const params = new URLSearchParams({
          depth: "0",
          limit: String(FILE_LIMIT),
          fields: "path,type",
        })
        if (workingDir) params.set("path", workingDir)
        const response = await api.get(`/api/library/tree?${params}`)
        if (response.ok) {
          const data = await response.json()
          const flattened = flattenTree(data.children ?? [])
          setAllFiles(flattened)
          setTruncated(data.truncated === true)
          setFetched(true)
          fetchedDirRef.current = workingDir
        }
      } catch {
        // Ignore errors
      } finally {
        setLoading(false)
      }
    }

    fetchFiles()
  }, [open, fetched, workingDir])

  // Re-fetch when workingDir changes
  useEffect(() => {
    if (fetchedDirRef.current !== workingDir) {
      setFetched(false)
      setTruncated(false)
      setServerFiles(null)
    }
  }, [workingDir])

  // Server-side search when truncated and user has typed a query
  useEffect(() => {
    if (!truncated || !open) {
      setServerFiles(null)
      return
    }

    // No query — show the initial batch
    if (!query) {
      setServerFiles(null)
      return
    }

    // Debounce server requests
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      try {
        const params = new URLSearchParams({
          depth: "0",
          limit: "50",
          query,
        })
        if (workingDir) params.set("path", workingDir)
        const response = await api.get(`/api/library/tree?${params}`, {
          signal: controller.signal,
        })
        if (response.ok) {
          const data = await response.json()
          // Server-side search returns flat "files" array
          setServerFiles(data.files ?? [])
          setSelectedIndex(0)
        }
      } catch {
        // Ignore abort errors
      }
    }, DEBOUNCE_MS)

    return () => {
      clearTimeout(debounceRef.current)
      abortRef.current?.abort()
    }
  }, [truncated, open, query, workingDir])

  // When truncated and we have server results, use those; otherwise client-side filter
  const filtered = useMemo(() => {
    if (truncated && query && serverFiles !== null) {
      return serverFiles.slice(0, 50)
    }
    return filterFiles(allFiles, query)
  }, [allFiles, query, truncated, serverFiles])

  const handleSelect = useCallback(
    (filePath: string) => {
      const newText = text.replace(/@\S*$/, "@" + filePath + " ")
      composerRuntime.setText(newText)
      setOpen(false)
      textareaRef.current?.focus()
    },
    [text, composerRuntime, textareaRef]
  )

  // Scroll focused item into view
  useEffect(() => {
    if (!open || filtered.length === 0) return
    const list = popoverRef.current
    if (!list) return
    const focusedItem = list.children[selectedIndex] as HTMLElement | undefined
    focusedItem?.scrollIntoView({ block: "nearest" })
  }, [open, selectedIndex, filtered.length])

  // Keyboard navigation
  useEffect(() => {
    if (!open) return
    const textarea = textareaRef.current
    if (!textarea) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!open) return

      if (e.key === "ArrowDown") {
        e.preventDefault()
        setSelectedIndex((prev) =>
          filtered.length > 0 ? (prev + 1) % filtered.length : 0
        )
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        setSelectedIndex((prev) =>
          filtered.length > 0 ? (prev - 1 + filtered.length) % filtered.length : 0
        )
      } else if (e.key === "Tab" || e.key === "Enter") {
        if (filtered.length > 0) {
          e.preventDefault()
          e.stopPropagation()
          handleSelect(filtered[selectedIndex]?.path ?? "")
        }
      } else if (e.key === "Escape") {
        setOpen(false)
      }
    }

    textarea.addEventListener("keydown", handleKeyDown, { capture: true })
    return () => textarea.removeEventListener("keydown", handleKeyDown, { capture: true })
  }, [open, filtered, selectedIndex, handleSelect, textareaRef])

  if (!open) return null

  return (
    <div
      className="absolute bottom-full left-0 mb-1 w-full max-h-80 overflow-y-auto rounded-lg border border-border bg-popover shadow-md z-10"
    >
      {loading ? (
        <div className="px-3 py-6 text-sm text-muted-foreground text-center">
          Loading files...
        </div>
      ) : filtered.length === 0 ? (
        <div className="px-3 py-6 text-sm text-muted-foreground text-center">
          {truncated && query ? "Searching..." : "No matching files"}
        </div>
      ) : (
        <div ref={popoverRef} className="py-1">
          {filtered.map((file, i) => {
            const parts = file.path.split("/")
            const filename = parts[parts.length - 1] || file.path
            const parentDir = parts.length > 1 ? parts.slice(0, -1).join("/") : ""

            return (
              <button
                key={file.path}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault()
                  handleSelect(file.path)
                }}
                className={cn(
                  "w-full px-3 py-2 text-left transition-colors",
                  "hover:bg-accent",
                  i === selectedIndex && "bg-accent"
                )}
              >
                <div className="flex items-center gap-2 min-w-0">
                  {file.type === "folder" ? (
                    <Folder className="h-4 w-4 text-muted-foreground shrink-0" />
                  ) : (
                    <File className="h-4 w-4 text-muted-foreground shrink-0" />
                  )}
                  <span className="text-sm text-foreground truncate shrink-0 max-w-[50%]">
                    {filename}
                  </span>
                  {parentDir && (
                    <span
                      className="text-sm text-muted-foreground truncate ml-auto"
                      style={{ direction: "rtl", textAlign: "right" }}
                    >
                      {parentDir}
                    </span>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
