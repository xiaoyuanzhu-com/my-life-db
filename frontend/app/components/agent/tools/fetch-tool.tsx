/**
 * FetchTool — renderer for ACP ToolKind "fetch" (HTTP fetches)
 *
 * Shows the URL being fetched, HTTP status and size summary.
 * Expandable: result content rendered as markdown.
 * Collapsed by default when complete.
 */
import { useState } from "react"
import { ChevronRight, Globe } from "lucide-react"
import type { ToolCallMessagePartProps } from "@assistant-ui/react"
import { cn } from "~/lib/utils"
import { MessageDot, toolStatusToDotType } from "../message-dot"
import { MarkdownContent } from "../markdown-content"

interface FetchArgs {
  kind?: string
  url?: string
  [key: string]: unknown
}

/** Extract HTTP status and size from result */
function extractFetchInfo(result: unknown): { status?: number; size?: string } {
  if (result == null) return {}

  if (typeof result === "object" && result !== null) {
    const r = result as Record<string, unknown>
    const info: { status?: number; size?: string } = {}
    if (typeof r.status === "number") info.status = r.status
    if (typeof r.statusCode === "number") info.status = r.statusCode
    if (typeof r.size === "number") {
      info.size = formatSize(r.size)
    } else if (typeof r.contentLength === "number") {
      info.size = formatSize(r.contentLength)
    }
    return info
  }

  // String result — estimate size
  if (typeof result === "string") {
    return { size: formatSize(result.length) }
  }

  return {}
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function FetchToolRenderer({
  toolName,
  args,
  result,
  status,
}: ToolCallMessagePartProps<FetchArgs, unknown>) {
  const isComplete = status.type === "complete"
  const isRunning = status.type === "running"
  const isError = status.type === "requires-action"

  // Default: collapsed when complete, expanded when running/pending
  const [open, setOpen] = useState(!isComplete)

  const url = args?.url || ""
  const fetchInfo = extractFetchInfo(result)

  // Build summary
  let summaryText: string
  if (isError) {
    summaryText = "Error"
  } else if (isComplete) {
    const parts: string[] = []
    if (fetchInfo.status) parts.push(`HTTP ${fetchInfo.status}`)
    if (fetchInfo.size) parts.push(`(${fetchInfo.size})`)
    summaryText = parts.length > 0 ? parts.join(" ") : "Done"
  } else if (isRunning) {
    summaryText = "Fetching..."
  } else {
    summaryText = "Pending"
  }

  // Result content as string for markdown rendering
  const resultContent = result != null
    ? typeof result === "string"
      ? result
      : typeof result === "object" && result !== null && typeof (result as Record<string, unknown>).content === "string"
        ? (result as Record<string, unknown>).content as string
        : typeof result === "object" && result !== null && typeof (result as Record<string, unknown>).body === "string"
          ? (result as Record<string, unknown>).body as string
          : JSON.stringify(result, null, 2)
    : null

  return (
    <div className="my-1 rounded-md border border-border bg-muted/30 text-sm">
      {/* Header — clickable to collapse/expand */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50 transition-colors rounded-md"
      >
        <MessageDot type={isError ? "tool-failed" : toolStatusToDotType(status.type)} />
        <Globe className="h-3.5 w-3.5 shrink-0 text-violet-500" />
        <span className="font-medium text-xs text-foreground">Fetch</span>
        <span className="flex-1 truncate font-mono text-xs text-muted-foreground">
          {url || toolName}
        </span>
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90"
          )}
        />
      </button>

      {/* Summary line */}
      <div className="flex items-center gap-1 px-3 pb-1.5 text-[11px] text-muted-foreground">
        <span className="text-muted-foreground/60">{"\u2514"}</span>
        <span className={isError ? "text-destructive" : ""}>{summaryText}</span>
      </div>

      {/* Result content as markdown */}
      {open && resultContent != null && (
        <div className="border-t border-border px-3 py-2 max-h-96 overflow-y-auto">
          <MarkdownContent text={resultContent} className="text-foreground text-xs" />
        </div>
      )}

      {/* Running indicator when no output yet */}
      {open && isRunning && resultContent == null && (
        <div className="border-t border-border px-3 py-2">
          <span className="font-mono text-[11px] text-muted-foreground animate-pulse">
            ...
          </span>
        </div>
      )}
    </div>
  )
}
