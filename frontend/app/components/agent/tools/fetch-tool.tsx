/**
 * FetchTool -- renderer for ACP ToolKind "fetch" (HTTP fetches)
 *
 * Matches the old Claude Code web-fetch-tool.tsx pattern:
 * - Header: MessageDot + "Fetch" (bold) + URL (muted, truncated) + chevron
 * - Summary line with tree connector: "HTTP {status} ({size}, {duration})"
 * - Expandable with markdown content, smooth CSS grid animation
 * - Chevron only when expandable (has content)
 */
import { useState } from "react"
import type { ToolCallMessagePartProps } from "@assistant-ui/react"
import { MessageDot, toolStatusToDotType } from "../message-dot"
import { MarkdownContent } from "../markdown-content"

interface FetchArgs {
  kind?: string
  url?: string
  [key: string]: unknown
}

/** Format bytes to human-readable */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/** Extract HTTP status and size from result */
function extractFetchInfo(result: unknown): { status?: number; statusText?: string; size?: string; duration?: string } {
  if (result == null) return {}

  if (typeof result === "object" && result !== null) {
    const r = result as Record<string, unknown>
    const info: { status?: number; statusText?: string; size?: string; duration?: string } = {}
    if (typeof r.status === "number") info.status = r.status
    if (typeof r.statusCode === "number") info.status = r.statusCode
    if (typeof r.code === "number") info.status = r.code
    if (typeof r.codeText === "string") info.statusText = r.codeText
    if (typeof r.size === "number") info.size = formatSize(r.size)
    else if (typeof r.contentLength === "number") info.size = formatSize(r.contentLength)
    else if (typeof r.bytes === "number") info.size = formatSize(r.bytes)
    if (typeof r.durationMs === "number") {
      info.duration = r.durationMs < 1000
        ? `${Math.round(r.durationMs)}ms`
        : `${(r.durationMs / 1000).toFixed(1)}s`
    }
    return info
  }

  if (typeof result === "string") {
    return { size: formatSize(result.length) }
  }

  return {}
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
  const [expanded, setExpanded] = useState(false)

  const url = args?.url || ""
  const fetchInfo = extractFetchInfo(result)

  // Determine dot type
  const dotType = isError
    ? "tool-failed" as const
    : toolStatusToDotType(status.type)

  // Result content as string for rendering
  const resultContent = result != null
    ? typeof result === "string"
      ? result
      : typeof result === "object" && result !== null && typeof (result as Record<string, unknown>).content === "string"
        ? (result as Record<string, unknown>).content as string
        : typeof result === "object" && result !== null && typeof (result as Record<string, unknown>).body === "string"
          ? (result as Record<string, unknown>).body as string
          : typeof result === "object" && result !== null && typeof (result as Record<string, unknown>).result === "string"
            ? (result as Record<string, unknown>).result as string
            : null
    : null

  const hasContent = !!resultContent

  // Build summary line
  const getSummaryLine = () => {
    if (isRunning) return "Fetching..."
    if (isError) return "Error"
    if (isComplete) {
      const parts: string[] = []
      if (fetchInfo.status) {
        parts.push(`${fetchInfo.status}${fetchInfo.statusText ? ` ${fetchInfo.statusText}` : ""}`)
      }
      const meta: string[] = []
      if (fetchInfo.size) meta.push(fetchInfo.size)
      if (fetchInfo.duration) meta.push(fetchInfo.duration)
      if (meta.length > 0) parts.push(`(${meta.join(", ")})`)
      return parts.length > 0 ? parts.join(" ") : "Done"
    }
    return null
  }

  const summaryLine = getSummaryLine()

  return (
    <div className="font-mono text-[13px] leading-[1.5]">
      {/* Header: dot + "Fetch" bold + URL + chevron */}
      <button
        onClick={() => hasContent && setExpanded(!expanded)}
        className={`flex items-start gap-2 w-full text-left ${hasContent ? "cursor-pointer hover:opacity-80" : "cursor-default"}`}
      >
        <MessageDot type={dotType} />
        <div className="flex-1 min-w-0">
          <span className="font-semibold text-foreground">
            Fetch
          </span>
          <span className="ml-2 break-all text-muted-foreground">
            {url || toolName}
          </span>
          {hasContent && (
            <span className="ml-2 select-none text-[11px] text-muted-foreground/60">
              {expanded ? "\u25BE" : "\u25B8"}
            </span>
          )}
        </div>
      </button>

      {/* Summary line: tree connector */}
      {summaryLine && (
        <div className="flex gap-2 ml-5">
          <span className={`select-none ${isError ? "text-destructive" : "text-muted-foreground"}`}>{"\u2514"}</span>
          <span className={isError ? "text-destructive" : "text-muted-foreground"}>{summaryLine}</span>
        </div>
      )}

      {/* Expanded content - smooth CSS grid collapse */}
      <div className={`collapsible-grid ${expanded && hasContent ? "" : "collapsed"}`}>
        <div className="collapsible-grid-content">
          <div
            className="mt-2 ml-5 p-4 rounded-md overflow-y-auto bg-muted/50"
            style={{ maxHeight: "60vh" }}
          >
            <MarkdownContent text={resultContent || ""} className="text-foreground text-xs" />
          </div>
        </div>
      </div>

      {/* Error */}
      {isError && !summaryLine && (
        <div className="flex gap-2 ml-5 text-destructive">
          <span className="select-none">{"\u2514"}</span>
          <span>Error</span>
        </div>
      )}
    </div>
  )
}
