/**
 * ReadTool -- renderer for ACP ToolKind "read" (file reads)
 *
 * - Header: MessageDot + "Read" (bold) + file path (muted) + chevron
 * - Summary line with tree connector showing line count
 * - Expandable: click header to show file content
 * - Error with tree connector in destructive color
 */
import { useState } from "react"
import type { ToolCallMessagePartProps } from "@assistant-ui/react"
import { MessageDot, toolStatusToDotType } from "../message-dot"

interface ReadArgs {
  kind?: string
  file_path?: string
  [key: string]: unknown
}

export function ReadToolRenderer({
  toolName,
  args,
  result,
  status,
}: ToolCallMessagePartProps<ReadArgs, unknown>) {
  const isComplete = status.type === "complete"
  const isRunning = status.type === "running"
  const isError = status.type === "requires-action" || status.type === "incomplete"
  const [expanded, setExpanded] = useState(false)

  // Extract file path -- show filename only in header, full path on hover
  // The ACP title is e.g., "Read /src/main.go", so extract the path from it
  const filePath = args?.file_path || (() => {
    const match = toolName.match(/^Read\s+(.+)$/i)
    return match ? match[1].trim() : toolName
  })() || ""
  const fileName = filePath.split("/").pop() || filePath

  // Count lines from result
  const outputStr = result != null
    ? typeof result === "string"
      ? result
      : JSON.stringify(result, null, 2)
    : null
  const lineCount = outputStr ? outputStr.split("\n").length : 0
  const hasContent = !!outputStr

  // Determine dot type
  const dotType = isError
    ? "tool-failed" as const
    : toolStatusToDotType(status.type)

  return (
    <div className="font-mono text-[13px] leading-[1.5]">
      {/* Header: dot + "Read" bold + file path + chevron */}
      <button
        onClick={() => hasContent && setExpanded(!expanded)}
        className={`flex items-start gap-2 w-full text-left ${hasContent ? "cursor-pointer hover:opacity-80" : "cursor-default"}`}
      >
        <MessageDot type={dotType} />
        <div className="flex-1 min-w-0">
          <span className="font-semibold text-foreground">
            Read
          </span>
          <span className="ml-2 text-muted-foreground truncate" title={filePath}>
            {fileName}
          </span>
          {hasContent && (
            <span className="ml-2 select-none text-[11px] text-muted-foreground/60">
              {expanded ? "\u25BE" : "\u25B8"}
            </span>
          )}
        </div>
      </button>

      {/* Summary: line count */}
      {isComplete && lineCount > 0 && (
        <div className="flex gap-2 ml-5 text-muted-foreground">
          <span className="select-none">{"\u2514"}</span>
          <span>Read {lineCount} line{lineCount !== 1 ? "s" : ""}</span>
        </div>
      )}

      {/* Running state */}
      {isRunning && (
        <div className="flex gap-2 ml-5 text-muted-foreground">
          <span className="select-none">{"\u2514"}</span>
          <span>Reading...</span>
        </div>
      )}

      {/* Error */}
      {isError && (
        <div className="flex gap-2 ml-5 text-destructive">
          <span className="select-none">{"\u2514"}</span>
          <span>Error</span>
        </div>
      )}

      {/* Expanded content - smooth CSS grid collapse */}
      <div className={`collapsible-grid ${expanded && hasContent ? "" : "collapsed"}`}>
        <div className="collapsible-grid-content">
          <div
            className="mt-2 ml-5 p-3 rounded-md overflow-y-auto whitespace-pre-wrap break-all bg-muted/50 text-muted-foreground"
            style={{ maxHeight: "60vh" }}
          >
            {outputStr}
          </div>
        </div>
      </div>
    </div>
  )
}
