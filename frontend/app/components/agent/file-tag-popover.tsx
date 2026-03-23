/**
 * FileTagPopover — triggered when user types "@" at the start of a token
 * in the composer. Fetches file tree from /api/library/tree and shows
 * filtered results for quick file path insertion.
 *
 * Same approach as SlashCommandPopover but for "@" trigger.
 */
import { useState, useEffect, useCallback, useRef } from "react"
import { useComposerRuntime, useComposer } from "@assistant-ui/react"
import { cn } from "~/lib/utils"
import { api } from "~/lib/api"

interface FileEntry {
  path: string
  name: string
}

interface FileTagPopoverProps {
  /** Reference to the textarea element for keyboard event interception */
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
}

export function FileTagPopover({ textareaRef }: FileTagPopoverProps) {
  const composerRuntime = useComposerRuntime()
  const text = useComposer((s) => s.text)
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState("")
  const [files, setFiles] = useState<FileEntry[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)

  // Detect @ trigger: look for @ at start of input or after whitespace
  useEffect(() => {
    // Find the last token starting with @
    const match = text.match(/@(\S*)$/)
    if (match) {
      setOpen(true)
      setFilter(match[1]?.toLowerCase() ?? "")
      setSelectedIndex(0)
    } else {
      setOpen(false)
      setFilter("")
    }
  }, [text])

  // Fetch file tree when popover opens
  useEffect(() => {
    if (!open || loaded) return

    const fetchFiles = async () => {
      try {
        const params = new URLSearchParams({
          depth: "3",
          fields: "path",
        })
        const response = await api.get(`/api/library/tree?${params}`)
        if (response.ok) {
          const data = await response.json()
          const entries: FileEntry[] = []
          const basePath = data.basePath || ""

          function walkTree(node: { path?: string; children?: unknown[] }, parentPath: string) {
            const nodePath = node.path ? `${parentPath}/${node.path}` : parentPath
            if (node.path) {
              entries.push({
                path: nodePath,
                name: node.path,
              })
            }
            if (Array.isArray(node.children)) {
              for (const child of node.children) {
                walkTree(child as { path?: string; children?: unknown[] }, nodePath)
              }
            }
          }

          walkTree(data, basePath)
          setFiles(entries)
          setLoaded(true)
        }
      } catch {
        // Ignore errors
      }
    }

    fetchFiles()
  }, [open, loaded])

  const filtered = files.filter(
    (f) =>
      !filter ||
      f.name.toLowerCase().includes(filter) ||
      f.path.toLowerCase().includes(filter)
  ).slice(0, 20) // Limit to 20 results

  const handleSelect = useCallback(
    (filePath: string) => {
      // Replace the @token with the file path
      const newText = text.replace(/@\S*$/, filePath + " ")
      composerRuntime.setText(newText)
      setOpen(false)
      textareaRef.current?.focus()
    },
    [text, composerRuntime, textareaRef]
  )

  // Keyboard navigation
  useEffect(() => {
    if (!open) return

    const textarea = textareaRef.current
    if (!textarea) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!open || filtered.length === 0) return

      if (e.key === "ArrowDown") {
        e.preventDefault()
        setSelectedIndex((prev) => Math.min(prev + 1, filtered.length - 1))
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        setSelectedIndex((prev) => Math.max(prev - 1, 0))
      } else if (e.key === "Tab") {
        e.preventDefault()
        handleSelect(filtered[selectedIndex]?.path ?? "")
      } else if (e.key === "Escape") {
        setOpen(false)
      }
    }

    textarea.addEventListener("keydown", handleKeyDown)
    return () => textarea.removeEventListener("keydown", handleKeyDown)
  }, [open, filtered, selectedIndex, handleSelect, textareaRef])

  if (!open || filtered.length === 0) return null

  return (
    <div
      ref={popoverRef}
      className="absolute bottom-full left-0 mb-1 w-80 max-h-48 overflow-y-auto rounded-lg border border-border bg-popover shadow-md z-10"
    >
      {filtered.map((file, i) => (
        <button
          key={file.path}
          type="button"
          onMouseDown={(e) => {
            e.preventDefault()
            handleSelect(file.path)
          }}
          className={cn(
            "w-full px-3 py-2 text-left text-sm transition-colors",
            "hover:bg-accent",
            i === selectedIndex && "bg-accent"
          )}
        >
          <span className="font-mono text-xs text-foreground truncate block">
            {file.name}
          </span>
          <span className="text-[10px] text-muted-foreground truncate block">
            {file.path}
          </span>
        </button>
      ))}
    </div>
  )
}
