/**
 * FetchTool -- renderer for ACP ToolKind "fetch" (HTTP fetches + web searches)
 *
 * Handles two sub-types based on args:
 * 1. WebSearch (args.query present, no url): "WebSearch" + query text
 * 2. WebFetch (args.url or URL in title): "Fetch" + URL
 *
 * - Header: MessageDot + label (bold) + query/URL (muted) + chevron
 * - Summary line with tree connector
 * - Expandable with markdown content, smooth CSS grid animation
 */
import { useState } from "react"
import type { ToolCallMessagePartProps } from "@assistant-ui/react"
import { MessageDot, toolStatusToDotType, computeToolEffectiveStatus } from "../message-dot"
import { MarkdownContent } from "../markdown-content"

interface FetchArgs {
  kind?: string
  url?: string
  query?: string
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

/** Strip surrounding quotes from a string (e.g. `"foo"` → `foo`) */
function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1)
  }
  return s
}

/** Extract URL from tool name or args */
function extractUrl(toolName: string, args: FetchArgs | undefined): string {
  if (args?.url) return args.url

  const match = toolName.match(/^(?:WebFetch|Fetch)\s+(.+)$/i)
  if (match) return match[1].trim()

  if (toolName.startsWith("http://") || toolName.startsWith("https://")) return toolName

  return ""
}

/** Detect if this is a web search (query-based) rather than a URL fetch */
function isWebSearch(args: FetchArgs | undefined, toolName: string): boolean {
  if (args?.query) return true
  const lower = toolName.toLowerCase()
  return lower.startsWith("websearch") || lower.includes("search")
}

/** Extract the display text (query or URL) */
function extractDisplayText(args: FetchArgs | undefined, toolName: string): string {
  // WebSearch: use query from args or title
  if (args?.query) return args.query

  // Fetch: use URL
  const url = extractUrl(toolName, args)
  if (url) return url

  // Fallback: use cleaned-up title
  return stripQuotes(toolName)
}

/** Result content as string for rendering */
function extractResultContent(result: unknown): string | null {
  if (result == null) return null
  if (typeof result === "string") return result
  if (typeof result === "object" && result !== null) {
    const r = result as Record<string, unknown>
    if (typeof r.content === "string") return r.content
    if (typeof r.body === "string") return r.body
    if (typeof r.result === "string") return r.result
  }
  return null
}

export function FetchToolRenderer({
  toolName,
  args,
  result,
  status,
}: ToolCallMessagePartProps<FetchArgs, unknown>) {
  const hasResult = result != null
  const effectiveStatus = computeToolEffectiveStatus(status, hasResult)
  const isComplete = effectiveStatus === "complete"
  const isRunning = effectiveStatus === "running"
  const isError = effectiveStatus === "incomplete"
  const [expanded, setExpanded] = useState(false)

  const isSearch = isWebSearch(args, toolName)
  const label = isSearch ? "WebSearch" : "Fetch"
  const displayText = extractDisplayText(args, toolName)
  const fetchInfo = extractFetchInfo(result)

  const dotType = toolStatusToDotType(effectiveStatus)

  const resultContent = extractResultContent(result)
  const hasContent = !!resultContent

  // Build summary line
  const getSummaryLine = () => {
    if (isRunning) return isSearch ? "Searching..." : "Fetching..."
    if (isError) return "Error"
    if (isComplete) {
      if (isSearch) return "Done"
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
      {/* Header: dot + label bold + query/URL + chevron */}
      <button
        onClick={() => hasContent && setExpanded(!expanded)}
        className={`flex items-start gap-2 w-full text-left ${hasContent ? "cursor-pointer hover:opacity-80" : "cursor-default"}`}
      >
        <MessageDot type={dotType} />
        <div className="flex-1 min-w-0">
          <span className="font-semibold text-foreground">
            {label}
          </span>
          {displayText && (
            <span className="ml-2 break-all text-muted-foreground">
              {displayText}
            </span>
          )}
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
