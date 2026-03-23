/**
 * SearchTool — renderer for ACP ToolKind "search" (grep/glob file searches)
 *
 * Shows the search pattern/query and a summary of found files.
 * NOT expandable — matches old Grep/Glob behavior.
 */
import { Search } from "lucide-react"
import type { ToolCallMessagePartProps } from "@assistant-ui/react"
import { MessageDot, toolStatusToDotType } from "../message-dot"

interface SearchArgs {
  kind?: string
  pattern?: string
  query?: string
  path?: string
  [key: string]: unknown
}

/** Extract file count from rawOutput */
function extractFileCount(result: unknown): number | null {
  if (result == null) return null

  // If result is a string, count non-empty lines (each line is a file match)
  if (typeof result === "string") {
    const lines = result.split("\n").filter((l) => l.trim().length > 0)
    return lines.length
  }

  // If result is an object with a count or files array
  if (typeof result === "object") {
    const r = result as Record<string, unknown>
    if (typeof r.count === "number") return r.count
    if (Array.isArray(r.files)) return r.files.length
    if (Array.isArray(r.matches)) return r.matches.length
    // Try to parse rawOutput string
    if (typeof r.rawOutput === "string") {
      return r.rawOutput.split("\n").filter((l: string) => l.trim().length > 0).length
    }
  }

  return null
}

export function SearchToolRenderer({
  toolName,
  args,
  result,
  status,
}: ToolCallMessagePartProps<SearchArgs, unknown>) {
  const isComplete = status.type === "complete"
  const isRunning = status.type === "running"
  const isError = status.type === "requires-action"

  const searchQuery = args?.pattern || args?.query || ""
  const fileCount = extractFileCount(result)

  const summaryText = isError
    ? "Error"
    : isComplete
      ? fileCount !== null
        ? `Found in ${fileCount} file${fileCount !== 1 ? "s" : ""}`
        : "Done"
      : isRunning
        ? "Searching..."
        : "Pending"

  return (
    <div className="my-1 rounded-md border border-border bg-muted/30 text-sm">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2">
        <MessageDot type={isError ? "tool-failed" : toolStatusToDotType(status.type)} />
        <Search className="h-3.5 w-3.5 shrink-0 text-blue-500" />
        <span className="font-medium text-xs text-foreground">Search</span>
        {searchQuery && (
          <span className="flex-1 truncate font-mono text-xs text-muted-foreground">
            {searchQuery}
          </span>
        )}
        {!searchQuery && (
          <span className="flex-1 truncate font-mono text-xs text-foreground">
            {toolName}
          </span>
        )}
      </div>

      {/* Summary line */}
      <div className="flex items-center gap-1 px-3 pb-1.5 text-[11px] text-muted-foreground">
        <span className="text-muted-foreground/60">{"\u2514"}</span>
        <span className={isError ? "text-destructive" : ""}>{summaryText}</span>
      </div>
    </div>
  )
}
