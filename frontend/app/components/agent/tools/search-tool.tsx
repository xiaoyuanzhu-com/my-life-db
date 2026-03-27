/**
 * SearchTool -- renderer for ACP ToolKind "search" (grep/glob file searches)
 *
 * - Header: MessageDot + "Search" (bold) + pattern/query (muted) + chevron
 * - Summary line with tree connector: "Found in N file(s)" or "No matches found"
 * - Expandable: click header to show full result content
 * - Error with tree connector in destructive color
 */
import { useState } from "react"
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

/** Extract tool names from ToolSearch result */
function extractToolNames(result: unknown): string[] | null {
  if (!Array.isArray(result)) return null
  const names = result
    .filter((r): r is Record<string, unknown> =>
      typeof r === "object" && r !== null && r.type === "tool_reference"
    )
    .map((r) => r.tool_name)
    .filter((n): n is string => typeof n === "string")
  return names.length > 0 ? names : null
}

/** Derive a short label from the tool name */
function getSearchLabel(toolName: string): string {
  const lower = toolName.toLowerCase()
  if (lower.startsWith("grep")) return "Grep"
  if (lower.startsWith("glob")) return "Glob"
  if (lower.startsWith("websearch")) return "WebSearch"
  if (lower.startsWith("toolsearch")) return "ToolSearch"
  return "Search"
}

/** Extract result content as string */
function extractResultContent(result: unknown): string | null {
  if (result == null) return null
  if (typeof result === "string") return result
  if (typeof result === "object" && result !== null) {
    const r = result as Record<string, unknown>
    if (typeof r.rawOutput === "string") return r.rawOutput
    if (typeof r.content === "string") return r.content
    if (typeof r.result === "string") return r.result
  }
  return null
}

export function SearchToolRenderer({
  toolName,
  args,
  result,
  status,
}: ToolCallMessagePartProps<SearchArgs, unknown>) {
  // If no result yet and status is "incomplete" (e.g. history replay), treat as still working
  const hasResult = result != null
  const effectiveStatus = (status.type === "incomplete" && !hasResult) ? "running" : status.type
  const isComplete = effectiveStatus === "complete"
  const isRunning = effectiveStatus === "running"
  const isError = effectiveStatus === "requires-action" || effectiveStatus === "incomplete"
  const [expanded, setExpanded] = useState(false)

  const label = getSearchLabel(toolName)
  const isToolSearch = label === "ToolSearch"

  // Extract search query from args or from toolName (e.g., "Grep pattern" or "Glob *.tsx")
  const searchQuery = args?.pattern || args?.query || (() => {
    const match = toolName.match(/^(?:Grep|Glob|WebSearch|ToolSearch|Search)\s+(.+)$/i)
    return match ? match[1].trim() : ""
  })()
  const fileCount = isToolSearch ? null : extractFileCount(result)
  const toolNames = isToolSearch ? extractToolNames(result) : null

  const resultContent = extractResultContent(result)
  const hasContent = !!resultContent

  // Determine dot type
  const dotType = isError
    ? "tool-failed" as const
    : toolStatusToDotType(effectiveStatus)

  // Build summary line
  const getSummaryLine = () => {
    if (isRunning) return isToolSearch ? "Looking up tools..." : "Searching..."
    if (isError) return "Error"
    if (isComplete) {
      if (isToolSearch) {
        if (toolNames) return `Found: ${toolNames.join(", ")}`
        return "Done"
      }
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
      {/* Header: dot + label bold + pattern + chevron */}
      <button
        onClick={() => hasContent && setExpanded(!expanded)}
        className={`flex items-start gap-2 w-full text-left ${hasContent ? "cursor-pointer hover:opacity-80" : "cursor-default"}`}
      >
        <MessageDot type={dotType} />
        <div className="flex-1 min-w-0">
          <span className="font-semibold text-foreground">
            {label}
          </span>
          {searchQuery && (
            <span className="ml-2 break-all text-muted-foreground">
              {searchQuery}
            </span>
          )}
          {hasContent && (
            <span className="ml-2 select-none text-[11px] text-muted-foreground/60">
              {expanded ? "\u25BE" : "\u25B8"}
            </span>
          )}
        </div>
      </button>

      {/* Summary: tree connector */}
      {summaryLine && (
        <div className="flex gap-2 ml-5">
          <span className={`select-none ${isError ? "text-destructive" : "text-muted-foreground"}`}>{"\u2514"}</span>
          <span className={isError ? "text-destructive" : fileCount === 0 ? "text-muted-foreground/60" : "text-muted-foreground"}>
            {summaryLine}
          </span>
        </div>
      )}

      {/* Expanded content - smooth CSS grid collapse */}
      <div className={`collapsible-grid ${expanded && hasContent ? "" : "collapsed"}`}>
        <div className="collapsible-grid-content">
          <div
            className="mt-2 ml-5 p-3 rounded-md overflow-y-auto whitespace-pre-wrap break-all bg-muted/50 text-muted-foreground"
            style={{ maxHeight: "60vh" }}
          >
            {resultContent}
          </div>
        </div>
      </div>
    </div>
  )
}
