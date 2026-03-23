/**
 * GenericTool -- fallback renderer for unknown ACP tool kinds.
 *
 * Matches the old Claude Code tool-block.tsx GenericToolView pattern:
 * - Header: MessageDot + tool name (title-cased, bold) + kind badge (muted)
 * - Summary line with tree connector
 * - Expandable if has params or result
 * - Expanded: JSON sections for Parameters, Result
 * - Error shown inline with tree connector
 */
import { useState } from "react"
import type { ToolCallMessagePartProps } from "@assistant-ui/react"
import { MessageDot, toolStatusToDotType } from "../message-dot"

interface GenericArgs {
  kind?: string
  [key: string]: unknown
}

/** Title-case a string */
function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Derive a human-readable kind label */
function inferKind(toolName: string, args: GenericArgs): string {
  if (args.kind && typeof args.kind === "string") return args.kind
  const lower = toolName.toLowerCase()
  for (const k of ["search", "fetch", "think", "delete", "move", "read", "edit", "execute"]) {
    if (lower.startsWith(k)) return k
  }
  return "tool"
}

export function GenericToolRenderer({
  toolName,
  args,
  result,
  status,
}: ToolCallMessagePartProps<GenericArgs, unknown>) {
  const isComplete = status.type === "complete"
  const isRunning = status.type === "running"
  const isError = status.type === "requires-action"
  const kind = inferKind(toolName, args)

  const [expanded, setExpanded] = useState(false)

  const hasArgs = args && Object.keys(args).filter((k) => k !== "kind").length > 0
  const inputStr = hasArgs ? JSON.stringify(args, null, 2) : null
  const outputStr = result != null
    ? typeof result === "string"
      ? result
      : JSON.stringify(result, null, 2)
    : null

  const hasExpandableContent = !!(inputStr || outputStr)

  // Determine dot type
  const dotType = isError
    ? "tool-failed" as const
    : toolStatusToDotType(status.type)

  // Build summary line
  const getSummaryLine = () => {
    if (isRunning) return "Running..."
    if (isError) return "Error"
    if (isComplete) return "Done"
    return null
  }

  const summaryLine = getSummaryLine()

  return (
    <div className="font-mono text-[13px] leading-[1.5]">
      {/* Header: dot + tool name (title-cased) bold + kind badge + chevron */}
      <button
        onClick={() => hasExpandableContent && setExpanded(!expanded)}
        className={`flex items-start gap-2 w-full text-left ${hasExpandableContent ? "cursor-pointer hover:opacity-80" : "cursor-default"}`}
      >
        <MessageDot type={dotType} />
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <span className="font-semibold text-foreground">
            {titleCase(toolName)}
          </span>
          <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide bg-muted text-muted-foreground">
            {kind}
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
          <span className={isError ? "text-destructive" : "text-muted-foreground"}>{summaryLine}</span>
        </div>
      )}

      {/* Expanded: Parameters + Result sections */}
      <div className={`collapsible-grid ${expanded && hasExpandableContent ? "" : "collapsed"}`}>
        <div className="collapsible-grid-content">
          <div className="mt-2 ml-5 space-y-2">
            {/* Parameters */}
            {inputStr && (
              <div>
                <div className="text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wide mb-1">
                  Parameters
                </div>
                <pre className="p-3 rounded-md bg-muted/50 overflow-x-auto whitespace-pre-wrap break-all text-[12px] leading-relaxed text-muted-foreground" style={{ maxHeight: "30vh" }}>
                  {inputStr}
                </pre>
              </div>
            )}

            {/* Result */}
            {outputStr && (
              <div>
                <div className="text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wide mb-1">
                  Result
                </div>
                <pre className={`p-3 rounded-md bg-muted/50 overflow-x-auto overflow-y-auto whitespace-pre-wrap break-all text-[12px] leading-relaxed ${isError ? "text-destructive" : "text-muted-foreground"}`} style={{ maxHeight: "30vh" }}>
                  {outputStr}
                </pre>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
