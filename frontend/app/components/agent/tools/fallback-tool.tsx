/**
 * FallbackTool -- inline renderer for unrecognized ACP tools.
 *
 * Matches the same visual pattern as Read/Edit/Execute:
 * - Header: MessageDot + tool name (bold) + chevron
 * - Summary line with tree connector
 * - Collapsible args/result with smooth CSS grid animation
 */
import { useState } from "react"
import type { ToolCallMessagePartProps } from "@assistant-ui/react"
import { MessageDot, toolStatusToDotType, computeToolEffectiveStatus } from "../message-dot"

export function FallbackToolRenderer({
  toolName,
  argsText,
  result,
  status,
}: ToolCallMessagePartProps) {
  const hasResult = result != null
  const effectiveStatus = computeToolEffectiveStatus(status, hasResult)
  const isComplete = effectiveStatus === "complete"
  const isRunning = effectiveStatus === "running"
  const isError = effectiveStatus === "incomplete"
  const isCancelled = effectiveStatus === "cancelled"
  const [expanded, setExpanded] = useState(false)

  const dotType = toolStatusToDotType(effectiveStatus)

  const label = isCancelled ? "Cancelled tool" : "Used tool"

  // Format result for display
  const resultStr = result != null
    ? typeof result === "string"
      ? result
      : JSON.stringify(result, null, 2)
    : null

  const hasExpandableContent = !!argsText || !!resultStr

  // Summary line
  const getSummaryLine = () => {
    if (isRunning) return "Running..."
    if (isCancelled) return "Cancelled"
    if (isError) return "Error"
    if (isComplete) return "Completed"
    return null
  }

  const summaryLine = getSummaryLine()

  return (
    <div className={`font-mono text-[13px] leading-[1.5] ${isCancelled ? "opacity-60" : ""}`}>
      {/* Header: dot + label + tool name + chevron */}
      <button
        onClick={() => hasExpandableContent && setExpanded(!expanded)}
        className={`flex items-start gap-2 w-full text-left ${hasExpandableContent ? "cursor-pointer hover:opacity-80" : "cursor-default"}`}
      >
        <MessageDot type={dotType} />
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <span className={`text-muted-foreground ${isCancelled ? "line-through" : ""}`}>
            {label}:
          </span>
          <span className={`font-semibold text-foreground ${isCancelled ? "line-through" : ""}`}>
            {toolName}
          </span>
          {hasExpandableContent && (
            <span className="text-[11px] shrink-0 text-muted-foreground/60">
              {expanded ? "\u25BE" : "\u25B8"}
            </span>
          )}
        </div>
      </button>

      {/* Summary line: tree connector */}
      {summaryLine && (
        <div className="flex gap-2 ml-5">
          <span className={`select-none ${isError ? "text-destructive" : "text-muted-foreground"}`}>{"\u2514"}</span>
          <span className={`${isError ? "text-destructive" : "text-muted-foreground"}`}>{summaryLine}</span>
        </div>
      )}

      {/* Expanded content - smooth CSS grid collapse */}
      <div className={`collapsible-grid ${expanded && hasExpandableContent ? "" : "collapsed"}`}>
        <div className="collapsible-grid-content">
          <div
            className="mt-2 ml-5 p-3 rounded-md overflow-y-auto whitespace-pre-wrap break-all bg-muted/50 flex flex-col gap-2"
            style={{ maxHeight: "60vh" }}
          >
            {argsText && (
              <div className="text-muted-foreground">
                <pre className="whitespace-pre-wrap">{argsText}</pre>
              </div>
            )}
            {resultStr && (
              <div className={isError ? "text-destructive" : "text-muted-foreground"}>
                <span className="font-semibold">Result:</span>
                <pre className="whitespace-pre-wrap mt-1">{resultStr}</pre>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
