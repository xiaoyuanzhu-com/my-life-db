/**
 * ExecuteTool -- renderer for ACP ToolKind "execute" (shell commands)
 *
 * Matches the old Claude Code bash-tool.tsx pattern:
 * - Header: MessageDot + "Execute" (bold) + command text (muted, truncated) + chevron
 * - Summary line with tree connector
 * - Collapsible output with smooth CSS grid animation
 */
import { useState } from "react"
import type { ToolCallMessagePartProps } from "@assistant-ui/react"
import { MessageDot, toolStatusToDotType } from "../message-dot"

interface ExecuteArgs {
  kind?: string
  command?: string
  [key: string]: unknown
}

export function ExecuteToolRenderer({
  toolName,
  args,
  result,
  status,
}: ToolCallMessagePartProps<ExecuteArgs, unknown>) {
  const isComplete = status.type === "complete"
  const isRunning = status.type === "running"
  const isError = status.type === "requires-action" || (result !== undefined && (args as { isError?: boolean }).isError)
  const [expanded, setExpanded] = useState(false)

  // Extract command text from args or toolName
  const commandText = args?.command || toolName || "No command"

  // Parse output
  const outputStr = result != null
    ? typeof result === "string"
      ? result
      : JSON.stringify(result, null, 2)
    : null

  const hasOutput = !!outputStr

  // Determine dot type
  const dotType = isError
    ? "tool-failed" as const
    : toolStatusToDotType(status.type)

  // Build summary line
  const getSummaryLine = () => {
    if (isRunning && !outputStr) {
      return "Running..."
    }
    if (isError && outputStr) {
      const firstLine = outputStr.split("\n")[0].trim()
      return firstLine.length > 80 ? firstLine.slice(0, 80) + "..." : firstLine
    }
    if (outputStr) {
      const firstLine = outputStr.split("\n")[0].trim()
      return firstLine.length > 80 ? firstLine.slice(0, 80) + "..." : firstLine
    }
    if (isComplete) return "Completed"
    return null
  }

  const summaryLine = getSummaryLine()

  return (
    <div className="font-mono text-[13px] leading-[1.5]">
      {/* Header: dot + "Execute" bold + command text + chevron */}
      <button
        onClick={() => hasOutput && setExpanded(!expanded)}
        className={`flex items-start gap-2 w-full text-left ${hasOutput ? "cursor-pointer hover:opacity-80" : "cursor-default"}`}
      >
        <MessageDot type={dotType} />
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <span className="font-semibold text-foreground">
            Execute
          </span>
          <span className="truncate text-muted-foreground">
            {commandText}
          </span>
          {hasOutput && (
            <span className="text-[11px] shrink-0 text-muted-foreground/60">
              {expanded ? "\u25BE" : "\u25B8"}
            </span>
          )}
        </div>
      </button>

      {/* Summary line: tree connector */}
      {summaryLine && (
        <div
          className="flex gap-2 ml-5"
          style={{ color: isError ? undefined : undefined }}
        >
          <span className={`select-none ${isError ? "text-destructive" : "text-muted-foreground"}`}>{"\u2514"}</span>
          <span className={`truncate ${isError ? "text-destructive" : "text-muted-foreground"}`}>{summaryLine}</span>
        </div>
      )}

      {/* Expanded output - smooth CSS grid collapse */}
      <div className={`collapsible-grid ${expanded && hasOutput ? "" : "collapsed"}`}>
        <div className="collapsible-grid-content">
          <div
            className="mt-2 ml-5 p-3 rounded-md overflow-y-auto whitespace-pre-wrap break-all bg-muted/50"
            style={{ maxHeight: "60vh" }}
          >
            <span className={isError ? "text-destructive" : "text-muted-foreground"}>
              {outputStr}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
