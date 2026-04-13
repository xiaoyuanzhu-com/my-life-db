import { useState, useEffect } from "react"
import { FileText } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover"
import { fetchWithRefresh } from "~/lib/fetch-with-refresh"
import { cn } from "~/lib/utils"

interface ChangedFile {
  path: string
  status: "added" | "modified" | "deleted" | "renamed" | "untracked"
}

interface ChangedFilesResponse {
  source: "git" | "tools"
  files: ChangedFile[]
}

const STATUS_CONFIG: Record<string, { letter: string; className: string }> = {
  added: { letter: "A", className: "text-green-500" },
  modified: { letter: "M", className: "text-yellow-500" },
  deleted: { letter: "D", className: "text-red-500" },
  renamed: { letter: "R", className: "text-blue-500" },
  untracked: { letter: "?", className: "text-muted-foreground" },
}

interface ChangedFilesPopoverProps {
  sessionId: string
  refreshKey?: number
}

export function ChangedFilesPopover({ sessionId, refreshKey }: ChangedFilesPopoverProps) {
  const [data, setData] = useState<ChangedFilesResponse | null>(null)

  useEffect(() => {
    if (!sessionId) return

    let cancelled = false

    async function fetchFiles() {
      try {
        const res = await fetchWithRefresh(`/api/agent/sessions/${sessionId}/changed-files`)
        if (cancelled) return
        if (!res.ok) {
          setData(null)
          return
        }
        const json = await res.json()
        setData(json)
      } catch {
        if (!cancelled) setData(null)
      }
    }

    fetchFiles()

    return () => {
      cancelled = true
    }
  }, [sessionId, refreshKey])

  if (!data || !data.files || data.files.length === 0) return null

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground",
            "hover:bg-muted hover:text-foreground transition-colors"
          )}
        >
          <FileText className="h-3.5 w-3.5" />
          <span>{data.files.length}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80 p-0">
        <div className="max-h-60 overflow-y-auto p-2">
          {data.files.map((file) => {
            const config = STATUS_CONFIG[file.status] ?? STATUS_CONFIG.untracked
            return (
              <div key={file.path} className="flex items-center gap-2 py-0.5 px-1">
                <span className={cn("w-3 text-xs font-semibold shrink-0", config.className)}>
                  {config.letter}
                </span>
                <span className="font-mono text-xs truncate">{file.path}</span>
              </div>
            )
          })}
        </div>
        <div className="border-t px-3 py-1.5 text-[10px] text-muted-foreground">
          from {data.source === "git" ? "git status" : "tool calls"}
        </div>
      </PopoverContent>
    </Popover>
  )
}
