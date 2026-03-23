/**
 * SearchTool -- renderer for ACP ToolKind "search" (grep/glob file searches)
 *
 * Matches the old Claude Code grep-tool.tsx + glob-tool.tsx pattern:
 * - Header: MessageDot + "Search" (bold) + pattern/query (muted)
 * - Summary line with tree connector: "Found in N file(s)" or "No matches found"
 * - NOT expandable (matching old behavior)
 * - Error with tree connector in destructive color
 */
import type { ToolCallMessagePartProps } from "@assistant-ui/react"
import { MessageDot, toolStatusToDotType } from "../message-dot"

interface SearchArgs {
  kind?: string
  pattern?: string
  query?: string
  path?: string
  [key: string]: unknown
}

/** Extract file count from result */
function extractFileCount(result: unknown): number | null {
  if (result == null) return null

  if (typeof result === "string") {
    const lines = result.split("\n").filter((l) => l.trim().length > 0)
    return lines.length
  }

  if (typeof result === "object") {
    const r = result as Record<string, unknown>
    if (typeof r.count === "number") return r.count
    if (Array.isArray(r.files)) return r.files.length
    if (Array.isArray(r.matches)) return r.matches.length
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

  // Determine dot type
  const dotType = isError
    ? "tool-failed" as const
    : toolStatusToDotType(status.type)

  // Build summary line
  const getSummaryLine = () => {
    if (isRunning) return "Searching..."
    if (isError) return "Error"
    if (isComplete) {
      if (fileCount !== null && fileCount > 0) {
        return `Found in ${fileCount} file${fileCount !== 1 ? "s" : ""}`
      }
      if (fileCount === 0) return "No matches found"
      return "Done"
    }
    return null
  }

  const summaryLine = getSummaryLine()

  return (
    <div className="font-mono text-[13px] leading-[1.5]">
      {/* Header: dot + "Search" bold + pattern */}
      <div className="flex items-start gap-2">
        <MessageDot type={dotType} />
        <div className="flex-1 min-w-0">
          <span className="font-semibold text-foreground">
            Search
          </span>
          {searchQuery && (
            <span className="ml-2 break-all text-muted-foreground">
              {searchQuery}
            </span>
          )}
          {!searchQuery && (
            <span className="ml-2 text-muted-foreground">
              {toolName}
            </span>
          )}
        </div>
      </div>

      {/* Summary: tree connector */}
      {summaryLine && (
        <div className="flex gap-2 ml-5">
          <span className={`select-none ${isError ? "text-destructive" : "text-muted-foreground"}`}>{"\u2514"}</span>
          <span className={isError ? "text-destructive" : fileCount === 0 ? "text-muted-foreground/60" : "text-muted-foreground"}>
            {summaryLine}
          </span>
        </div>
      )}
    </div>
  )
}
