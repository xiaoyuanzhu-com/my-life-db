/**
 * ReadTool — renderer for ACP ToolKind "read" (file reads)
 *
 * Shows the file path from title and file content from result in a collapsible
 * code block. Collapsed by default when complete.
 */
import { useState } from "react"
import { ChevronRight, FileText } from "lucide-react"
import type { ToolCallMessagePartProps } from "@assistant-ui/react"
import { cn } from "~/lib/utils"
import { MessageDot, toolStatusToDotType } from "../message-dot"

interface ReadArgs {
  kind?: string
  [key: string]: unknown
}

export function ReadToolRenderer({
  toolName,
  result,
  status,
}: ToolCallMessagePartProps<ReadArgs, unknown>) {
  const isComplete = status.type === "complete"
  const isRunning = status.type === "running"
  const isError = status.type === "requires-action"

  // Default: collapsed when complete, expanded when running/pending
  const [open, setOpen] = useState(!isComplete)

  const outputStr = result != null
    ? typeof result === "string"
      ? result
      : JSON.stringify(result, null, 2)
    : null

  // Count lines for summary
  const lineCount = outputStr ? outputStr.split('\n').length : 0
  const summaryText = isError
    ? "Error"
    : isComplete
      ? `${lineCount} line${lineCount !== 1 ? 's' : ''}`
      : isRunning
        ? "Reading..."
        : "Pending"

  return (
    <div className="my-1 rounded-md border border-border bg-muted/30 text-sm">
      {/* Header */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50 transition-colors rounded-md"
      >
        <MessageDot type={isError ? "tool-failed" : toolStatusToDotType(status.type)} />
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate font-mono text-xs text-foreground">
          {toolName}
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
        <span className="text-muted-foreground/60">{'\u2514'}</span>
        <span className={isError ? "text-destructive" : ""}>{summaryText}</span>
      </div>

      {/* File content */}
      {open && outputStr != null && (
        <div className="border-t border-border px-3 py-2">
          <pre className={cn(
            "overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed max-h-96",
            isError ? "text-destructive" : "text-foreground"
          )}>
            {outputStr}
          </pre>
        </div>
      )}

      {open && isRunning && outputStr == null && (
        <div className="border-t border-border px-3 py-2">
          <span className="font-mono text-[11px] text-muted-foreground animate-pulse">
            ...
          </span>
        </div>
      )}
    </div>
  )
}
