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

  // Default: collapsed when complete, expanded when running/pending
  const [open, setOpen] = useState(!isComplete)

  const outputStr = result != null
    ? typeof result === "string"
      ? result
      : JSON.stringify(result, null, 2)
    : null

  return (
    <div className="my-1 rounded-md border border-border bg-muted/30 text-sm">
      {/* Header */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50 transition-colors rounded-md"
      >
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate font-mono text-xs text-foreground">
          {toolName}
        </span>
        {isRunning && (
          <span className="text-[10px] text-amber-500 animate-pulse">reading</span>
        )}
        {isComplete && (
          <span className="text-[10px] text-muted-foreground">done</span>
        )}
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90"
          )}
        />
      </button>

      {/* File content */}
      {open && outputStr != null && (
        <div className="border-t border-border px-3 py-2">
          <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed max-h-96 text-foreground">
            {outputStr}
          </pre>
        </div>
      )}

      {open && isRunning && outputStr == null && (
        <div className="border-t border-border px-3 py-2">
          <span className="font-mono text-[11px] text-muted-foreground animate-pulse">
            …
          </span>
        </div>
      )}
    </div>
  )
}
